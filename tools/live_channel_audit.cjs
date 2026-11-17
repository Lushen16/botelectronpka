'use strict';

// Roda a auditoria AO VIVO pelo canal nativo em um Electron filho e reporta o
// resultado de `live-channel-audit.json`.
//
//   node tools/live_channel_audit.cjs --pid 1712
//   node tools/live_channel_audit.cjs --pid 1712 --key-file captures/channel-key-1712.json
//
// O processo precisa estar ELEVADO: o pipe `pka-runtime-2-<pid>` pertence a um
// processo elevado e recusa cliente de integridade menor (EPERM).
//
// Ele so' mata o filho que ele mesmo criou. Timeout, relatorio ausente ou
// relatorio ilegivel sao falha — nunca passe silencioso.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { parseProcesses } = require('../reconstruction/live-client.cjs');

const root = path.resolve(__dirname, '..');
const timeoutMs = Number(process.env.PKA_LIVE_AUDIT_TIMEOUT_MS) || 180000;
let timedOut = false;
const arg = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : process.argv[index + 1];
};

function discoverPid() {
  const requested = Number(arg('--pid', process.env.PKA_PID || 0));
  if (Number.isInteger(requested) && requested > 0) return requested;
  const run = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq PokeAlliance_dx.exe', '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true });
  const pids = parseProcesses(run.stdout || '');
  if (pids.length === 1) return pids[0];
  throw Error(pids.length ? 'Mais de um cliente aberto: ' + pids.join(', ') + '. Use --pid.' : 'Nenhum cliente aberto.');
}

function resolveKeyFile(pid) {
  const explicit = arg('--key-file', process.env.PKA_CHANNEL_KEY_FILE);
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw Error('Arquivo de chave ausente: ' + resolved);
    return resolved;
  }
  const fromCapture = path.join(root, 'captures', `channel-key-${pid}.json`);
  if (fs.existsSync(fromCapture)) return fromCapture;
  const nativeKey = path.join(root, 'native', 'pka_channel_key.txt');
  if (fs.existsSync(nativeKey)) {
    const key = fs.readFileSync(nativeKey, 'utf8').trim();
    if (!key) throw Error('native/pka_channel_key.txt vazio.');
    fs.mkdirSync(path.dirname(fromCapture), { recursive: true });
    fs.writeFileSync(fromCapture, JSON.stringify({ capturedAt: new Date().toISOString(), pid, key, source: 'native-file' }, null, 1));
    return fromCapture;
  }
  throw Error('Sem chave do canal: use --key-file ou PKA_CHANNEL_KEY_FILE.');
}

/* O canal so' existe com a DLL dentro do processo. Injeta quando falta e espera
 * o pipe subir — a DLL leva alguns segundos (RTTI + control blocks). Assim o
 * comando e' um so', sem depender de injecao manual antes. */
function dllLoaded(targetPid) {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${targetPid} -ErrorAction SilentlyContinue).Modules | `
    + "Where-Object { $_.ModuleName -eq 'pka_native.dll' } | Select-Object -ExpandProperty ModuleName"],
  { encoding: 'utf8', windowsHide: true });
  return String(run.stdout || '').includes('pka_native.dll');
}

function pipeExists(targetPid) {
  return fs.readdirSync('\\\\.\\pipe\\').some(name => name === `pka-runtime-2-${targetPid}`);
}

/* O servidor da DLL atende UMA sessao por vez: com o bot do usuario conectado,
 * a conexao da auditoria nem recebe challenge e morre em "Handshake expirou."
 * (medido no log da DLL: nenhum "cliente conectado" para a tentativa). Por isso
 * os clientes conhecidos sao encerrados antes — com --keep-client eles ficam. */
const CLIENT_MARKERS = ['rota\\servidor.cjs', 'rota/servidor.cjs', 'run_bot.cjs',
  'hunt_daemon.cjs', 'observe-motion.cjs'];

function freeChannel() {
  if (process.argv.includes('--keep-client')) return [];
  const script = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'node.exe\' } | '
    + 'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true });
  let list = [];
  try { list = JSON.parse(String(run.stdout || '').trim() || '[]'); } catch { return []; }
  if (!Array.isArray(list)) list = [list];
  const killed = [];
  for (const entry of list) {
    const line = String(entry.CommandLine || '');
    if (!line || line.includes('live_channel_audit')) continue;
    if (!CLIENT_MARKERS.some(marker => line.includes(marker))) continue;
    try { process.kill(entry.ProcessId); killed.push(entry.ProcessId); } catch { /* ja morreu */ }
  }
  return killed;
}

async function ensureChannel(targetPid) {
  if (!dllLoaded(targetPid)) {
    const dll = path.join(root, 'native', 'pka_native.dll');
    const injector = path.join(root, 'native', 'pka_inject.exe');
    if (!fs.existsSync(dll) || !fs.existsSync(injector)) throw Error('Sem pka_native.dll/pka_inject.exe em native/.');
    const run = spawnSync(injector, ['--pid', String(targetPid), '--dll', dll], { encoding: 'utf8', windowsHide: true });
    if (run.error || run.status !== 0) throw Error('Injecao falhou: ' + (run.stderr || run.stdout || run.error?.message));
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (pipeExists(targetPid)) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error(`pipe pka-runtime-2-${targetPid} nao apareceu em 20 s.`);
}

const reportPath = path.join(root, 'live-channel-audit.json');

function finish(code, pid) {
  if (timedOut) {
    console.error(JSON.stringify({ audit: false, error: 'timeout sem relatorio', pid, timeoutMs }));
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(reportPath)) {
    console.error(JSON.stringify({ audit: false, error: 'relatorio ausente', pid, exit: code }));
    process.exitCode = 1;
    return;
  }
  let report;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
  catch (error) {
    console.error(JSON.stringify({ audit: false, error: 'relatorio ilegivel: ' + error.message }));
    process.exitCode = 1;
    return;
  }
  const failed = (report.checks || []).filter(check => check.required && check.passed !== true).map(check => check.name);
  const declared = (report.checks || []).filter(check => !check.required && check.passed !== true).map(check => check.name);
  console.log(JSON.stringify({
    audit: report.ok === true, ok: report.ok === true, pid, report: path.relative(root, reportPath),
    failed, declared, missing: report.missing || [], crash: report.crash || null, exit: code,
  }));
  process.exitCode = report.ok === true && code === 0 ? 0 : 1;
}

async function main() {
  const pid = discoverPid();
  await ensureChannel(pid);
  const keyFile = resolveKeyFile(pid);
  const killed = freeChannel();
  if (killed.length) {
    console.error(JSON.stringify({ clients_encerrados: killed }));
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  fs.rmSync(reportPath, { force: true });
  const env = { ...process.env, PKA_CHANNEL_KEY_FILE: keyFile, PKA_PID: String(pid) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  const child = spawn(path.join(root, 'runtime/electron-v44.7.2/electron.exe'),
    [path.join(root, 'reconstruction/app'), '--live-channel-audit'], { env, cwd: root, stdio: 'inherit' });
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
  child.on('error', error => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { clearTimeout(timer); finish(code, pid); });
}

main().catch(error => {
  console.error(JSON.stringify({ audit: false, error: error.message }));
  process.exit(2);
});
