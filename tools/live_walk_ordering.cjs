'use strict';

/**
 * Medicao NO CLIENTE REAL do motor de walker do clone
 * (reconstruction/engines/walker-engine.cjs).
 *
 *   node tools/live_walk_ordering.cjs --pid <PID> [--tiles 2] [--out arquivo]
 *
 * Fases:
 *   1. amostragem passiva (sem comando) — mede cadencia do `tick`, se ele e'
 *      monotonico e o intervalo real entre amostras de posicao;
 *   2. rota curta com o motor do clone dirigindo o canal nativo — registra
 *      cada (tick, posicao, acao) e conta despachos duplicados para a MESMA
 *      posicao, que e' o defeito que a correcao ataca;
 *   3. leitura final e delta.
 *
 * Nao injeta, nao altera config e nao arma combate. Precisa de shell elevado
 * (o pipe do processo do jogo recusa handle nao elevado).
 */

const fs = require('node:fs');
const path = require('node:path');
const { open, channelKey } = require('../reconstruction/native-adapter.cjs');
const { Transport } = require('../reconstruction/transport.cjs');
const { gateReason } = require('../reconstruction/automation.cjs');
const { createWalkerEngine } = require('../reconstruction/engines/walker-engine.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index > 0 ? process.argv[index + 1] : fallback;
};

const pid = Number(arg('pid'));
const tiles = Number(arg('tiles', '2'));
const outFile = path.resolve(arg('out', 'live-walk-ordering.json'));

(async () => {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('--pid obrigatorio.');
  /* 5 s (padrao) nao bastam: o handshake espera a varredura de criaturas e
   * essa leva 1-2 s, ate' 10 s enquanto o vtable de monstro resolve. */
  const transport = new Transport({ pid, key: channelKey(pid),
    commandTimeoutMs: 2000, startupTimeoutMs: 25000 });
  const adapter = await open({ pid }, { transport });
  const evidence = { generatedAt: new Date().toISOString(), pid, tiles,
    phases: {}, samples: [], dispatches: [], problems: [] };

  const telemetryNow = () => {
    const snapshot = adapter.getSnapshot();
    if (!snapshot) return { snapshot: null, reason: 'sem snapshot' };
    return { snapshot, reason: gateReason(snapshot) };
  };

  /* -- fase 0: espera o personagem entrar no mundo -------------------- */
  /* No login a DLL publica posicao sentinela (0,0,0) e `online=false`, entao o
   * gate barra tudo. Esperar aqui evita medir contra o menu. */
  const waitOnlineMs = Number(arg('wait-online', '180')) * 1000;
  const onlineDeadline = Date.now() + waitOnlineMs;
  let onlineReason = 'sem snapshot';
  while (Date.now() < onlineDeadline) {
    const { reason } = telemetryNow();
    onlineReason = reason;
    if (!reason) break;
    await wait(500);
  }
  evidence.phases.wait = { waitedMs: waitOnlineMs, lastReason: onlineReason, ok: !onlineReason };
  if (onlineReason) evidence.problems.push('personagem nao entrou no mundo: ' + onlineReason);

  /* -- fase 1: amostragem passiva ------------------------------------- */
  const ticks = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < 8000) {
    const { snapshot, reason } = telemetryNow();
    if (snapshot && !reason) {
      ticks.push({ at: Date.now(), tick: snapshot.telemetry.tick,
        pos: snapshot.telemetry.position });
    }
    await wait(100);
  }
  const values = ticks.map(entry => entry.tick);
  const backwards = values.filter((value, index) => index > 0 && value < values[index - 1]).length;
  const repeats = values.filter((value, index) => index > 0 && value === values[index - 1]).length;
  const gaps = ticks.slice(1).map((entry, index) => entry.at - ticks[index].at);
  evidence.phases.passive = {
    samples: ticks.length,
    tickValues: [...new Set(values)].slice(0, 40),
    tickBackwards: backwards,
    tickRepeats: repeats,
    sampleGapMs: { min: Math.min(...gaps), max: Math.max(...gaps),
      avg: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null },
    positions: [...new Set(ticks.map(entry => JSON.stringify(entry.pos)))],
  };
  if (backwards > 0) evidence.problems.push('tick andou para tras ' + backwards + ' vez(es)');
  const origin = ticks.at(-1)?.pos;
  if (!origin) { evidence.problems.push('sem telemetria valida na fase passiva'); }
  else {
    /* -- fase 2: rota curta com o motor do clone ---------------------- */
    const waypoint = { x: origin.x + tiles, y: origin.y, z: origin.z };
    const engine = createWalkerEngine({ walker: { loop: false,
      waypoints: [{ action: 'walk', pos: waypoint }] } });
    const dispatched = [];
    const sink = { command: (name, value) => dispatched.push({ at: Date.now(), name, value }) };
    const routeStarted = Date.now();
    const trace = [];
    while (Date.now() - routeStarted < 5000 && !engine.state.finished) {
      const { snapshot, reason } = telemetryNow();
      if (!snapshot || reason) { trace.push({ at: Date.now(), action: 'blocked', reason }); await wait(100); continue; }
      const telemetry = snapshot.telemetry;
      const before = dispatched.length;
      let result;
      try { result = engine.step(telemetry, sink, Date.now()); }
      catch (error) { trace.push({ at: Date.now(), action: 'throw', error: error.message }); break; }
      trace.push({ at: Date.now(), tick: telemetry.tick, pos: telemetry.position,
        action: result.action, reason: result.reason || null,
        reconciled: result.reconciled || null, dispatched: dispatched.length > before });
      if (result.action === 'done' || result.action === 'advance') break;
      await wait(100);
    }
    /* Duplicado = mais de um despacho com a MESMA posicao de origem e sem
     * confirmacao entre eles. */
    const byPosition = new Map();
    for (const entry of trace) {
      if (!entry.dispatched) continue;
      const key = JSON.stringify(entry.pos);
      byPosition.set(key, (byPosition.get(key) || 0) + 1);
    }
    const duplicates = [...byPosition.entries()].filter(([, count]) => count > 1);
    evidence.phases.route = { origin, waypoint, trace, commands: dispatched.length,
      duplicatesFromSameTile: duplicates,
      engineState: engine.state };
    if (duplicates.length) {
      evidence.problems.push('despachou 2+ vezes da mesma posicao: ' + JSON.stringify(duplicates));
    }
    /* -- fase 3: delta final ----------------------------------------- */
    await wait(2000);
    const { snapshot: final, reason: finalReason } = telemetryNow();
    evidence.phases.result = {
      reason: finalReason,
      finalPos: final?.telemetry.position || null,
      delta: final ? { x: final.telemetry.position.x - origin.x,
        y: final.telemetry.position.y - origin.y,
        z: final.telemetry.position.z - origin.z } : null,
      expected: { x: tiles, y: 0, z: 0 },
    };
    const delta = evidence.phases.result.delta;
    if (delta && (delta.z !== 0)) evidence.problems.push('z mudou durante a rota');
  }

  evidence.ok = evidence.problems.length === 0;
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: evidence.ok, problems: evidence.problems,
    passive: evidence.phases.passive?.sampleGapMs, route: evidence.phases.route?.duplicatesFromSameTile,
    result: evidence.phases.result }, null, 2));
  await adapter.close();
  process.exitCode = evidence.ok ? 0 : 1;
})().catch(error => { console.error('falha:', error.message); process.exitCode = 1; });
