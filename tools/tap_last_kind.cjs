'use strict';

/**
 * Procura o último registro de um kind varrendo o arquivo em blocos, de trás
 * para frente, por bytes — sem parsear linha por linha (lento em 1 GB).
 *
 *   node tools/tap_last_kind.cjs <arquivo> <kind>
 */

const fs = require('node:fs');

const file = process.argv[2];
const wanted = process.argv[3] || '5';
if (!file) {
  console.log('uso: node tools/tap_last_kind.cjs <arquivo> <kind>');
  process.exit(0);
}

const needle = Buffer.from(`"kind":${wanted},`, 'utf8');
const fd = fs.openSync(file, 'r');
const size = fs.fstatSync(fd).size;
const chunkSize = 4 * 1024 * 1024;

let position = size;
let carry = Buffer.alloc(0);
let found = null;

while (position > 0 && !found) {
  const readSize = Math.min(chunkSize, position);
  position -= readSize;
  const chunk = Buffer.alloc(readSize);
  fs.readSync(fd, chunk, 0, readSize, position);
  const buffer = carry.length ? Buffer.concat([chunk, carry]) : chunk;
  const index = buffer.lastIndexOf(needle);
  if (index >= 0) {
    /* reconstruir a linha completa em volta do match */
    const lineStart = buffer.lastIndexOf(0x0a, index) + 1;
    let lineEnd = buffer.indexOf(0x0a, index);
    if (lineEnd < 0) lineEnd = buffer.length;
    const line = buffer.subarray(lineStart, lineEnd).toString('utf8');
    try {
      found = JSON.parse(line);
    } catch {
      /* linha partida entre blocos: guarda o começo para a próxima volta */
    }
    if (!found) {
      const absolute = position + lineStart;
      /* reler essa linha inteira a partir do arquivo */
      const relen = Math.min(64 * 1024, size - absolute);
      const single = Buffer.alloc(relen);
      fs.readSync(fd, single, 0, relen, absolute);
      const end = single.indexOf(0x0a);
      const text = single.subarray(0, end < 0 ? relen : end).toString('utf8');
      try { found = JSON.parse(text); } catch { /* desiste desta janela */ }
    }
  }
  /* mantém os primeiros 64 KB como carry para casar linha partida */
  carry = buffer.subarray(0, Math.min(64 * 1024, buffer.length));
}

fs.closeSync(fd);

if (!found) {
  console.log(`nenhum kind ${wanted} encontrado em ${(size / 1048576).toFixed(0)} MB`);
  process.exit(0);
}

console.log(`último kind ${wanted} no arquivo:`);
console.log('  t   =', found.t);
console.log('  n   =', found.n);
console.log('  len =', found.d ? found.d.length / 2 : 0, 'bytes');
console.log('  trunc =', found.trunc);
if (wanted === '5' && found.d) {
  try {
    const data = JSON.parse(Buffer.from(found.d, 'hex').toString('utf8'));
    console.log('  player   =', JSON.stringify(data.playerName));
    console.log('  position =', JSON.stringify(data.position));
    console.log('  creatures=', Array.isArray(data.creatures) ? data.creatures.length : '?');
  } catch {
    console.log('  (payload não é JSON válido — truncado)');
  }
}
