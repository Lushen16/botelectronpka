'use strict';

/**
 * Mede a CADENCIA OBSERVAVEL de caminhada no cliente real, sem enviar comando
 * nenhum — serve para medir o Shiba andando (ele e' dono do movimento) e
 * tambem para medir o nosso motor depois, trocando `--passive` por uma rota.
 *
 *   node tools/live_walk_cadence.cjs --pid <PID> [--seconds 60] [--out arquivo]
 *
 * POR QUE PASSIVO: enquanto o Shiba dirige o personagem, mandar `walk` pelo
 * canal nativo brigaria com ele. A leitura do canal e' so' de estado.
 *
 * O que ele mede, por amostra de posicao:
 *   - intervalo entre MUDANCAS de tile (min/mediana/p90/max) -> a cadencia;
 *   - quantas mudancas foram de 1 tile e quantas pularam 2+ (passo perdido);
 *   - quantas vezes voltou para o tile anterior (indecisao/contorno);
 *   - quanto tempo ficou parado no mesmo tile (travada);
 *   - monotonicidade do `tick` (o contador tem que ser crescente).
 *
 * Precisa de shell elevado: o pipe do processo do jogo recusa handle nao
 * elevado.
 */

const fs = require('node:fs');
const path = require('node:path');
const { open, channelKey } = require('../reconstruction/native-adapter.cjs');
const { Transport } = require('../reconstruction/transport.cjs');
const { gateReason } = require('../reconstruction/automation.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const tileKey = position => `${position.x},${position.y},${position.z}`;

const pid = Number(arg('pid'));
const seconds = Number(arg('seconds', '60'));
const outFile = path.resolve(arg('out', 'live-walk-cadence.json'));

(async () => {
  if (!Number.isInteger(pid) || pid <= 0) throw Error('--pid obrigatorio.');
  const transport = new Transport({ pid, key: channelKey(pid),
    commandTimeoutMs: 2000, startupTimeoutMs: 25000 });
  const adapter = await open({ pid }, { transport });
  const evidence = { generatedAt: new Date().toISOString(), pid, seconds,
    phases: {}, steps: [], problems: [] };

  const sample = () => {
    const snapshot = adapter.getSnapshot();
    if (!snapshot) return { snapshot: null, reason: 'sem snapshot' };
    return { snapshot, reason: gateReason(snapshot) };
  };

  /* -- fase 0: esperar o personagem entrar no mundo -------------------- */
  const waitOnlineMs = Number(arg('wait-online', '300')) * 1000;
  const deadline = Date.now() + waitOnlineMs;
  let lastReason = 'sem snapshot';
  while (Date.now() < deadline) {
    const { reason } = sample();
    lastReason = reason;
    if (!reason) break;
    await wait(500);
  }
  evidence.phases.wait = { waitedMs: waitOnlineMs, lastReason, ok: !lastReason };
  if (lastReason) {
    evidence.problems.push('personagem nao entrou no mundo: ' + lastReason);
    fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ ok: false, problems: evidence.problems }, null, 2));
    await adapter.close();
    process.exitCode = 1;
    return;
  }

  /* -- fase 1: amostragem passiva ------------------------------------- */
  /* 60 ms: mais fino que a taxa de estado do cliente (~62 ms), entao nenhuma
   * mudanca de tile entre duas leituras passa despercebida. */
  const startedAt = Date.now();
  let previous = null;
  let tickBackwards = 0;
  let tickRepeats = 0;
  const samples = [];
  while (Date.now() - startedAt < seconds * 1000) {
    const { snapshot, reason } = sample();
    if (snapshot && !reason) {
      const telemetry = snapshot.telemetry;
      const at = Date.now();
      const key = tileKey(telemetry.position);
      if (previous) {
        if (Number.isInteger(telemetry.tick) && Number.isInteger(previous.tick)) {
          if (telemetry.tick < previous.tick) tickBackwards += 1;
          if (telemetry.tick === previous.tick) tickRepeats += 1;
        }
        if (key !== previous.key) {
          const [px, py] = [previous.position.x, previous.position.y];
          const jump = Math.abs(telemetry.position.x - px) + Math.abs(telemetry.position.y - py);
          evidence.steps.push({ at, sinceMs: at - previous.changedAt, jump,
            zChanged: telemetry.position.z !== previous.position.z,
            back: previous.keyBefore !== undefined && key === previous.keyBefore,
            from: previous.key, to: key });
          previous.keyBefore = previous.key;
          previous.changedAt = at;
        }
      }
      previous = { ...(previous || {}), key, changedAt: previous?.changedAt ?? at,
        position: { ...telemetry.position }, tick: telemetry.tick };
      samples.push(at);
    }
    await wait(60);
  }

  const intervals = evidence.steps.map(step => step.sinceMs);
  const heldStill = samples.length ? samples.at(-1) - (evidence.steps.at(-1)?.at ?? samples[0]) : 0;
  evidence.phases.passive = {
    durationMs: Date.now() - startedAt,
    samples: samples.length,
    distinctTiles: new Set(evidence.steps.map(step => step.to)).size + 1,
    tileChanges: evidence.steps.length,
    stepsPerSecond: samples.length
      ? Number((evidence.steps.length / ((Date.now() - startedAt) / 1000)).toFixed(2)) : 0,
    intervalMs: { min: intervals.length ? Math.min(...intervals) : null,
      median: median(intervals), p90: percentile(intervals, 0.9),
      max: intervals.length ? Math.max(...intervals) : null },
    jumpHistogram: evidence.steps.reduce((histogram, step) => {
      histogram[step.jump] = (histogram[step.jump] || 0) + 1;
      return histogram;
    }, {}),
    floorChanges: evidence.steps.filter(step => step.zChanged).length,
    returns: evidence.steps.filter(step => step.back).length,
    longestStillMs: heldStill,
    tickBackwards,
    tickRepeats,
  };
  if (tickBackwards) evidence.problems.push('tick andou para tras ' + tickBackwards + ' vez(es)');
  if (evidence.steps.length && evidence.phases.passive.returns > evidence.steps.length * 0.3) {
    evidence.problems.push('voltou ao tile anterior em mais de 30% dos passos (indecisao)');
  }
  const jumps = Object.keys(evidence.phases.passive.jumpHistogram).map(Number);
  if (jumps.some(jump => jump >= 2)) {
    evidence.problems.push('salto de 2+ tiles: passo perdido entre leituras — '
      + JSON.stringify(evidence.phases.passive.jumpHistogram));
  }

  evidence.ok = evidence.problems.length === 0;
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ok: evidence.ok, problems: evidence.problems,
    passive: evidence.phases.passive }, null, 2));
  await adapter.close();
  process.exitCode = evidence.ok ? 0 : 1;
})().catch(error => { console.error('falha:', error.message); process.exitCode = 1; });
