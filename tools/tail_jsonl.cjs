'use strict';

/**
 * Lê o FINAL de um jsonl gigante sem carregar tudo na memória.
 *
 * O tap do jogo passou de 880 MB e `readFileSync` estoura o limite de string do
 * Node (0x1fffffe8 chars). Este utilitário lê por blocos a partir do fim e
 * devolve só as últimas N linhas completas.
 *
 *   node tools/tail_jsonl.cjs <arquivo> [linhas]
 */

const fs = require('node:fs');

function tailLines(file, count = 200, chunkSize = 256 * 1024) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    let position = size;
    let buffer = '';
    let lines = [];

    while (position > 0 && lines.length <= count) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, position);
      buffer = chunk.toString('utf8') + buffer;
      lines = buffer.split(/\r?\n/);
      /* a primeira linha pode estar cortada; descarta se ainda há arquivo antes */
      if (position > 0) lines.shift();
    }
    return lines.filter(Boolean).slice(-count);
  } finally {
    fs.closeSync(fd);
  }
}

function lastKind6(file, count = 400) {
  /* lê mais linhas porque kind 6 é ~1 a cada 6 frames */
  for (const limit of [count, count * 8, count * 40]) {
    const lines = tailLines(file, limit);
    const records = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.kind === 6 && !record.trunc && record.d) records.push(record);
      } catch { /* linha cortada */ }
    }
    if (records.length) return { records, scanned: lines.length };
  }
  return { records: [], scanned: 0 };
}

function main() {
  const file = process.argv[2];
  const count = Number(process.argv[3] || 200);
  if (!file) {
    console.log('uso: node tools/tail_jsonl.cjs <arquivo> [linhas]');
    return;
  }
  if (!fs.existsSync(file)) {
    console.log('arquivo ausente: ' + file);
    return;
  }
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log(`arquivo: ${file} (${mb} MB)`);

  const { records, scanned } = lastKind6(file, count);
  console.log(`linhas varridas: ${scanned} | kind6 válidos: ${records.length}`);
  if (!records.length) return;

  const last = JSON.parse(Buffer.from(records[records.length - 1].d, 'hex').toString('utf8'));
  console.log('\n=== último kind 6 ===');
  console.log('modules    :', JSON.stringify(last.modules));
  console.log('core       :', JSON.stringify(last.core));
  console.log('phase      :', JSON.stringify(last.phase));
  console.log('luring     :', JSON.stringify({ mode: last.luring?.mode, phase: last.luring?.phase, count: last.luring?.count, min: last.luring?.minCount }));
  console.log('walkerIndex:', last.walkerIndex);
  console.log('paused     :', last.paused);
}

if (require.main === module) main();
module.exports = { tailLines, lastKind6 };
