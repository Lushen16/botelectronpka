'use strict';

/**
 * Prova que o tap funciona quando o alvo importa ReadFile/WriteFile de um
 * API SET (api-ms-win-core-file-l1-1-0.dll) em vez de kernel32.dll.
 *
 * Este e o caso do payload do fornecedor. O tap antigo comparava o nome da DLL
 * contra "kernel32.dll", nunca casava, e a captura saia com 0 bytes.
 *
 *   node tools/tap_apiset_test.cjs
 *
 * Usa: native/apiset_target.exe (alvo), native/pka_tap.dll (espiao),
 *      native/pka_inject.exe (injetor). Nada de botfinal/ nem reconstruction/.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const decoder = require('./tap_decode.cjs');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const TARGET = path.join(NATIVE, 'apiset_target.exe');
const INJECTOR = path.join(NATIVE, 'pka_inject.exe');

/**
 * A DLL a testar. Se native\pka_tap.dll estiver travada por um jogo aberto, o
 * build escreve pka_tap_new.dll em vez de falhar. Escolhemos a mais NOVA para
 * nao testar uma versao velha por acidente (ja aconteceu: 0 bytes e um FAIL
 * que nao era do codigo).
 */
function pickTap() {
  const candidates = [path.join(NATIVE, 'pka_tap.dll'), path.join(NATIVE, 'pka_tap_new.dll')]
    .filter(file => fs.existsSync(file))
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file || null;
}

const TAP = pickTap();

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
};

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function importsOf(file) {
  const output = execFileSync('python', ['-c',
    'import pefile,sys;pe=pefile.PE(sys.argv[1]);'
    + 'print("\\n".join(e.dll.decode()+" "+i.name.decode() '
    + 'for e in pe.DIRECTORY_ENTRY_IMPORT for i in e.imports '
    + 'if i.name and i.name.decode() in ("ReadFile","WriteFile")))',
    file], { encoding: 'utf8' });
  return output.trim().split(/\r?\n/).filter(Boolean);
}

function tapFile(pid) {
  for (const dir of [NATIVE, os.tmpdir()]) {
    const candidate = path.join(dir, `pka_tap_${pid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  for (const file of [TARGET, TAP, INJECTOR]) {
    if (!fs.existsSync(file)) {
      throw Error('faltando ' + file + '\nrode: node tools/build_native.cjs --only tap');
    }
  }

  /* 1. confirma que o alvo realmente usa o api-set */
  const imports = importsOf(TARGET);
  const apiSet = imports.filter(line => line.includes('api-ms-win-core-file'));
  record('alvo importa ReadFile/WriteFile de api-set',
    apiSet.length >= 1, imports.join(' | ') || '(nenhum)');

  /* 2. sobe o alvo em loop de trafego */
  delete process.env.PKA_TAP_OUT;
  const target = spawn(TARGET, ['--seconds', '12'], { stdio: 'ignore' });
  sleep(1000);
  record('alvo iniciado', Number.isInteger(target.pid), 'pid=' + target.pid);

  /* 3. injeta o tap DEPOIS do alvo estar escrevendo */
  try {
    const output = execFileSync(INJECTOR, ['--pid', String(target.pid), '--dll', TAP],
      { encoding: 'utf8', timeout: 20000 });
    record('tap injetado', output.includes('dll carregada'), output.trim().split('\n').pop());
  } catch (error) {
    record('tap injetado', false, error.message.split('\n')[0]);
    target.kill();
    return finish();
  }

  /* 4. espera trafego acontecer depois do hook */
  sleep(3000);

  const file = tapFile(target.pid);
  target.kill();
  sleep(300);

  if (!file) {
    record('arquivo de captura criado', false, 'pka_tap_' + target.pid + '.jsonl ausente');
    return finish();
  }
  const size = fs.statSync(file).size;
  record('arquivo de captura criado', size > 0, size + ' bytes');
  if (size === 0) return finish();

  const records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  record('registros gravados', records.length > 0, records.length + ' registros');

  const frames = decoder.framesByDirection(records);
  record('frames s2c (servidor->cliente) capturados', frames.s2c.length > 0,
    frames.s2c.length + ' frames');
  record('frames c2s (cliente->servidor) capturados', frames.c2s.length > 0,
    frames.c2s.length + ' frames');

  const kinds = new Set([...frames.s2c, ...frames.c2s].map(f => f.kind));
  record('header do frame decodificado', kinds.size > 0,
    'kinds=' + [...kinds].join(','));

  finish();
}

function finish() {
  const failed = results.filter(r => !r.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  if (failed.length) process.exitCode = 1;
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
