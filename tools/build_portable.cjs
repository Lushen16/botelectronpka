#!/usr/bin/env node
'use strict';

/**
 * Empacota o bot em uma pasta portatil (dist\PKA-Bot).
 *
 *   node tools/build_portable.cjs            # gera dist\PKA-Bot
 *   node tools/build_portable.cjs --zip      # gera tambem o .zip
 *
 * O layout do pacote espelha a raiz do repositorio, porque
 * reconstruction/app/main.cjs resolve tudo a partir de `path.resolve(__dirname,'../..')`:
 *
 *   dist\PKA-Bot\electron\PKA-Bot.exe   runtime electron-v44.7.2 (electron.exe renomeado)
 *   dist\PKA-Bot\reconstruction\app     interface + backend
 *   dist\PKA-Bot\reconstruction\*.cjs   modulos exigidos pelo app
 *   dist\PKA-Bot\tools\                 providers python e atuadores
 *   dist\PKA-Bot\local-data\            perfis
 *   dist\PKA-Bot\PKA-Bot.bat            launcher
 *
 * Python 3.10+ precisa estar no PATH: os provedores de memoria e o atuador
 * Win32 sao scripts .py. Sem python o app abre, mas nao le o jogo.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const distRoot = path.join(root, 'dist');
const out = path.join(distRoot, 'PKA-Bot');
const electronSrc = path.join(root, 'runtime', 'electron-v44.7.2');

const SKIP_PATTERNS = [
  /(^|[\\/])__pycache__([\\/]|$)/,
  /\.pyc$/i,
  /\.bak/i,
  /(^|[\\/])captures?([\\/]|$)/i,
  /\.log$/i,
  /\.png$/i,
  /(^|[\\/])dumps?([\\/]|$)/i,
  /(^|[\\/])fixtures([\\/]|$)/,
];

function skip(file) {
  return SKIP_PATTERNS.some(rx => rx.test(file));
}

function copyTree(from, to, filter) {
  if (!fs.existsSync(from)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (skip(src)) continue;
    if (entry.isDirectory()) {
      if (filter && !filter(src, entry)) continue;
      count += copyTree(src, dst, filter);
    } else if (entry.isFile()) {
      if (filter && !filter(src, entry)) continue;
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Modulos de reconstruction no topo: o app faz require('../nome.cjs').
function reconTopLevel(file) {
  const name = path.basename(file);
  if (name.endsWith('.json')) return false;
  return name.endsWith('.cjs') || name.endsWith('.js') || name.endsWith('.py');
}

function main() {
  if (!fs.existsSync(path.join(electronSrc, 'electron.exe'))) {
    console.error('runtime electron ausente em ' + electronSrc);
    console.error('extraia runtime/electron-v44.7.2-win32-x64.zip antes.');
    process.exit(1);
  }

  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // 1. runtime electron (electron.exe renomeado; sem copia duplicada na raiz)
  const electronOut = path.join(out, 'electron');
  const electronFiles = copyTree(electronSrc, electronOut);
  fs.renameSync(path.join(electronOut, 'electron.exe'), path.join(electronOut, 'PKA-Bot.exe'));
  console.log('[1/5] electron runtime: ' + electronFiles + ' arquivos');

  // 2. reconstruction (app/ + engines/ + modulos .cjs da raiz)
  const reconOut = path.join(out, 'reconstruction');
  fs.mkdirSync(reconOut, { recursive: true });
  let reconFiles = 0;
  const keepDirs = ['app', 'engines'];
  for (const entry of fs.readdirSync(path.join(root, 'reconstruction'), { withFileTypes: true })) {
    const src = path.join(root, 'reconstruction', entry.name);
    if (skip(src) || entry.name === 'spec') continue;
    if (entry.isDirectory()) {
      if (!keepDirs.includes(entry.name)) continue;
      reconFiles += copyTree(src, path.join(reconOut, entry.name));
    } else if (reconTopLevel(src)) {
      fs.copyFileSync(src, path.join(reconOut, entry.name));
      reconFiles++;
    }
  }
  // modulos na raiz do repo (reconstruction/engines/target-engine.cjs faz require ../../target-engine.cjs)
  let rootFiles = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(cjs|js)$/i.test(entry.name)) continue;
    if (entry.name === 'package.json' && rootFiles > 0) continue;
    fs.copyFileSync(path.join(root, entry.name), path.join(out, entry.name));
    rootFiles++;
  }
  console.log('[2/5] reconstruction: ' + reconFiles + ' arquivos (' + rootFiles + ' na raiz)');

  // 3. readable/shared (settings.cjs e outros carregam modelos do original)
  const readableSrc = path.join(root, 'readable');
  let readableFiles = 0;
  if (fs.existsSync(readableSrc)) {
    readableFiles = copyTree(readableSrc, path.join(out, 'readable'));
  }
  console.log('[3/6] readable: ' + readableFiles + ' arquivos');

  // 4. tools
  const toolFiles = copyTree(path.join(root, 'tools'), path.join(out, 'tools'));
  console.log('[4/6] tools: ' + toolFiles + ' arquivos');

  // 4. perfis
  const profileSrc = path.join(root, 'local-data', 'profiles');
  if (fs.existsSync(profileSrc)) {
    copyTree(profileSrc, path.join(out, 'local-data', 'profiles'));
    console.log('[5/6] perfis copiados');
  } else {
    fs.mkdirSync(path.join(out, 'local-data', 'profiles'), { recursive: true });
    console.log('[5/6] sem perfis; pasta criada vazia');
  }

  // 5. launchers
  write(path.join(out, 'PKA-Bot.bat'), [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'if not defined PKA_PLAYER_NAME (',
    '  echo [i] PKA_PLAYER_NAME nao definido; o bot so opera apos configurar.',
    '  set /p PKA_PLAYER_NAME=  Nome do personagem: ',
    ')',
    'set ELECTRON_RUN_AS_NODE=',
    'set ELECTRON_NO_ASAR=',
    '"%~dp0electron\\PKA-Bot.exe" "%~dp0reconstruction\\app" %*',
    'if errorlevel 1 pause',
    'endlocal',
    '',
  ].join('\r\n'));

  write(path.join(out, 'LEIA-ME.txt'), [
    'PKA-Bot - pacote portatil',
    '',
    'Requisitos',
    '  - Windows x64',
    '  - Python 3.10+ no PATH (provedores de memoria e atuador Win32)',
    '  - PokeAlliance_dx.exe aberto, com a janela visivel (nao minimizada)',
    '',
    'Abrir',
    '  1. duplo clique em PKA-Bot.bat',
    '  2. informe o nome do personagem quando pedido (ou defina PKA_PLAYER_NAME)',
    '',
    'O app abre na interface reconstruida. Selecione o processo do jogo e',
    'ative o modulo desejado. Nada e enviado ao jogo sem toggles ativos.',
    '',
    'Dados',
    '  perfis  local-data/profiles/',
    '  logs    local-data/electron/',
    '',
    'Limitacoes conhecidas',
    '  - effectVerified permanece false no modo RPM: aceite do transporte nao',
    '    prova dano, cura ou captura dentro do jogo.',
    '  - O canal nativo (pipe pka-runtime-2-<pid>) exige a DLL do fornecedor',
    '    injetada no cliente. Sem ela, o backend valido e o RPM (leitura de',
    '    memoria + PostMessageW).',
    '  - O atuador exige janela com area de cliente > 0. Janela minimizada',
    '    bloqueia clique/mira (a leitura de memoria continua funcionando).',
    '',
  ].join('\r\n'));

  console.log('[6/6] launchers');

  // launcher nativo (duplo clique, sem console). Compilado com o csc do .NET
  // Framework 4. Ele descobre o nome do jogador (env, janela ou snapshot) e
  // abre o electron sem ELECTRON_RUN_AS_NODE/_NO_ASAR.
  const launcherExe = path.join(out, 'PKA-Bot.exe');
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const launcherSrc = path.join(root, 'tools', 'launcher_pka_bot.cs');
  let launcherNote = 'PKA-Bot.exe (nao compilado; use PKA-Bot.bat)';
  if (fs.existsSync(csc) && fs.existsSync(launcherSrc)) {
    try {
      execFileSync(csc, ['/nologo', '/target:winexe', '/out:' + launcherExe,
        '/r:System.dll', '/r:System.Windows.Forms.dll', launcherSrc], { stdio: 'pipe' });
      launcherNote = 'PKA-Bot.exe (' + Math.round(fs.statSync(launcherExe).size / 1024) + ' KB)';
    } catch (error) {
      console.warn('aviso: falha ao compilar o launcher: ' + error.message);
    }
  } else {
    console.warn('aviso: csc.exe ou launcher_pka_bot.cs ausente');
  }
  console.log('      ' + launcherNote);

  const total = execFileSync('powershell', ['-NoProfile', '-Command',
    "$(Get-ChildItem -Recurse -File '" + out.replace(/'/g, "''") + "' | Measure-Object -Sum Length).Sum"],
    { encoding: 'utf8' }).trim();
  console.log('\nPacote: ' + out);
  console.log('Tamanho: ' + (Number(total) / (1024 * 1024)).toFixed(1) + ' MB');
  console.log('Abrir:   "' + path.join(out, 'PKA-Bot.bat') + '"');

  if (process.argv.includes('--zip')) {
    const zip = path.join(distRoot, 'PKA-Bot.zip');
    fs.rmSync(zip, { force: true });
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Compress-Archive -Path "' + out + '\\*" -DestinationPath "' + zip + '" -Force'],
      { stdio: 'inherit' });
    console.log('ZIP:     ' + zip);
  }
}

main();
