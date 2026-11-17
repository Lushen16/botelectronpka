'use strict';

/**
 * Analisa o padrao do kind 11 (automation_control) numa captura do tap.
 *
 *   node tools/kind11_pattern.cjs [arquivo]
 *
 * Responde com dado, nao com suposicao:
 *   - todos os kind 11 com op/module/seq/tamanho
 *   - quando a telemetria (kind 5) existe antes e depois de cada kind 11
 *   - o maior intervalo sem telemetria, e o que aconteceu em volta
 *   - correlacao: kind 11 antecede queda de telemetria?
 *
 * Lê em streaming: arquivos de centenas de MB nao cabem como string.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');

function latestTap() {
  const dir = path.join(ROOT, 'native');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(name => /^pka_tap_\d+\.jsonl$/.test(name))
    .map(name => path.join(dir, name))
    .filter(file => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

async function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : latestTap();
  if (!file || !fs.existsSync(file)) {
    console.log('nenhuma captura encontrada');
    return;
  }
  const sizeMb = (fs.statSync(file).size / 1048576).toFixed(0);
  console.log('arquivo: ' + file + ' (' + sizeMb + ' MB)\n');

  const counts = new Map();
  const telemetryTimes = [];
  const control = [];
  const leases = [];
  let first = null;
  let last = null;
  let lines = 0;
  let bad = 0;

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line) continue;
    lines++;
    let record;
    try { record = JSON.parse(line); } catch { bad++; continue; }

    const kind = record.kind;
    counts.set(kind, (counts.get(kind) || 0) + 1);
    if (first === null) first = record.t;
    last = record.t;

    if (kind === 5) {
      telemetryTimes.push(record.t);
    } else if (kind === 11 && record.d) {
      let payload = null;
      try { payload = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8')); }
      catch { /* truncado */ }
      control.push({
        t: record.t, dir: record.dir, n: record.n,
        op: payload?.op, module: payload?.module, seq: payload?.seq,
        boot: payload?.boot, client: payload?.client,
      });
    } else if (kind === 12 && record.d) {
      try {
        const payload = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8'));
        leases.push({ t: record.t, seq: payload.counter });
      } catch { /* truncado */ }
    }
  }

  console.log('linhas: ' + lines + (bad ? ` (${bad} ilegiveis)` : ''));
  console.log('janela: t=' + first + ' .. ' + last
    + '  (' + ((last - first) / 1000).toFixed(0) + ' s)');
  console.log('');
  console.log('frames por kind:');
  for (const [kind, frames] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(kind).padStart(3)}  ${String(frames).padStart(7)}`);
  }

  /* ---------------------------------------------- kind 11 */
  console.log('\n=== kind 11 (automation_control) ===');
  if (!control.length) {
    console.log('  nenhum');
  } else {
    console.log('  total: ' + control.length);
    console.log('  dir  : ' + [...new Set(control.map(c => c.dir))].join(', '));
    for (const item of control) {
      console.log(`  t=${item.t}  dir=${item.dir}  n=${item.n}`
        + `  op=${item.op}  module=${item.module}  seq=${item.seq}`);
      console.log(`      boot=${item.boot}  client=${item.client}`);
    }
  }

  /* ---------------------------------------------- telemetria */
  console.log('\n=== telemetria (kind 5) ===');
  if (!telemetryTimes.length) {
    console.log('  nenhuma');
  } else {
    console.log('  frames: ' + telemetryTimes.length);
    console.log('  primeiro: t=' + telemetryTimes[0]);
    console.log('  ultimo  : t=' + telemetryTimes[telemetryTimes.length - 1]);
    const gaps = [];
    for (let i = 1; i < telemetryTimes.length; i++) {
      gaps.push({ ms: telemetryTimes[i] - telemetryTimes[i - 1],
        from: telemetryTimes[i - 1], to: telemetryTimes[i] });
    }
    gaps.sort((a, b) => b.ms - a.ms);
    console.log('  maiores intervalos sem telemetria:');
    for (const gap of gaps.slice(0, 8)) {
      const who = control.filter(c => c.t >= gap.from && c.t <= gap.to);
      const tag = who.length
        ? who.map(c => `kind11 op=${c.op} module=${c.module}`).join(' + ')
        : '—';
      console.log(`    ${(gap.ms / 1000).toFixed(1)}s  t=${gap.from}..${gap.to}  ${tag}`);
    }
  }

  /* ---------------------------------------------- correlacao */
  console.log('\n=== correlacao kind 11 → telemetria ===');
  if (!control.length || !telemetryTimes.length) {
    console.log('  dados insuficientes');
  } else {
    for (const item of control) {
      const before = telemetryTimes.filter(t => t < item.t);
      const after = telemetryTimes.filter(t => t > item.t);
      const gapBefore = before.length ? item.t - before[before.length - 1] : null;
      const gapAfter = after.length ? after[0] - item.t : null;
      console.log(`  kind11 t=${item.t} op=${item.op} module=${item.module}`);
      console.log(`    telemetria anterior: ${gapBefore === null ? 'nenhuma' : (gapBefore / 1000).toFixed(1) + 's antes'}`);
      console.log(`    telemetria seguinte: ${gapAfter === null ? 'NENHUMA depois' : (gapAfter / 1000).toFixed(1) + 's depois'}`);
    }
  }

  /* ---------------------------------------------- lease */
  if (leases.length) {
    console.log('\n=== kind 12 (lease) ===');
    const deltas = [];
    for (let i = 1; i < leases.length; i++) deltas.push(leases[i].t - leases[i - 1].t);
    deltas.sort((a, b) => a - b);
    const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;
    console.log('  frames: ' + leases.length);
    console.log('  primeiro: t=' + leases[0].t + '  ultimo: t=' + leases[leases.length - 1].t);
    console.log('  intervalo mediano: ' + median + ' ms');
    console.log('  contador: ' + leases[0].seq + ' .. ' + leases[leases.length - 1].seq);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
