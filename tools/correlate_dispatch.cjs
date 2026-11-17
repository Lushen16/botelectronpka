'use strict';

/**
 * Correlaciona o dispatch (alvos raros) com o estado do jogo (kind 6).
 *
 * A ideia: o ataque acontece quando core.phase muda para "combat" ou quando
 * luring.count sobe. Se um alvo aparece concentrado nesses momentos e nao em
 * "idle", ele é o candidato a ataque.
 *
 *   node tools/correlate_dispatch.cjs [rare.jsonl] [tap.jsonl]
 */

const fs = require('node:fs');
const path = require('node:path');
const { tailLines } = require('./tail_jsonl.cjs');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');

const EXE_BASE_RE = /exe/i;

function latest(prefix) {
  const files = fs.readdirSync(NATIVE)
    .filter(name => name.startsWith(prefix) && name.endsWith('.jsonl'))
    .map(name => path.join(NATIVE, name))
    .filter(file => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function loadDispatch(file) {
  const records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  return records;
}

/** Lê kind 6 do fim do tap (arquivo gigante). */
function loadStates(tapFile, count = 4000) {
  const states = [];
  const lines = tailLines(tapFile, count);
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.kind !== 6 || record.trunc || !record.d) continue;
    try {
      const data = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8'));
      states.push({ t: record.t, core: data.core?.phase, lure: data.luring?.phase,
        lureCount: data.luring?.count, modules: data.modules });
    } catch { /* ignore */ }
  }
  return states;
}

function main() {
  const dispatchFile = process.argv[2] || latest('pka_rare_') || latest('pka_target_');
  const tapFile = process.argv[3] || latest('pka_tap_');
  if (!dispatchFile) {
    console.log('nenhuma captura de dispatch');
    return;
  }
  console.log('dispatch: ' + dispatchFile);
  console.log('tap     : ' + (tapFile || '(ausente)'));

  const events = loadDispatch(dispatchFile);
  console.log('eventos : ' + events.length);
  if (!events.length) return;

  /* base do exe: deduzir do maior endereço observado que caia na faixa do exe.
   * Como não temos a base aqui, agrupamos pelo endereço absoluto. */
  const groups = new Map();
  for (const event of events) {
    const key = event.target;
    if (!groups.has(key)) groups.set(key, { count: 0, times: [] });
    const group = groups.get(key);
    group.count++;
    group.times.push(event.t);
  }

  const states = tapFile ? loadStates(tapFile) : [];
  console.log('estados : ' + states.length);
  if (!states.length) {
    console.log('\nsem kind 6 para correlacionar; mostrando só a frequência.');
    for (const [target, group] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  0x${target.toString(16)}  ${group.count}x`);
    }
    return;
  }

  /* para cada alvo, qual era o estado do jogo no momento mais próximo? */
  const stateAt = time => {
    let best = null;
    let bestDelta = Infinity;
    for (const state of states) {
      const delta = Math.abs(state.t - time);
      if (delta < bestDelta) { bestDelta = delta; best = state; }
    }
    return bestDelta <= 1500 ? best : null;
  };

  console.log('\n=== alvo × estado do jogo ===');
  const rows = [];
  for (const [target, group] of groups.entries()) {
    const tally = { combat: 0, idle: 0, unknown: 0 };
    const lures = new Map();
    let countSum = 0;
    let countN = 0;
    for (const time of group.times) {
      const state = stateAt(time);
      if (!state) { tally.unknown++; continue; }
      tally[state.core === 'combat' ? 'combat' : 'idle']++;
      if (state.lure) lures.set(state.lure, (lures.get(state.lure) || 0) + 1);
      if (Number.isFinite(state.lureCount)) { countSum += state.lureCount; countN++; }
    }
    rows.push({ target, count: group.count, tally,
      lures: [...lures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      avgLure: countN ? (countSum / countN).toFixed(1) : '-' });
  }

  rows.sort((a, b) => b.tally.combat - a.tally.combat || b.count - a.count);
  for (const row of rows) {
    const share = row.count ? ((row.tally.combat / row.count) * 100).toFixed(0) : '0';
    console.log(`  0x${row.target.toString(16)}  ${String(row.count).padStart(4)}x  `
      + `combat=${row.tally.combat} (${share}%) idle=${row.tally.idle} `
      + `unknown=${row.tally.unknown} avgLure=${row.avgLure}`);
    if (row.lures.length) {
      console.log(`        lures: ${row.lures.map(([k, v]) => `${k}=${v}`).join(' ')}`);
    }
  }

  console.log('\n=== leitura ===');
  const attackCandidates = rows.filter(row => row.count >= 5
    && row.tally.combat > row.tally.idle);
  if (attackCandidates.length) {
    console.log('candidatos a ataque (maioria das chamadas em combat):');
    for (const row of attackCandidates) {
      console.log(`  0x${row.target.toString(16)}  ${row.count}x  ${row.tally.combat} em combat`);
    }
  } else {
    console.log('nenhum alvo concentrado em combat com amostra suficiente.');
    console.log('rode o tracer por mais tempo com o bot atacando.');
  }
}

main();
