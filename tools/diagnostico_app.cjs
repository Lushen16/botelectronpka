'use strict';

/**
 * Diagnostico de ambiente para abrir a interface.
 *
 *   node tools/diagnostico_app.cjs
 *
 * Existe porque a GUI falhava com 0x80000003 sem dizer o motivo, e o agente
 * que abria recebia apenas "Electron encerrou antes de mostrar a janela".
 * Este script responde as tres perguntas que decidem o resultado, sem abrir
 * janela nenhuma: variavel de ambiente, arquivos e sessao do Windows.
 *
 * Nao altera nada. Sai 0 quando o ambiente parece capaz de abrir a GUI,
 * 1 quando ha um bloqueio conhecido.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const problemas = [];
const avisos = [];

function linha(ok, titulo, detalhe) {
  const marca = ok === true ? 'OK  ' : ok === false ? 'FALHA' : 'AVISO';
  console.log(`${marca}  ${titulo.padEnd(28)} ${detalhe}`);
}

/* ─── 1. ELECTRON_RUN_AS_NODE ───
 * Com essa variavel o electron.exe roda como Node puro: nao abre janela e
 * morre com "Cannot find module 'electron'". O .bat limpa, mas quem chama o
 * exe direto (ou herda de T3 Code / Codex / VS Code) nao. */
const runAsNode = process.env.ELECTRON_RUN_AS_NODE;
if (runAsNode && runAsNode !== '') {
  linha(false, 'ELECTRON_RUN_AS_NODE', `= "${runAsNode}" — use o .bat, ou limpe a variavel`);
  problemas.push('ELECTRON_RUN_AS_NODE definido: o electron.exe vira Node puro e nao abre janela.');
} else {
  linha(true, 'ELECTRON_RUN_AS_NODE', 'vazio');
}

/* ─── 2. arquivos ─── */
const electron = path.join(root, 'runtime', 'electron-v44.7.2', 'electron.exe');
const mainCjs = path.join(root, 'reconstruction', 'app', 'main.cjs');
const pkg = path.join(root, 'reconstruction', 'app', 'package.json');

if (fs.existsSync(electron)) {
  const mb = (fs.statSync(electron).size / 1048576).toFixed(0);
  linha(true, 'runtime do Electron', `${mb} MB`);
} else {
  linha(false, 'runtime do Electron', 'ausente — o projeto esta incompleto');
  problemas.push('runtime/electron-v44.7.2/electron.exe ausente.');
}

linha(fs.existsSync(mainCjs), 'reconstruction/app/main.cjs', fs.existsSync(mainCjs) ? 'presente' : 'ausente');
if (!fs.existsSync(mainCjs)) problemas.push('reconstruction/app/main.cjs ausente.');

if (fs.existsSync(pkg)) {
  try {
    const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    linha(j.main ? true : false, 'package.json (main)', j.main || 'campo "main" ausente');
    if (!j.main) problemas.push('reconstruction/app/package.json sem "main".');
  } catch (e) {
    linha(false, 'package.json (main)', 'JSON invalido: ' + e.message);
    problemas.push('package.json do app invalido.');
  }
} else {
  linha(false, 'package.json (main)', 'ausente');
  problemas.push('reconstruction/app/package.json ausente.');
}

/* ─── 3. sessao do Windows ───
 * Sessao 0 e' servico: sem desktop, sem janela. Chromium aborta com
 * 0x80000003. Sessoes interativas comecam em 1. */
let minhaSessao = null;
try {
  minhaSessao = execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    '(Get-Process -Id $PID).SessionId',
  ], { encoding: 'utf8', windowsHide: true }).trim();
} catch { /* sem powershell: segue sem essa checagem */ }

if (minhaSessao !== null) {
  const n = Number(minhaSessao);
  if (n === 0) {
    linha(false, 'sessao do Windows', `${minhaSessao} (servico, sem desktop) — a janela NAO abre`);
    problemas.push('Processo na sessao 0: nao ha desktop para a janela aparecer.');
  } else {
    linha(true, 'sessao do Windows', `${minhaSessao} (interativa)`);
  }
}

let temDesktop = false;
try {
  const out = execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    '@(Get-Process explorer -ErrorAction SilentlyContinue).Count',
  ], { encoding: 'utf8', windowsHide: true }).trim();
  temDesktop = Number(out) > 0;
  linha(temDesktop, 'explorer.exe (desktop)', temDesktop ? 'rodando' : 'ausente');
  if (!temDesktop) avisos.push('explorer.exe nao esta rodando: pode nao haver area de trabalho.');
} catch { /* ignora */ }

/* ─── 4. perfil do Electron ─── */
const perfil = path.join(root, 'local-data', 'electron');
if (fs.existsSync(perfil)) {
  let bytes = 0;
  try {
    const pilha = [perfil];
    while (pilha.length) {
      const d = pilha.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) pilha.push(p);
        else { try { bytes += fs.statSync(p).size; } catch {} }
      }
    }
  } catch {}
  linha(true, 'perfil (local-data/electron)', `${(bytes / 1048576).toFixed(1)} MB`);
  if (bytes > 200 * 1048576) {
    avisos.push('Perfil grande (>200 MB): se a GUI falhar, use ABRIR_RECONSTRUCAO_LIMPAR.bat.');
  }
} else {
  linha(null, 'perfil (local-data/electron)', 'ainda nao criado (normal na 1a execucao)');
}

/* ─── 5. processos Electron orfaos ───
 * Um Electron zumbi pode segurar o perfil. Nao matamos nada: so' avisamos. */
let orfaos = 0;
try {
  const out = execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${root.replace(/\\/g, '\\\\')}') }).Count`,
  ], { encoding: 'utf8', windowsHide: true }).trim();
  orfaos = Number(out) || 0;
} catch {}
if (orfaos > 0) {
  linha(null, 'Electron desta pasta', `${orfaos} processo(s) ativo(s)`);
  avisos.push(`${orfaos} Electron desta pasta ainda rodando; podem segurar o perfil.`);
} else {
  linha(true, 'Electron desta pasta', 'nenhum');
}

/* ─── resumo ─── */
console.log('');
if (problemas.length) {
  console.log('BLOQUEIOS:');
  for (const p of problemas) console.log('  - ' + p);
  console.log('');
  console.log('Como resolver:');
  if (problemas.some(p => p.includes('ELECTRON_RUN_AS_NODE'))) {
    console.log('  set ELECTRON_RUN_AS_NODE=');
    console.log('  ABRIR_RECONSTRUCAO.bat');
  }
  if (problemas.some(p => p.includes('sessao 0'))) {
    console.log('  Rode numa sessao com area de trabalho (nao servico/SSH).');
  }
  if (problemas.some(p => p.includes('ausente'))) {
    console.log('  O projeto esta incompleto: falta runtime ou app.');
  }
  process.exit(1);
}

if (avisos.length) {
  console.log('AVISOS:');
  for (const a of avisos) console.log('  - ' + a);
  console.log('');
}

console.log('Ambiente OK para abrir a interface.');
console.log('  ABRIR_RECONSTRUCAO.bat');
console.log('');
console.log('Para validar SEM janela (funciona em servico/CI):');
console.log('  node tools/smoke_app.cjs');
console.log('  node tools/ui_audit.cjs');
process.exit(0);
