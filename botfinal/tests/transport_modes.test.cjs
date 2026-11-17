'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createTransport, probeTransport, classify, TRANSPORTS } = require('../core/pipe-transport.cjs');
const { MockGamePipe } = require('../../tools/mock_game_pipe.cjs');

const KEY = 'mock-channel-key-000000000000';
let nextPid = 46600 + (process.pid % 300);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('only native and mock are valid transports', () => {
  assert.deepEqual(TRANSPORTS, ['native', 'mock']);
  assert.throws(() => createTransport('rpm', {}), /transport/i);
  assert.throws(() => createTransport('', {}), /transport/i);
});

test('mock transport authenticates with the same handshake as native', async t => {
  const pid = nextPid++;
  const transport = createTransport('mock', { pid, key: KEY, tickMs: 100 });
  t.after(async () => { await transport.close(); });
  await transport.connect();
  assert.equal(transport.authenticated, true);
  assert.equal(transport.mode, 'mock');

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !(transport.state && transport.telemetry)) await wait(25);
  assert.ok(transport.state, 'state deve chegar');
  assert.ok(transport.telemetry, 'telemetry deve chegar');
  assert.equal(transport.telemetry.schema, 2);
  assert.equal(transport.telemetry.pulseVersion, 3);
});

test('mock transport sends commands and receives ack with status', async t => {
  const pid = nextPid++;
  const transport = createTransport('mock', { pid, key: KEY, tickMs: 100 });
  t.after(async () => { await transport.close(); });
  await transport.connect();

  const ack = await transport.sendCommand('attack', 900001);
  assert.equal(ack.status, 0);
  assert.equal(transport.server.world.attacks.length, 1);
  assert.equal(transport.server.world.attacks[0].targetId, 900001);
});

test('mock world moves the player on walk and rejects bad direction', async t => {
  const pid = nextPid++;
  const transport = createTransport('mock', { pid, key: KEY, tickMs: 100 });
  t.after(async () => { await transport.close(); });
  await transport.connect();
  const before = { ...transport.server.world.position };
  await transport.sendCommand('walk', 1);
  const after = transport.server.world.position;
  assert.equal(after.x, before.x + 1);
  assert.equal(after.y, before.y);
  // direcao > 7 e recusada por encodeCommand, antes de sair.
  await assert.rejects(transport.sendCommand('walk', 99), /suportad|inv[aá]lid/iu);
});

test('mock world damages the target when a skill is used', async t => {
  const pid = nextPid++;
  const transport = createTransport('mock', { pid, key: KEY, tickMs: 100 });
  t.after(async () => { await transport.close(); });
  await transport.connect();
  const target = transport.server.world.creatures[0];
  await transport.sendCommand('attack', target.id);
  await transport.sendCommand('talk', 'm1');
  assert.ok(target.healthPercent < 100, 'alvo deve perder HP');
});

test('mock server refuses a second client (maxInstances=1)', async t => {
  const pid = nextPid++;
  const server = new MockGamePipe({ pid, key: KEY, tickMs: 100 });
  server.on('error', () => {});
  await server.start();
  const first = createTransport('mock', { pid, key: KEY, server, tickMs: 100 });
  await first.connect();
  const second = createTransport('mock', { pid, key: KEY, server, tickMs: 100 });
  try {
    await assert.rejects(second.connect());
    assert.ok(server.rejections.length >= 1, 'servidor deve registrar rejeicao');
  } finally {
    try { await second.close(); } catch { /* ignore */ }
    await first.close();
    await server.close();
  }
});

test('probeTransport reports OK on mock and never sends a command', async () => {
  const pid = nextPid++;
  const { report } = await probeTransport('mock', { pid, key: KEY, timeoutMs: 3000 });
  assert.equal(report.mode, 'mock');
  assert.equal(report.authenticated, true);
  assert.equal(report.ok, true);
  assert.ok(report.state);
  assert.ok(report.telemetry);
  assert.equal(report.telemetry.tick >= 1, true);
});

test('probeTransport reports a classified failure on a missing pipe', async () => {
  const { report } = await probeTransport('native', {
    pid: 99000 + (process.pid % 100), key: 'deadbeef', timeoutMs: 500,
  });
  assert.equal(report.ok, false);
  assert.equal(report.authenticated, false);
  assert.ok(report.failure, 'falha deve ser reportada');
  assert.equal(report.failure.kind, 'missing');
});

test('classify maps the failure modes we actually saw on the live pipe', () => {
  assert.equal(classify(Object.assign(Error('connect EAGAIN'), { code: 'EAGAIN' })), 'busy');
  assert.equal(classify(Object.assign(Error('read EPIPE'), { code: 'EPIPE' })), 'orphaned');
  assert.equal(classify(Object.assign(Error('connect ECONNRESET'), { code: 'ECONNRESET' })), 'orphaned');
  assert.equal(classify(Object.assign(Error('connect ENOENT'), { code: 'ENOENT' })), 'missing');
  assert.equal(classify(Error('Prova do servidor invalida.')), 'bad-key');
  assert.equal(classify(Error('Handshake expirou.')), 'busy');
  assert.equal(classify(Error('something else')), 'unknown');
});
