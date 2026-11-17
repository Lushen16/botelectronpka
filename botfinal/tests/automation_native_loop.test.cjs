'use strict';

/**
 * Loop completo do kind 11 contra o NOSSO runtime nativo (pka_native.dll),
 * carregado por pka_host.exe em modo host — sem o jogo.
 *
 *   node tools/build_native.cjs --only bot
 *   node --test botfinal/tests/automation_native_loop.test.cjs
 *
 * Prova:
 *   - a DLL publica `boot` no kind 6 (antes ela nao publicava: o cliente era
 *     obrigado a inventar um id)
 *   - AutomationControl aprende o boot da sessao (requireSessionBoot)
 *   - kind 11 start/stop chega, a DLL aplica e o kind 6 seguinte reflete
 *   - kind 12 lease e aceito e o `client` declarado volta no kind 6
 *
 * NAO prova: que o runtime do FORNECEDOR aceite — isso exige o jogo.
 * E nao prova efeito: a DLL deles nao executa nada, so' registra estado.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const HOST = path.join(ROOT, 'native', 'pka_host.exe');
const DLL = path.join(ROOT, 'native', 'pka_native.dll');
const { Transport } = require(path.join(ROOT, 'reconstruction', 'transport.cjs'));
const { AutomationControl, STATE } =
  require(path.join(__dirname, '..', 'core', 'automation-control.cjs'));

const KEY = '0123456789abcdef0123456789abcdef';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let nextPid = 49700 + (process.pid % 200);

async function withHost(fn) {
  assert.ok(fs.existsSync(HOST) && fs.existsSync(DLL),
    'compile antes: node tools/build_native.cjs --only bot');
  const pid = nextPid++;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-loop-'));
  const host = spawn(HOST, [DLL], {
    cwd: ROOT,
    env: { ...process.env, PKA_HOST_MODE: '1', PKA_CHANNEL_PID: String(pid),
      PKA_CHANNEL_KEY: KEY, PKA_LOG_DIR: logDir },
    stdio: 'ignore',
  });
  const transport = new Transport({ pid, key: KEY, startupTimeoutMs: 6000 });
  transport.on('error', () => {});
  const frames = [];
  transport.on('frame', item => {
    let body = null;
    try { body = JSON.parse(item.payload.toString('utf8')); } catch { /* ignore */ }
    frames.push({ kind: item.kind, body });
  });
  try {
    await wait(1200);
    await transport.connect();
    await fn({ transport, pid, frames });
  } finally {
    try { transport.close(); } catch { /* ignore */ }
    try { host.kill(); } catch { /* ignore */ }
    await wait(400);
    try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* log aberto */ }
  }
}

test('DLL publica boot no kind 6 e o cliente aprende a sessao', async () => {
  await withHost(async ({ transport, pid, frames }) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && frames.filter(f => f.kind === 6).length < 1) await wait(50);

    const first = frames.find(f => f.kind === 6);
    assert.ok(first, 'kind 6 deve chegar');
    assert.match(first.body.boot, /^[0-9a-f]{32}$/u, 'boot publicado pela DLL');
    assert.equal(first.body.client, '', 'client comeca vazio: e do menu, nao da DLL');

    const control = new AutomationControl({ transport, pid,
      requireSessionBoot: true, bootWaitMs: 2000 });
    const connected = await control.connect({ timeoutMs: 3000 });
    assert.equal(connected.ok, true, connected.message);
    assert.equal(control.identity.bootSource, 'session');
    assert.equal(control.identity.boot, first.body.boot,
      'o boot usado no kind 11 e o mesmo que a DLL publicou');
    await control.close();
  });
});

test('kind 11 start/stop aplica e o kind 6 seguinte reflete', async () => {
  await withHost(async ({ transport, pid, frames }) => {
    const control = new AutomationControl({ transport, pid, requireSessionBoot: true,
      bootWaitMs: 2000 });
    const connected = await control.connect({ timeoutMs: 3000 });
    assert.equal(connected.ok, true, connected.message);
    assert.equal(control.state, STATE.READY);

    const start = await control.start('target');
    assert.equal(start.ok, true, start.message);
    assert.equal(start.sent, true);
    assert.equal(start.effect, 'unverified', 'kind 11 nao tem ACK');

    frames.length = 0;
    await wait(900);
    const afterStart = frames.filter(f => f.kind === 6).pop();
    assert.ok(afterStart, 'kind 6 depois do start');
    assert.deepEqual(afterStart.body.modules, ['target'],
      'no NOSSO runtime o start aparece em modules; no fornecedor e no kind 6 deles');

    const stop = await control.stop('target');
    assert.equal(stop.ok, true, stop.message);
    frames.length = 0;
    await wait(900);
    const afterStop = frames.filter(f => f.kind === 6).pop();
    assert.deepEqual(afterStop.body.modules, []);
    await control.close();
  });
});

test('lease (kind 12) e aceito e o client declarado volta no kind 6', async () => {
  await withHost(async ({ transport, pid, frames }) => {
    const control = new AutomationControl({ transport, pid, requireSessionBoot: true,
      bootWaitMs: 2000, withLease: true });
    const connected = await control.connect({ timeoutMs: 3000 });
    assert.equal(connected.ok, true, connected.message);

    await control.monitor(true);
    frames.length = 0;
    await wait(900);
    const after = frames.filter(f => f.kind === 6).pop();
    assert.ok(after, 'kind 6 depois do monitor');
    assert.equal(after.body.monitor.enabled, true);
    assert.equal(after.body.client, control.identity.client,
      'lease registrou o client do cliente');
    await control.close();
  });
});
