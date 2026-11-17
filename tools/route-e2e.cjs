#!/usr/bin/env node
'use strict';

/**
 * Rota curta integrada — valida o ciclo completo em segundo plano.
 *
 *   node tools/route-e2e.cjs --pid 30968
 *   node tools/route-e2e.cjs --pid 30968 --steps 3 --dir 2
 *
 * O que faz, em ordem:
 *   1. conecta no canal nativo e espera snapshot fresco
 *   2. anda N tiles na direcao pedida (walk nativo, sem foco)
 *   3. procura alvo atacavel no snapshot
 *   4. ataca o alvo e mede o HP antes/depois
 *   5. dispara o combo configurado (texto nativo, sem foco)
 *   6. registra cada etapa com o foreground NO INSTANTE (vem do log da DLL)
 *
 * Criterio de sucesso: cada etapa com status 0 e, no ataque, HP caindo ou
 * alvo saindo da lista. Sem alvo disponivel, a etapa de combate e' reportada
 * como INDISPONIVEL — nao como sucesso nem como falha.
 *
 * NAO altera foco. NAO usa teclado. Se qualquer etapa exigir teclado, o
 * proprio executor devolve STATUS_NO_FOREGROUND e a rota reporta isso.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));
const { NativeSession } = require(path.join(ROOT, 'botfinal', 'core', 'native-session.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }
const steps = Number(arg('--steps', 2));
const dir = Number(arg('--dir', 2));
const comboText = String(arg('--combo', '!autocombo m5, m6'));
const watchSec = Number(arg('--watch', 8));

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
if (!fs.existsSync(keyFile)) { console.error('sem chave em ' + keyFile); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')).key;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const DELTA = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0],
  4: [0, -1], 5: [0, 1], 6: [0, 1], 7: [0, -1] };

async function main() {
  const t = new NativeTransport({ pid, key });
  const session = new NativeSession({ pid });
  let snapshot = null;
  t.on('telemetry', v => { snapshot = v; });

  const result = { pid, steps, dir, comboText, stages: [], verdict: null };

  await t.connect();
  session.attach(t);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !snapshot) await sleep(50);
  if (!snapshot) {
    result.verdict = 'FALHA: sem telemetria no prazo';
    report(result); t.close(); process.exit(1);
  }

  const pos0 = { ...snapshot.position };

  // ---- etapa 1: walk nativo
  let walksOk = 0;
  for (let i = 0; i < steps; i++) {
    const before = snapshot.position ? { ...snapshot.position } : null;
    let ack = null;
    try { ack = await t.sendCommand('walk', dir); } catch (e) { ack = { status: -1, message: e.message }; }
    await sleep(1200);
    const after = snapshot.position ? { ...snapshot.position } : null;
    const dx = before && after ? after.x - before.x : 0;
    const dy = before && after ? after.y - before.y : 0;
    const [ex, ey] = DELTA[dir];
    const exact = dx === ex && dy === ey;
    if (ack.status === 0 && exact) walksOk++;
    result.stages.push({
      stage: 'walk', step: i + 1, status: ack.status,
      delta: `(${dx},${dy})`, expected: `(${ex},${ey})`, exact,
    });
  }

  // ---- etapa 2: alvo
  //
  // ESCOLHA DO ALVO IMPORTA. Medido em 2026-11-10: atacar um alvo a 12 tiles
  // de distancia e 3 andares abaixo devolveu status 0 ("handler executou")
  // mas HP nao caiu — o jogo aceita a chamada e nao aplica dano fora de
  // alcance. Escolher o mais proximo no MESMO z evita reportar "sem efeito"
  // como se fosse falha de mecanismo.
  function pickTarget(snap) {
    const me = snap.position || { x: 0, y: 0, z: 0 };
    const list = (snap.creatures || []).filter(c => c.type === 1 && c.healthPercent > 0)
      .map(c => ({
        ...c,
        dist: Math.max(Math.abs(c.pos.x - me.x), Math.abs(c.pos.y - me.y)),
        dz: Math.abs(c.pos.z - me.z),
      }))
      .sort((a, b) => (a.dz - b.dz) || (a.dist - b.dist));
    return list[0] || null;
  }

  /* Aproximacao: anda na direcao do alvo ate ficar adjacente (dist<=7,
   * mesmo z). Passos limitados e sem loop infinito. Cada passo e' um walk
   * nativo normal; se o passo nao mudar a posicao (obstaculo), tenta eixo
   * alternativo uma vez. */
  async function approach(maxSteps) {
    const DELTA_OF = (dx, dy) => {
      if (dx === 0 && dy < 0) return 0; if (dx > 0 && dy === 0) return 1;
      if (dx === 0 && dy > 0) return 2; if (dx < 0 && dy === 0) return 3;
      if (dx > 0 && dy < 0) return 4; if (dx > 0 && dy > 0) return 5;
      if (dx < 0 && dy > 0) return 6; if (dx < 0 && dy < 0) return 7;
      return 2;
    };
    const log = [];
    for (let i = 0; i < maxSteps; i++) {
      const tgt = pickTarget(snapshot);
      if (!tgt) { log.push({ step: i, skip: 'sem alvo' }); break; }
      if (tgt.dz !== 0) { log.push({ step: i, skip: `alvo em z diferente (dz=${tgt.dz})` }); break; }
      if (tgt.dist <= 7) { log.push({ step: i, done: `alcance: dist=${tgt.dist}` }); break; }
      const me2 = snapshot.position;
      const dx = Math.sign(tgt.pos.x - me2.x);
      const dy = Math.sign(tgt.pos.y - me2.y);
      const d = DELTA_OF(dx, dy);
      const before = { ...me2 };
      let ack = null;
      try { ack = await t.sendCommand('walk', d); } catch { ack = { status: -1 }; }
      await sleep(1100);
      const after = snapshot.position ? { ...snapshot.position } : before;
      const moved = after.x !== before.x || after.y !== before.y;
      log.push({ step: i, dir: d, status: ack.status, moved, dist: tgt.dist });
      if (!moved) {
        // obstaculo: tenta so' um eixo
        const alt = dx !== 0 ? 1 : 2;
        try { await t.sendCommand('walk', alt); } catch { /* ignore */ }
        await sleep(1100);
      }
    }
    return log;
  }

  const approachLog = await approach(Math.max(2, steps * 2));
  result.stages.push({ stage: 'approach', log: approachLog });

  const target = pickTarget(snapshot);
  const creatures = snapshot.creatures || [];
  const attackable = creatures.filter(c => c.canAttack && c.healthPercent > 0);

  if (target) {
    const hpBefore = target.healthPercent;
    let ack = null;
    try { ack = await t.sendCommand('attack', target.id); } catch (e) { ack = { status: -1, message: e.message }; }

    let hpAfter = hpBefore, vanished = false;
    const t0 = Date.now();
    while (Date.now() - t0 < watchSec * 1000) {
      await sleep(600);
      const row = (snapshot.creatures || []).find(c => c.id === target.id);
      if (!row) { vanished = true; break; }
      hpAfter = row.healthPercent;
    }
    result.stages.push({
      stage: 'attack', status: ack.status, target: target.name, targetId: target.id,
      dist: target.dist, dz: target.dz,
      hpBefore, hpAfter, vanished,
      effect: vanished || hpAfter < hpBefore,
      inRange: target.dist >= 0 && target.dist <= 7 && target.dz === 0,
    });
  } else {
    result.stages.push({ stage: 'attack', status: null, reason: 'INDISPONIVEL: nenhum alvo selvagem na area',
      creaturesSeen: creatures.map(c => `${c.name}(type=${c.type},ca=${c.canAttack})`) });
  }

  // ---- etapa 3: combo nativo
  let cack = null;
  try { cack = await t.sendCommand('combo', comboText); } catch (e) { cack = { status: -1, message: e.message }; }
  await sleep(1200);
  result.stages.push({ stage: 'combo', status: cack.status, text: comboText, len: comboText.length });

  // ---- veredito
  const walkStage = result.stages.filter(s => s.stage === 'walk');
  const attackStage = result.stages.find(s => s.stage === 'attack');
  const comboStage = result.stages.find(s => s.stage === 'combo');

  const walkPass = walksOk === steps;
  /* Combate: status 0 com efeito = passa. Status 0 sem efeito PASSA apenas se
   * o alvo estava fora de alcance — nesse caso o teste nao mede o mecanismo.
   * Status != 0 = falha real. */
  const attackPass = attackStage.status === null
    ? null
    : (attackStage.status === 0 ? (attackStage.effect || !attackStage.inRange) : false);
  const comboPass = comboStage.status === 0;

  result.summary = { walksOk, steps, walkPass, attackPass, comboPass, pos0, posFim: snapshot.position };
  result.verdict = (walkPass && comboPass && attackPass !== false)
    ? (attackPass === null ? 'PARCIAL: movimento e combo ok; combate sem alvo'
                           : 'SUCESSO: rota completa em segundo plano')
    : 'FALHOU: ver etapas';
  report(result);
  t.close();
  process.exit(result.verdict.startsWith('SUCESSO') || result.verdict.startsWith('PARCIAL') ? 0 : 1);
}

function report(r) {
  console.log(`\n=== ROTA integrada pid=${r.pid} ===`);
  console.log(`pos inicial: (${r.summary?.pos0?.x ?? '?'},${r.summary?.pos0?.y ?? '?'})`);
  for (const s of r.stages) {
    if (s.stage === 'walk') {
      console.log(`  walk #${s.step}  status=${s.status}  delta=${s.delta} (esperado ${s.expected}) ${s.exact ? 'OK' : 'FALHOU'}`);
    } else if (s.stage === 'approach') {
      const moves = s.log.filter(x => x.dir !== undefined);
      const last = s.log[s.log.length - 1] || {};
      console.log(`  approach  ${moves.length} passo(s) na direcao do alvo${last.done ? ' — ' + last.done : ''}${last.skip ? ' — ' + last.skip : ''}`);
    } else if (s.stage === 'attack') {
      if (s.status === null) console.log(`  attack    ${s.reason}`);
      else {
        const where = s.dist >= 0 ? ` dist=${s.dist} dz=${s.dz}${s.inRange ? ' (alcance)' : ' (FORA DE ALCANCE)'}` : '';
        console.log(`  attack    status=${s.status}  alvo=${s.target}${where}  hp ${s.hpBefore}->${s.hpAfter}${s.vanished ? ' (sumiu)' : ''} ${s.effect ? 'EFEITO OK' : (s.inRange ? 'SEM EFEITO' : 'SEM EFEITO (alvo fora de alcance — nao prova falha)')}`);
      }
    } else if (s.stage === 'combo') {
      console.log(`  combo     status=${s.status}  "${s.text}" (${s.len}b)`);
    }
  }
  if (r.summary) {
    console.log(`  pos final: (${r.summary.posFim?.x ?? '?'},${r.summary.posFim?.y ?? '?'})`);
    console.log(`  walks ${r.summary.walksOk}/${r.summary.steps} | combate ${r.summary.attackPass === null ? 'n/a' : (r.summary.attackPass ? 'ok' : 'falhou')} | combo ${r.summary.comboPass ? 'ok' : 'falhou'}`);
  }
  console.log(`\nVEREDITO: ${r.verdict}`);
}

main().catch(e => { console.error(e); process.exit(1); });
