'use strict';

/**
 * Gera `captures/channel-key-<pid>.json` a partir de `native/pka_channel_key.txt`.
 *
 *   node tools/rota/gerar_chave.cjs --pid 16260
 *
 * WHY: a DLL le a chave de `native/pka_channel_key.txt` (32 bytes), mas o
 * transporte em Node le de `captures/channel-key-<pid>.json`. Os scripts
 * antigos copiavam a mao — e depois de cada reinicio do jogo o pid muda e o
 * arquivo nao existe, o que produz `ENOENT \\.\pipe\pka-runtime-2-<pid>` que
 * parece "DLL nao injetada" mas e' so' chave faltando.
 */

const fs = require('node:fs');
const path = require('node:path');

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const ROOT = path.resolve(__dirname, '..', '..');
const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }

const src = path.join(ROOT, 'native', 'pka_channel_key.txt');
if (!fs.existsSync(src)) {
  console.error('sem ' + src);
  console.error('a DLL escreve esse arquivo ao iniciar; injete primeiro:');
  console.error('  native\\pka_inject.exe --pid ' + pid + ' --dll native\\pka_native.dll');
  process.exit(2);
}

const key = fs.readFileSync(src, 'utf8').trim();
if (!/^[0-9a-f]{32}$/iu.test(key)) {
  console.error('chave invalida em ' + src + ' (esperado 32 hex, veio ' + key.length + ' chars)');
  process.exit(2);
}

const out = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const doc = {
  capturedAt: new Date().toISOString(),
  pid,
  key,
  source: 'native-file',
};
fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n');
console.log('escrito ' + out);
console.log('  key: ' + key.slice(0, 6) + '...' + key.slice(-4) + ' (' + key.length + ' chars)');
