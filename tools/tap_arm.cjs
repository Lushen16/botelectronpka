'use strict';

/**
 * Vigia de sessao: fica armado esperando o jogo (e depois o menu) aparecerem
 * e injeta o tap em cada um. Feito para o fluxo de duas etapas do fornecedor:
 *
 *   node tools/tap_arm.cjs --minutes 20
 *   (abre o launcher, clica ENTRAR, usa o bot)
 *
 * Etapas:
 *   1. espera PokeAlliance_dx.exe -> injeta pka_tap.dll
 *   2. espera o menu Electron com --client-pid=<pid do jogo> -> injeta de novo
 *   3. continua vigiando por reinjecao do jogo (troca de PID)
 *
 * Nao depende de botfinal/ nem reconstruction/. Escreve progresso em
 * captures/tap-arm.log e o arquivo do tap em native/pka_tap_<pid>.jsonl.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const CAPTURES = path.join(ROOT, 'captures');
const INJECTOR = path.join(NATIVE, 'pka_inject.exe');
const LOG = path.join(CAPTURES, 'tap-arm.log');
const GAME = 'PokeAlliance_dx.exe';

/** A DLL mais nova: build pode cair para pka_tap_new.dll se a original estiver
 *  travada por um jogo aberto. */
function pickTap() {
  const candidates = [path.join(NATIVE, 'pka_tap.dll'), path.join(NATIVE, 'pka_tap_new.dll')]
    .filter(file => fs.existsSync(file))
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file || path.join(NATIVE, 'pka_tap.dll');
}

const TAP_DLL = pickTap();

const injected = new Set();

function log(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  const text = `[${stamp}] ${line}`;
  console.log(text);
  try { fs.appendFileSync(LOG, text + '\n'); } catch { /* ignore */ }
}

function ps(command) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', command],
      { encoding: 'utf8', timeout: 15000 }).trim();
  } catch { return ''; }
}

function findGamePid() {
  const out = ps(`Get-Process ${GAME.replace('.exe', '')} -ErrorAction SilentlyContinue | ` +
    'Select-Object -First 1 -ExpandProperty Id');
  const pid = Number(out);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function findMenuPid(gamePid) {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='electron.exe' or Name like '%.tmp'" | ` +
    `Where-Object { $_.CommandLine -match '--client-pid=${gamePid}' } | ` +
    'Select-Object -First 1 -ExpandProperty ProcessId');
  const pid = Number(out);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** O jogo ja tem o tap carregado? (reinjetar no mesmo PID carrega de novo e
 *  duas copias da DLL hooks brigam pelo mesmo handle).
 *  Sem `$_` no PowerShell: ele e comido pelo escaping quando a string atravessa
 *  node -> powershell -Command. */
function alreadyTapped(pid) {
  const out = ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Modules.ModuleName -match 'pka_tap'`);
  return out.trim().length > 0;
}

function inject(pid, label) {
  if (injected.has(pid)) return true;
  if (alreadyTapped(pid)) {
    injected.add(pid);
    const file = tapFile(pid);
    log(`${label} pid=${pid} ja tinha o tap, nao reinjeta` + (file ? ` (${file})` : ''));
    return true;
  }
  try {
    const output = execFileSync(INJECTOR, ['--pid', String(pid), '--dll', TAP_DLL],
      { encoding: 'utf8', timeout: 30000 });
    injected.add(pid);
    log(`${label} pid=${pid} -> ${output.trim().split('\n').pop()}`);
    const file = tapFile(pid);
    if (file) log(`  captura: ${file}`);
    return true;
  } catch (error) {
    const message = (error.stderr || error.message || '').toString().trim().split('\n')[0];
    log(`${label} pid=${pid} FALHOU: ${message}`);
    return false;
  }
}

function tapFile(pid) {
  for (const dir of [NATIVE, os.tmpdir()]) {
    const candidate = path.join(dir, `pka_tap_${pid}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  let minutes = 20;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--minutes') minutes = Number(argv[++i]);
  }

  for (const file of [TAP_DLL, INJECTOR]) {
    if (!fs.existsSync(file)) {
      console.error('faltando ' + file + '\nrode: node tools\\build_native.cjs --only tap');
      process.exit(1);
    }
  }
  fs.mkdirSync(CAPTURES, { recursive: true });

  log('armado por ' + minutes + ' min. esperando ' + GAME + '...');
  log('agora abra o launcher e clique em ENTRAR.');

  const deadline = Date.now() + minutes * 60 * 1000;
  let gamePid = null;
  let menuDone = false;

  while (Date.now() < deadline) {
    const current = findGamePid();
    if (current && current !== gamePid) {
      gamePid = current;
      menuDone = false;
      log(`jogo detectado pid=${gamePid}`);
      inject(gamePid, 'jogo');
    }

    if (gamePid && !menuDone) {
      const menuPid = findMenuPid(gamePid);
      if (menuPid) {
        inject(menuPid, 'menu');
        menuDone = true;
        log('sessao completa: jogo + menu tapados. use o bot normalmente.');
      }
    }

    Sleep(700);
  }

  log('tempo esgotado.');
  const files = [...injected].map(tapFile).filter(Boolean);
  if (!files.length) {
    log('nenhuma captura gerada.');
    return;
  }
  log('capturas:');
  for (const file of files) {
    log(`  ${file} (${fs.statSync(file).size} bytes)`);
  }
  log('proximo: node tools\\tap_session.cjs --report');
}

/** Sleep sincrono sem busy loop. */
function Sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

main();

// vigia de sessao: injeta no jogo e no menu, reinjeta em troca de PID
