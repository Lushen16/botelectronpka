'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RuntimeServer } = require('../../reconstruction/runtime-server.cjs');
const { proof, CLIENT_DOMAIN, SERVER_DOMAIN, proof: WireProof } = require('../../reconstruction/transport.cjs');
const { NativeTransport, KIND } = require('../core/pipe-transport.cjs');

const KEY = '4cf1efb6b1939579d5c3868138c28ffa';
const NONCE = Buffer.alloc(32, 7);
let nextPid = 59100 + (process.pid % 200);

function server(pid) {
  const value = new RuntimeServer({ pid, key: KEY, nonce: NONCE });
  value.on('error', () => {});
  return value;
}

test('botfinal transport authenticates against the reconstructed runtime', async () => {
  const pid = nextPid++;
  const value = server(pid);
  await value.start();
  const transport = new NativeTransport({ pid, key: KEY });
  try {
    await transport.connect();
    assert.equal(transport.authenticated, true);
    assert.equal(value.authenticated, true);
    assert.deepEqual(value.authenticatePayload, proof(CLIENT_DOMAIN, KEY, NONCE, pid));
  } finally {
    transport.close();
    await value.close();
  }
});

test('commands leave in the manual frame, not in the authenticate frame', async () => {
  const pid = nextPid++;
  const value = server(pid);
  await value.start();
  const transport = new NativeTransport({ pid, key: KEY });
  try {
    await transport.connect();
    const ack = await transport.sendCommand('attack', 1090851189);
    assert.equal(ack.commandId, 1);
    assert.equal(ack.status, 0);
    assert.equal(value.commands.length, 1);
    assert.equal(value.commands[0].kind, KIND.manual);
    assert.equal(value.commands[0].payload.readUInt32LE(4), 2, 'attack opcode is 2');
    assert.equal(value.commands[0].payload.readUInt32LE(8), 1090851189);
  } finally {
    transport.close();
    await value.close();
  }
});

test('client and server proofs use distinct domains', () => {
  assert.notDeepEqual(proof(CLIENT_DOMAIN, KEY, NONCE, 1), proof(SERVER_DOMAIN, KEY, NONCE, 1));
  assert.equal(WireProof, proof);
});

test('a busy pipe is reported as such instead of as a protocol failure', async () => {
  const pid = nextPid++;
  const transport = new NativeTransport({
    pid, key: KEY, startupTimeoutMs: 300,
    connect: () => {
      const socket = new (require('node:net').Socket)();
      const error = Object.assign(Error('connect EAGAIN'), { code: 'EAGAIN' });
      process.nextTick(() => socket.emit('error', error));
      return socket;
    },
  });
  await assert.rejects(transport.connect(), error => {
    assert.equal(error.pipeBusy, true);
    return true;
  });
  assert.equal(transport.pipeBusy, true);
  transport.close();
});
