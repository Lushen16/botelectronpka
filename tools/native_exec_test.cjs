'use strict';

/**
 * Prova o caminho de EXECUCAO da pka_native.dll, de ponta a ponta.
 *
 * Usa native\pka_window_target.exe: um alvo que cria uma janela real com titulo
 * "PokeAlliance ..." e CONTA as teclas recebidas. Assim o status 0 do ACK nao
 * e so "PostMessageW aceito" - da para verificar que a tecla chegou na janela.
 *
 *   node tools/native_exec_test.cjs
 *
 * Fluxo:
 *   1. abre o alvo com janela e arquivo de resultado
 *   2. injeta pka_native.dll no alvo
 *   3. conecta com o cliente real do botfinal (HMAC)
 *   4. envia walk (seta) e hotkey (F5)
 *   5. encerra o alvo e le as teclas contadas
 *
 * Limite: prova entrega de tecla, nao efeito no jogo. effectVerified = false.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const INJECT = path.join(root, 'native', 'pka_inject.exe');
const DLL = path.join(root, 'native', 'pka_native.dll');
const TARGET = path.join(root, 'native', 'pka_window_target.exe');
const KEYFILE = path.join(root, 'native', 'pka_channel_key.txt');
const RESULT = path.join(root, 'native', 'exec-result.json');
const KEY = '0123456789abcdef0123456789abcdef';
const TITLE = 'PokeAlliance - exec-test';

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' :: ' + detail : ''));
};
const wait = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  for (const f of [INJECT, DLL, TARGET]) {
    if (!fs.existsSync(f)) { console.error('rode node tools/build_native.cjs'); process.exit(2); }
  }
  fs.writeFileSync(KEYFILE, KEY + '\n');
  try { fs.rmSync(RESULT, { force: true }); } catch { /* ignore */ }

  const child = spawn(TARGET, ['--title', TITLE, '--result', RESULT, '--seconds', '6'],
    { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let targetOut = '';
  child.stdout.on('data', d => { targetOut += d.toString(); });
  child.stderr.on('data', d => { targetOut += d.toString(); });
  await wait(1800);

  const pid = child.pid;
  check('alvo com janela iniciado', Boolean(pid), 'pid=' + pid);
  check('janela criada pelo alvo', /janela pronta/.test(targetOut),
    (targetOut.match(/hwnd=0x[0-9a-f]+/) || [''])[0]);
  if (!pid || !/janela pronta/.test(targetOut)) {
    try { child.kill(); } catch { /* ignore */ }
    process.exit(1);
  }

  const inject = spawnSync(INJECT, ['--pid', String(pid), '--dll', DLL],
    { encoding: 'utf8', timeout: 20000 });
  check('injecao', inject.status === 0,
    ((inject.stdout || '') + (inject.stderr || '')).trim().replace(/\r?\n/g, ' | '));

  const expected = 'pka-runtime-2-' + pid;
  let found = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !found) {
    try { found = fs.readdirSync('\\\\.\\pipe\\').includes(expected); } catch { /* ignore */ }
    if (!found) await wait(200);
  }
  check('pipe criado pela dll', found, expected);

  let walkStatus = null;
  let hotkeyStatus = null;
  if (found) {
    const { createTransport } = require('../botfinal/core/pipe-transport.cjs');
    const transport = createTransport('native', { pid, key: KEY,
      startupTimeoutMs: 5000, commandTimeoutMs: 4000 });
    let state = null;
    let telemetry = null;
    transport.on('state', v => { state = v; });
    transport.on('telemetry', v => { telemetry = v; });
    try {
      await transport.connect();
      check('handshake HMAC', transport.authenticated === true);
      const d = Date.now() + 4000;
      while (Date.now() < d && !(state && telemetry)) await wait(50);
      check('state/telemetry publicados', Boolean(state && telemetry),
        state ? 'hp=' + state.healthPercent + ' tick=' + telemetry?.tick : 'ausente');

      const walk = await transport.sendCommand('walk', 1);
      walkStatus = walk?.status;
      check('walk posta tecla (status 0)', walkStatus === 0, 'status=' + walkStatus);

      const hot = await transport.sendCommand('hotkey', 'F5');
      hotkeyStatus = hot?.status;
      check('hotkey posta tecla (status 0)', hotkeyStatus === 0, 'status=' + hotkeyStatus);

      const atk = await transport.sendCommand('attack', 9999);
      check('attack admite falta de funcao nativa', atk?.status === 3, 'status=' + atk?.status);
    } catch (error) {
      check('sessao', false, error.message);
    } finally {
      try { await transport.close(); } catch { /* ignore */ }
    }
  }

  // deixa o alvo chegar ao fim natural (--seconds 40 -> usa 6) gravando o resultado
  await wait(6500);
  try { child.kill(); } catch { /* ignore */ }
  await wait(600);

  let received = null;
  if (fs.existsSync(RESULT)) {
    try { received = JSON.parse(fs.readFileSync(RESULT, 'utf8')); } catch { /* ignore */ }
  }
  check('alvo registrou teclas', Boolean(received),
    received ? 'keyDown=' + received.keyDown + ' keyUp=' + received.keyUp + ' lastVk=' + received.lastVk : 'sem arquivo');

  if (received) {
    // walk east (dir=1) = VK_RIGHT (0x27); hotkey F5 = 0x74
    check('teclas chegaram na janela', received.keyDown >= 2 && received.keyUp >= 2,
      'keyDown=' + received.keyDown + ' keyUp=' + received.keyUp);
    check('ultima tecla foi F5 (0x74)', received.lastVk === 0x74,
      'lastVk=0x' + Number(received.lastVk).toString(16));
  }

  try { fs.rmSync(KEYFILE, { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(RESULT, { force: true }); } catch { /* ignore */ }

  const failed = results.filter(r => !r.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(2); });
