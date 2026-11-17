'use strict';

/**
 * Prova o tracer de dispatch (hardware breakpoint) num alvo controlado.
 *
 *   node tools/tap_trace_test.cjs
 *
 * Por que hardware breakpoint e nao inline hook: o alvo real vive dentro do
 * runtime do fornecedor. Escrever bytes la' e' irreversivel na sessao. DR0
 * observa execucao sem alterar um byte de codigo.
 *
 * O que este teste cobre:
 *   - VEH com EXCEPTION_SINGLE_STEP dispara no endereco armado
 *   - DR0/DR7 setados corretamente em thread SUSPENSA
 *   - resume flag evita loop infinito (host continua vivo e progredindo)
 *   - argumentos (rcx/rdx/r8/r9) chegam inteiros no log
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const HOST = path.join(NATIVE, 'bp_host.exe');
const TRACER = path.join(NATIVE, 'pka_dispatch_trace.dll');
const INJECTOR = path.join(NATIVE, 'pka_inject.exe');
const CONFIG = path.join(NATIVE, 'pka_trace_config.txt');

const WATCHED_RVA = '1000';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
};

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function finish() {
  const failed = results.filter(r => !r.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  if (failed.length) process.exitCode = 1;
}

function main() {
  for (const file of [HOST, TRACER, INJECTOR]) {
    if (!fs.existsSync(file)) {
      throw Error('faltando ' + file + '\nrode tools/build_native.cjs e compile pka_dispatch_trace');
    }
  }

  /* alvo tem que ser chamado por call, nao inlinado */
  const pefile = execFileSync('python', ['-c', [
    'import pefile,capstone,sys',
    'img=pefile.PE(sys.argv[1]).get_memory_mapped_image()',
    'md=capstone.Cs(capstone.CS_ARCH_X86,capstone.CS_MODE_64)',
    "n=sum(1 for i in md.disasm(img[0x1000:0x3000],0x1000) if i.mnemonic=='call' and '0x1000' in i.op_str)",
    'print(n)',
  ].join('\n'), HOST], { encoding: 'utf8' }).trim();
  record('alvo nao foi inlinado (tem call)', Number(pefile) > 0, pefile + ' call(s)');

  fs.writeFileSync(CONFIG,
    `module=bp_host.exe\nrva=${WATCHED_RVA}\nmax=500\n`, 'ascii');
  record('config escrito', true, CONFIG);

  /* stdout vai para ARQUIVO, nao para pipe.
   *
   * sleep() usa Atomics.wait, que bloqueia o event loop do Node. Com
   * stdio:'pipe' o handler de 'data' nunca dispara durante o sleep, entao a
   * checagem de progresso lia string vazia. Redirecionar para arquivo resolve
   * sem depender de callback. */
  const hostOut = path.join(NATIVE, `bp_host_${Date.now()}.log`);
  const hostFd = fs.openSync(hostOut, 'w');
  const host = spawn(HOST, ['--seconds', '18'], { stdio: ['ignore', hostFd, hostFd] });
  sleep(1200);
  record('host iniciado', Number.isInteger(host.pid), 'pid=' + host.pid);

  try {
    const output = execFileSync(INJECTOR, ['--pid', String(host.pid), '--dll', TRACER],
      { encoding: 'utf8', timeout: 20000 });
    record('tracer injetado', output.includes('dll carregada'));
  } catch (error) {
    record('tracer injetado', false, error.message.split('\n')[0]);
    host.kill();
    return finish();
  }

  sleep(5000);

  const file = path.join(NATIVE, `pka_dispatch_${host.pid}.jsonl`);
  const stillRunning = host.exitCode === null;
  /* o host so' imprime a cada 50 chamadas (5 s); espera mais um ciclo antes
   * de matar, senao a checagem de progresso falha por timing, nao por travamento */
  sleep(2500);
  const progressed = fs.existsSync(hostOut) &&
    fs.readFileSync(hostOut, 'utf8').includes('chamada 50');
  host.kill();
  try { fs.closeSync(hostFd); } catch { /* ja fechado */ }

  record('host nao travou (resume flag)', stillRunning);

  if (!fs.existsSync(file)) {
    record('arquivo de captura criado', false, 'ausente');
    return finish();
  }
  const size = fs.statSync(file).size;
  record('arquivo de captura criado', size > 0, size + ' bytes');
  if (size === 0) return finish();

  const records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  record('eventos registrados', records.length > 0, records.length + ' eventos');

  /* o main chama PkaWatched(i, 2, 3, 4) em loop: rdx/r8/r9 fixos e rcx crescendo */
  const first = records[0];
  record('rdx capturado', first.rdx === 2, 'rdx=' + first.rdx);
  record('r8 capturado', first.r8 === 3, 'r8=' + first.r8);
  record('r9 capturado', first.r9 === 4, 'r9=' + first.r9);

  const rcxs = records.map(r => r.rcx);
  const increasing = rcxs.every((value, index) => index === 0 || value > rcxs[index - 1]);
  record('rcx cresce (sequencia real)', increasing,
    rcxs.slice(0, 4).join(',') + '...' + rcxs.slice(-2).join(','));

  record('host progrediu (sem congelamento)', progressed, 'chegou a chamada 50');

  finish();
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }


