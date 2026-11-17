'use strict';

/**
 * Prova do injetor num alvo CONTROLADO (nao e o jogo).
 *
 * Abre um processo de teste (por padrao, `notepad.exe`), injeta a pka_native.dll
 * com pka_inject.exe, e verifica que:
 *   - o injetor aceita o PID e reporta a base do modulo
 *   - a DLL aparece na lista de modulos do alvo
 *   - a DLL cria o pipe pka-runtime-2-<pid do alvo>
 *
 * A chave precisa estar acessivel para o alvo: o teste grava
 * native/pka_channel_key.txt (a DLL procura ao lado dela).
 *
 *   node tools/native_inject_test.cjs                 # notepad
 *   node tools/native_inject_test.cjs --name calc.exe
 *
 * Nao injeta em PokeAlliance_dx.exe. Para isso use:
 *   native\pka_inject.exe --name PokeAlliance_dx.exe native\pka_native.dll
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const INJECT = path.join(root, 'native', 'pka_inject.exe');
const DLL = path.join(root, 'native', 'pka_native.dll');
const KEYFILE = path.join(root, 'native', 'pka_channel_key.txt');
const KEY = process.env.PKA_CHANNEL_KEY || '0123456789abcdef0123456789abcdef';

const nameArg = process.argv.indexOf('--name');
const TARGET = nameArg >= 0 ? process.argv[nameArg + 1] : null;

// Alvo padrao: processo proprio, longevo, mesma arquitetura e mesmo usuario.
// notepad.exe no Win11 delega para outra instancia e sai, o que quebra o teste.
const DEFAULT_ARGS = ['/c', 'ping -n 120 127.0.0.1 > nul'];

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' :: ' + detail : ''));
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function pipes() {
  try { return fs.readdirSync('\\\\.\\pipe\\').filter(n => n.includes('pka-runtime-2-')); }
  catch { return []; }
}

function modules(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Modules | Select-Object -ExpandProperty ModuleName`],
      { encoding: 'utf8' });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

async function main() {
  for (const file of [INJECT, DLL]) {
    if (!fs.existsSync(file)) {
      console.error('faltando ' + file + ' - rode node tools/build_native.cjs');
      process.exit(2);
    }
  }

  fs.writeFileSync(KEYFILE, KEY + '\n');
  console.log('alvo: ' + (TARGET || 'cmd.exe (proprio)'));

  const child = TARGET
    ? spawn(TARGET, [], { detached: true, stdio: 'ignore' })
    : spawn('cmd.exe', DEFAULT_ARGS, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  await wait(1800);

  const pid = child.pid;
  check('alvo iniciado', Boolean(pid) && child.exitCode === null, 'pid=' + pid);
  if (!pid || child.exitCode !== null) process.exit(1);

  const before = pipes().length;
  const inject = spawnSync(INJECT, ['--pid', String(pid), '--dll', DLL], { encoding: 'utf8', timeout: 20000 });
  const stdout = (inject.stdout || '').trim();
  const stderr = (inject.stderr || '').trim();
  check('injetor executou', inject.status === 0, (stdout || stderr).replace(/\r?\n/g, ' | '));

  await wait(2000);
  const mods = modules(pid);
  check('dll carregada no alvo', mods.some(m => /pka_native/i.test(m)),
    mods.filter(m => /pka/i.test(m)).join(',') || 'nao listada');

  const after = pipes();
  check('pipe criado pela dll', after.length > before,
    after.length ? after.join(', ') : 'nenhum pka-runtime-2-*');

  const expected = 'pka-runtime-2-' + pid;
  check('pipe corresponde ao pid do alvo', after.includes(expected), expected);

  // handshake real contra a DLL injetada: o cliente do botfinal autentica nela
  if (after.includes(expected)) {
    const { createTransport } = require('../botfinal/core/pipe-transport.cjs');
    const transport = createTransport('native', { pid, key: KEY,
      startupTimeoutMs: 5000, commandTimeoutMs: 3000 });
    let state = null;
    let telemetry = null;
    transport.on('state', v => { state = v; });
    transport.on('telemetry', v => { telemetry = v; });
    try {
      await transport.connect();
      check('handshake contra a dll injetada', transport.authenticated === true);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !(state && telemetry)) await wait(50);
      check('state/telemetry vindos da dll injetada', Boolean(state && telemetry),
        state ? 'hp=' + state.healthPercent + ' tick=' + telemetry?.tick : 'ausente');
      const ack = await transport.sendCommand('walk', 1);
      check('comando aceito pela dll injetada', ack?.commandId > 0, 'status=' + ack?.status);
    } catch (error) {
      check('handshake contra a dll injetada', false, error.message);
    } finally {
      try { await transport.close(); } catch { /* ignore */ }
    }
  }

  try { process.kill(pid); } catch { /* ignore */ }
  await wait(400);
  const lingering = pipes().filter(p => p === expected);
  check('pipe removido ao encerrar o alvo', lingering.length === 0);

  try { fs.rmSync(KEYFILE, { force: true }); } catch { /* ignore */ }

  const failed = results.filter(r => !r.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => { console.error('FATAL', error.stack || error.message); process.exit(2); });
