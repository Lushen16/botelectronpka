'use strict';

/**
 * Arranque completo: acha o jogo, injeta a DLL, gera a chave, sobe a UI.
 *
 *   node tools/rota/abrir.cjs              -> tudo automatico
 *   node tools/rota/abrir.cjs --port 7790
 *   node tools/rota/abrir.cjs --no-inject  -> so' a UI (DLL ja injetada)
 *
 * WHY este script existe: hoje cada teste exigiu 5 comandos manuais e o PID
 * muda a cada reinicio do jogo (1712 -> 16048 -> 16260 em uma sessao). Um
 * erro de digitacao no pid produz `ENOENT \\.\pipe\...` que parece "DLL nao
 * injetada" e custou tempo de diagnostico.
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const ROOT = path.resolve(__dirname, '..', '..');
const port = Number(arg('--port', 7788));
const noInject = process.argv.includes('--no-inject');

function log(m) { console.log('[abrir] ' + m); }
function fail(m) { console.error('[abrir] ' + m); process.exit(1); }

/* 1. acha o processo. Prefere o que tem personagem no mundo.
 *
 * MEDIDO (2026-11-13): eu procurava o literal "- Usobot" no titulo. O nome do
 * personagem muda ("- Usobot", "- Vousabotdenovo"), entao a busca falhava com
 * o jogo aberto e correto. O sinal certo e' o separador " - " que o jogo poe
 * entre "PokeAlliance" e o nome do personagem — nao o nome em si.
 *
 * Instancia vazia do jogo (sem personagem) tem titulo exatamente
 * "PokeAlliance" ou "PokeAlliance - Application Crashed"; nenhuma das duas tem
 * o separador com um nome depois. */
function findGamePid() {
  const ps = execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-Process PokeAlliance_dx -ErrorAction SilentlyContinue | " +
    "Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress",
  ], { encoding: 'utf8' }).trim();
  if (!ps) fail('PokeAlliance_dx.exe nao esta rodando. Abra o jogo primeiro.');
  let list = JSON.parse(ps);
  if (!Array.isArray(list)) list = [list];
  if (!list.length) fail('nenhum PokeAlliance_dx.exe encontrado.');

  // "PokeAlliance - <NomeDoPersonagem>" — o nome e' livre, so' o separador importa.
  // Exclui "Application Crashed": o jogo poe esse texto depois do separador
  // quando o renderer morre, e casaria com o regex ingenuo.
  const hasChar = p => {
    const t = String(p.MainWindowTitle || '').trim();
    if (/crashed/iu.test(t)) return false;
    return /^PokeAlliance\s+-\s+\S/u.test(t);
  };
  const withChar = list.filter(hasChar);

  if (withChar.length === 1) return withChar[0].Id;
  if (withChar.length > 1) {
    fail('mais de um processo com personagem: '
      + withChar.map(p => `${p.Id} "${p.MainWindowTitle}"`).join(', '));
  }
  if (list.length === 1) {
    log('aviso: titulo "' + (list[0].MainWindowTitle || '') + '" sem nome de personagem');
    log('aviso: o personagem pode estar no menu ou morto — a UI vai mostrar "fora"');
    return list[0].Id;
  }
  fail('nenhum processo com personagem no mundo. Encontrados: '
    + list.map(p => `${p.Id} "${p.MainWindowTitle}"`).join(', '));
}

const pid = Number(arg('--pid', 0)) || findGamePid();
log('pid do jogo: ' + pid);

/* 2. ja' tem DLL? */
function dllLoaded(p) {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${p} -ErrorAction SilentlyContinue).Modules | ` +
      "Where-Object { $_.ModuleName -eq 'pka_native.dll' } | " +
      "Select-Object -ExpandProperty ModuleName",
    ], { encoding: 'utf8' }).trim();
    return out.includes('pka_native.dll');
  } catch { return false; }
}

if (!noInject) {
  if (dllLoaded(pid)) {
    log('pka_native.dll ja carregada — pulando injecao');
  } else {
    const dll = path.join(ROOT, 'native', 'pka_native.dll');
    const inj = path.join(ROOT, 'native', 'pka_inject.exe');
    if (!fs.existsSync(dll)) fail('sem ' + dll + ' — rode: node tools/build_native.cjs');
    if (!fs.existsSync(inj)) fail('sem ' + inj);
    log('injetando...');
    const r = execFileSync(inj, ['--pid', String(pid), '--dll', dll], { encoding: 'utf8' });
    console.log(r.trim().split('\n').map(l => '[abrir]   ' + l).join('\n'));
    // a DLL leva ~3-4 s para resolver RTTI e abrir o pipe
    log('aguardando o canal subir...');
  }
}

/* 3. espera o pipe existir (a DLL demora: RTTI + control blocks) */
function pipeExists(p) {
  try {
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[System.IO.Directory]::GetFiles('\\\\.\\pipe\\') -match 'pka-runtime-2-${p}$'`,
    ], { encoding: 'utf8' });
    return true;
  } catch { return false; }
}

const deadline = Date.now() + 15000;
let ok = false;
while (Date.now() < deadline) {
  if (pipeExists(pid)) { ok = true; break; }
  try { execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -m 500']); } catch {}
}
if (!ok) {
  fail(`pipe pka-runtime-2-${pid} nao apareceu em 15 s. ` +
    'Veja %TEMP%\\pka_native.log');
}
log('canal no ar');

/* 4. chave */
try {
  const out = execFileSync(process.execPath, [
    path.join(__dirname, 'gerar_chave.cjs'), '--pid', String(pid),
  ], { encoding: 'utf8' });
  console.log(out.trim().split('\n').map(l => '[abrir]   ' + l).join('\n'));
} catch (e) {
  fail('falha ao gerar chave: ' + (e.stdout || e.message));
}

/* 5. sobe a UI */
log(`subindo UI em http://127.0.0.1:${port}`);
const child = spawn(process.execPath, [
  path.join(__dirname, 'servidor.cjs'), '--pid', String(pid), '--port', String(port),
], { stdio: 'inherit' });

setTimeout(() => {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Start-Process 'http://127.0.0.1:${port}'`]);
  } catch { log('abra manualmente: http://127.0.0.1:' + port); }
}, 1200);

child.on('exit', code => process.exit(code ?? 0));
process.on('SIGINT', () => { child.kill(); process.exit(0); });
