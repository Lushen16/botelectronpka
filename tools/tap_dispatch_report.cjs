'use strict';

/**
 * Analisa a captura do tracer de dispatch e diz qual índice é o ataque.
 *
 *   node tools/tap_dispatch_report.cjs [arquivo]
 *
 * O tracer registra cada entrada no trampolim com os registradores. O que
 * interessa: durante um ataque real, muda (rcx, r8, type, offset). Agrupar por
 * essas chaves revela o vocabulário do dispatch.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');

function latest() {
  if (!fs.existsSync(NATIVE)) return null;
  const files = fs.readdirSync(NATIVE)
    .filter(name => /^pka_dispatch_\d+\.jsonl$/.test(name))
    .map(name => path.join(NATIVE, name))
    .filter(file => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function main() {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : latest();
  if (!input) {
    console.log('nenhuma captura de dispatch. rode o tracer primeiro:');
    console.log('  native\\pka_inject.exe --name PokeAlliance_dx.exe --dll native\\pka_dispatch_trace.dll');
    return;
  }

  const lines = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean);
  const records = lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

  console.log('arquivo : ' + input);
  console.log('eventos : ' + records.length);
  if (!records.length) return;

  const duration = (records[records.length - 1].t - records[0].t) / 1000;
  console.log('duração : ' + duration.toFixed(1) + ' s');
  console.log('threads : ' + [...new Set(records.map(r => r.tid))].join(', '));

  /* agrupa por assinatura de dispatch */
  const groups = new Map();
  for (const record of records) {
    const key = `type=${record.type} offset=0x${record.offset.toString(16)}`;
    if (!groups.has(key)) {
      groups.set(key, { count: 0, samples: [], r8: new Set(), rcx: [] });
    }
    const group = groups.get(key);
    group.count++;
    if (group.samples.length < 3) group.samples.push(record);
    if (Number.isFinite(record.r8)) group.r8.add(record.r8);
    group.rcx.push(record.rcx);
  }

  console.log('\n=== dispatch por (type, offset) ===');
  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [key, group] of sorted) {
    console.log(`\n  ${key}   ${group.count} chamadas`);
    console.log(`    r8 distintos: ${group.r8.size <= 8
      ? [...group.r8].join(', ')
      : group.r8.size + ' valores'}`);
    const first = group.samples[0];
    console.log(`    exemplo: rcx=${first.rcx} rdx=${first.rdx} r8=${first.r8} r9=${first.r9}`);
  }

  console.log('\n=== o que procurar no jogo ===');
  console.log('  - offset != 0 significa que o dispatcher executou algo');
  console.log('  - o grupo com r8 variando (id de criatura) é o de attack');
  console.log('  - compare antes/depois de atacar um monstro');
}

main();
