#!/usr/bin/env node
'use strict';

/**
 * Ciclo automatizado: mata a DLL antiga reiniciando o processo, espera o
 * mundo, injeta a nova, roda o teste. Para onde o login for necessário.
 *
 * O QUE ELE FAZ SOZINHO
 *   1. fecha o PokeAlliance_dx (TerminateProcess na própria exe, não no launcher)
 *   2. abre de novo pelo PokeAlliance_dx.exe direto (pula o launcher)
 *   3. espera o LocalPlayer aparecer (personagem no mundo)
 *   4. injeta a DLL mais nova
 *   5. roda o teste que você pedir
 *
 * O QUE ELE NÃO FAZ
 *   login. Se o cliente abrir em tela de login, ele para e avisa. Não existe
 *   credencial em disco e eu não vou inventar uma.
 *
 * Uso:
 *   node tools/game-loop.cjs --test probe
 *   node tools/game-loop.cjs --test attack --fire
 *   node tools/game-loop.cjs --no-restart --test probe
 *   node tools/game-loop.cjs --wait-world        só espera o mundo
 *
 * Footgun: ele MATА o jogo (TerminateProcess). É o ponto do script — sem
 * reiniciar, a DLL antiga fica mapeada e não dá para trocar. Salve o que
 * importa antes.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GAME_DIR = 'C:\\Users\\yago\\AppData\\Local\\PokeAlliance Games\\PokeAlliance';
const EXE = path.join(GAME_DIR, 'PokeAlliance_dx.exe');
const IMAGE = 'PokeAlliance_dx.exe';
const MODULE = 'pokealliance_dx.exe';
const nativeDir = path.join(ROOT, 'native');

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const has = f => process.argv.includes(f);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function findPid() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Name 'PokeAlliance_dx' -ErrorAction SilentlyContinue | Select-Object -First 1).Id`],
      { encoding: 'utf8' }).trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function loadedPka(pid) {
  const script = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class ML {
  [DllImport("kernel32.dll")] public static extern IntPtr CreateToolhelp32Snapshot(uint f,uint p);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool Module32FirstW(IntPtr s,ref ME e);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool Module32NextW(IntPtr s,ref ME e);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  public struct ME {
    public uint dwSize,th32ModuleID,th32ProcessID,GlblcntUsage,ProccntUsage;
    public IntPtr modBaseAddr; public uint modBaseSize; public IntPtr hModule;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string szModule;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string szExePath;
  }
}
"@
$s=[ML]::CreateToolhelp32Snapshot(0x8,${pid})
$e=New-Object ML+ME
$e.dwSize=[Runtime.InteropServices.Marshal]::SizeOf($e)
if([ML]::Module32FirstW($s,[ref]$e)){
  do { if($e.szModule -like 'pka*'){ "$($e.szModule)" } } while([ML]::Module32NextW($s,[ref]$e))
}
[ML]::CloseHandle($s) | Out-Null
`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

async function waitWorld(pid, timeoutMs = 300000) {
  /* Personagem no mundo = lp_state.py imprime "pos=(" na primeira linha.
   * Reusa o leitor que ja foi validado contra o cliente, em vez de
   * reimplementar RPM em PowerShell (o cast UInt64->IntPtr falha la').
   *
   * IMPORTANTE: o global [0x39cb958] pode estar NULL com o objeto vivo
   * (transicao de mapa). lp_state cai no fallback por vtable e imprime a
   * linha normalmente — mas manda "[fallback] ..." em stderr. Por isso
   * capturamos stdout E stderr e testamos so' "pos=(" no stdout. */
  const script = path.join(ROOT, 'tools', 'lp_state.py');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const p = findPid();
    if (!p) { process.stdout.write('.'); await sleep(2000); continue; }
    try {
      const out = execFileSync('python', [script, '--pid', String(p)],
        { encoding: 'utf8', timeout: 60000 });
      /* a primeira linha com posicao e' a que importa */
      const line = out.split(/\r?\n/).find(l => /pos=\(/.test(l));
      if (line) {
        process.stdout.write('\n');
        return { pid: p, info: line.trim() };
      }
      process.stdout.write('.');
    } catch (e) {
      /* execFileSync joga se o exit code != 0; mas lp_state sai 0 quando
       * acha. stderr com [fallback] nao e' erro. */
      const out = (e.stdout || '');
      const line = out.split(/\r?\n/).find(l => /pos=\(/.test(l));
      if (line) {
        process.stdout.write('\n');
        return { pid: p, info: line.trim() };
      }
      process.stdout.write('x');
    }
    await sleep(3000);
  }
  process.stdout.write('\n');
  return null;
}

function build() {
  console.log('--- build');
  try {
    const out = execFileSync('node', ['tools/build_native.cjs', '--only', 'bot'],
      { cwd: ROOT, encoding: 'utf8' });
    const line = out.split(/\r?\n/).find(l => /pka_native.*\.dll/.test(l));
    console.log(line || '(sem saida)');
    return true;
  } catch (e) {
    console.error((e.stdout || '') + (e.stderr || ''));
    return false;
  }
}

function newestDll() {
  return ['pka_native.dll', 'pka_native_new.dll']
    .map(f => path.join(nativeDir, f))
    .filter(f => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function main() {
  const noRestart = has('--no-restart');

  let pid = findPid();
  if (pid && !noRestart) {
    const mods = loadedPka(pid);
    console.log(`jogo pid=${pid}${mods.length ? ', com ' + mods.join(', ') : ''}`);
    console.log('--- fechando para permitir troca de DLL');
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Stop-Process -Id ${pid} -Force`], { encoding: 'utf8' });
    } catch (e) { console.error('falha ao fechar: ' + e.message); }
    for (let i = 0; i < 20 && findPid(); i++) await sleep(500);
    pid = findPid();
    if (pid) { console.error('processo resistiu ao Stop-Process'); return 1; }
    console.log('fechado');
  }

  if (!findPid()) {
    console.log('--- abrindo ' + EXE);
    if (!fs.existsSync(EXE)) { console.error('exe ausente: ' + EXE); return 1; }
    const child = spawn(EXE, [], { cwd: GAME_DIR, detached: true, stdio: 'ignore' });
    child.unref();
    for (let i = 0; i < 120 && !findPid(); i++) await sleep(1000);
    pid = findPid();
    if (!pid) { console.error('nao subiu em 120 s'); return 1; }
    console.log(`pid=${pid}`);
  }

  if (!build()) return 1;

  console.log('--- esperando o personagem entrar no mundo (Ctrl+C para parar)');
  const world = await waitWorld(findPid(), 300000);
  if (!world) {
    console.error('timeout: personagem nao entrou no mundo (login manual?)');
    return 3;
  }
  console.log(`no mundo: pid=${world.pid}  ${world.info}`);

  const existing = loadedPka(world.pid);
  if (existing.length) {
    console.log('DLL ja carregada (' + existing.join(', ') + ') — nao injeto de novo');
  } else {
    const dll = newestDll();
    if (!dll) { console.error('nenhuma DLL compilada'); return 1; }
    console.log('--- injetando ' + path.basename(dll));
    const out = execFileSync(path.join(nativeDir, 'pka_inject.exe'),
      ['--name', IMAGE, '--dll', dll], { encoding: 'utf8' });
    process.stdout.write(out);
    await sleep(2500);
  }

  const test = arg('--test', 'probe');
  const keyFile = path.join(ROOT, 'captures', `channel-key-${world.pid}.json`);
  if (!fs.existsSync(keyFile)) {
    const txt = path.join(nativeDir, 'pka_channel_key.txt');
    if (fs.existsSync(txt)) {
      fs.writeFileSync(keyFile, JSON.stringify({
        capturedAt: new Date().toISOString(), pid: world.pid,
        key: fs.readFileSync(txt, 'utf8').trim(), source: 'auto'
      }, null, 1));
    }
  }

  console.log(`--- teste: ${test}`);
  if (test === 'attack') {
    const fire = has('--fire');
    try {
      const out = execFileSync('node', ['tools/attack-once.cjs', '--pid', String(world.pid), '--first',
        ...(fire ? ['--fire'] : [])], { cwd: ROOT, encoding: 'utf8' });
      process.stdout.write(out);
    } catch (e) {
      console.error((e.stdout || '') + (e.stderr || ''));
    }
  } else {
    try {
      const out = execFileSync('node', ['index.cjs', '--transport=native', '--probe',
        '--key-file', path.relative(path.join(ROOT, 'botfinal'), keyFile)],
        { cwd: path.join(ROOT, 'botfinal'), encoding: 'utf8' });
      process.stdout.write(out.split(/\r?\n/).filter(l => /probe/i.test(l)).join('\n') + '\n');
    } catch (e) {
      console.error((e.stdout || '') + (e.stderr || ''));
    }
  }
  return 0;
}

main().then(c => process.exit(c)).catch(e => { console.error(e); process.exit(1); });
