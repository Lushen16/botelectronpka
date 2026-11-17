'use strict';

/**
 * Distribuição de frames por kind numa janela do fim de um jsonl gigante.
 *
 *   node tools/tap_kinds.cjs [arquivo] [linhas]
 */

const fs = require('node:fs');
const path = require('node:path');
const { tailLines } = require('./tail_jsonl.cjs');

const ROOT = path.resolve(__dirname, '..');

function main() {
  const file = process.argv[2] || (() => {
    const dir = path.join(ROOT, 'native');
    const files = fs.readdirSync(dir)
      .filter(name => /^pka_tap_\d+\.jsonl$/.test(name))
      .map(name => path.join(dir, name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0];
  })();
  const count = Number(process.argv[3] || 4000);

  const lines = tailLines(file, count);
  const kinds = new Map();
  const firstT = new Map();
  const lastT = new Map();
  let unparsed = 0;

  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { unparsed++; continue; }
    const kind = record.kind ?? 'chunk';
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
    if (!firstT.has(kind)) firstT.set(kind, record.t);
    lastT.set(kind, record.t);
  }

  console.log('arquivo: ' + file);
  console.log('linhas : ' + lines.length + (unparsed ? ` (${unparsed} ilegiveis)` : ''));
  console.log('');
  console.log('kind  frames   primeiro      ultimo       intervalo');
  for (const [kind, frames] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    const a = firstT.get(kind);
    const b = lastT.get(kind);
    const span = Number.isFinite(a) && Number.isFinite(b) ? ((b - a) / 1000).toFixed(1) + 's' : '-';
    console.log(`  ${String(kind).padStart(3)}  ${String(frames).padStart(6)}   ${String(a).padStart(11)}  ${String(b).padStart(11)}   ${span}`);
  }
}

main();
