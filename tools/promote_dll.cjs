'use strict';

/**
 * Promove a DLL corrigida, com verificacoes que recusam em vez de forcar.
 *
 *   node tools/promote_dll.cjs            # recusa se o cliente estiver aberto
 *   node tools/promote_dll.cjs --check    # so' relata, nao altera nada
 *
 * Regras:
 *   - NAO desinjeta, NAO encerra processo, NAO carrega segunda versao.
 *   - Se PokeAlliance_dx.exe estiver rodando, ABORTA (arquivo travado seria
 *     copia parcial, e "forcar" nao faz parte do contrato).
 *   - Verifica por CONTEUDO que a origem nao tem simbolos de foco/teclado
 *     global antes de copiar.
 *   - Guarda o hash de origem, destino anterior e destino final.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'pka_native_new.dll');
const DST = path.join(ROOT, 'native', 'pka_native.dll');
const BACKUP = path.join(ROOT, 'native', 'pka_native_prev.dll');
const OUT_DIR = path.join(ROOT, 'local-data');

/* Simbolos que a DLL corrigida NAO pode conter. */
const FORBIDDEN = [
  'SetForegroundWindow', 'AttachThreadInput', 'ShowWindow', 'ShowWindowAsync',
  'BringWindowToTop', 'SetActiveWindow', 'SetFocus', 'SwitchToThisWindow',
  'SetWindowPos', 'SendInput', 'keybd_event',
];

const checkOnly = process.argv.includes('--check');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function gameProcesses() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-Process PokeAlliance_dx -ErrorAction SilentlyContinue | ' +
      'ForEach-Object { "$($_.Id)|$($_.MainWindowTitle)|$($_.StartTime.ToString(\'o\'))" }'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!out) return [];
    return out.split(/\r?\n/u).map(line => {
      const [pid, title, started] = line.split('|');
      return { pid: Number(pid), title, started };
    });
  } catch {
    return [];
  }
}

function forbiddenSymbols(file) {
  const buf = fs.readFileSync(file);
  return FORBIDDEN.filter(name => buf.includes(Buffer.from(name, 'ascii'))
    || buf.includes(Buffer.from(name, 'utf16le')));
}

function report(data) {
  console.log(JSON.stringify(data, null, 2));
  return data;
}

function main() {
  const state = {
    at: new Date().toISOString(),
    source: SRC,
    destination: DST,
    checkOnly,
    processes: gameProcesses(),
  };

  if (!fs.existsSync(SRC)) {
    report({ ...state, ok: false, error: 'origem ausente: ' + SRC });
    return 1;
  }

  state.sourceSha256 = sha256(SRC);
  state.sourceBytes = fs.statSync(SRC).size;
  state.sourceForbidden = forbiddenSymbols(SRC);

  if (state.sourceForbidden.length) {
    report({ ...state, ok: false,
      error: 'a origem contem simbolos proibidos: ' + state.sourceForbidden.join(', ') });
    return 1;
  }

  if (fs.existsSync(DST)) {
    state.destinationExists = true;
    state.destinationSha256Before = sha256(DST);
  } else {
    state.destinationExists = false;
  }

  if (state.processes.length) {
    report({ ...state, ok: false,
      error: 'cliente aberto; feche antes de promover. Nada foi alterado.',
      hint: 'processos: ' + state.processes.map(p => p.pid + ' "' + p.title + '"').join(', ') });
    return 2;
  }

  if (checkOnly) {
    report({ ...state, ok: true, action: 'check: nada alterado',
      wouldCopy: state.destinationSha256Before !== state.sourceSha256 });
    return 0;
  }

  /* Backup do destino anterior, se existir e for diferente. */
  if (state.destinationExists && state.destinationSha256Before !== state.sourceSha256) {
    fs.copyFileSync(DST, BACKUP);
    state.backup = BACKUP;
    state.backupSha256 = sha256(BACKUP);
  }

  fs.copyFileSync(SRC, DST);
  state.destinationSha256After = sha256(DST);
  state.destinationForbiddenAfter = forbiddenSymbols(DST);
  state.ok = state.destinationSha256After === state.sourceSha256
    && state.destinationForbiddenAfter.length === 0;
  state.verified = {
    copyMatchesSource: state.destinationSha256After === state.sourceSha256,
    noForbiddenSymbols: state.destinationForbiddenAfter.length === 0,
  };

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR,
      'dll-promotion-' + state.at.replace(/[:.]/gu, '-') + '.json');
    fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
    state.evidence = file;
  } catch { /* relatorio no stdout ja basta */ }

  report(state);
  return state.ok ? 0 : 1;
}

process.exit(main());
