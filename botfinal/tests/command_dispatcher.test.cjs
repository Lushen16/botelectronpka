'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { NativeSession } = require('../core/native-session.cjs');
const { CommandDispatcher } = require('../core/command-dispatcher.cjs');

function stateBytes({ online = 1, health = 100 } = {}) {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(online, 4);
  bytes.writeUInt32LE(health, 8);
  bytes.writeDoubleLE(1, 12);
  bytes.writeDoubleLE(1, 20);
  bytes.writeDoubleLE(1, 28);
  return bytes;
}

const telemetryDoc = () => ({
  schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1,
  fightMode: 0, chaseMode: 0, clockMs: 0, position: { x: 100, y: 100, z: 7 },
  activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'Charizard',
  comboPokemonName: 'Charizard', conditionEvents: true, conditionsKnown: true,
  conditions: [], roster: [], creatures: [], items: [], tiles: [],
});

function harness(options = {}) {
  let clock = 1000;
  const sent = [];
  const transport = new EventEmitter();
  transport.sendCommand = async (name, parameter, extra) => {
    sent.push({ name, parameter, extra });
    return { commandId: sent.length, type: 1, status: options.status ?? 0 };
  };
  const session = new NativeSession({ pid: 42, now: () => clock });
  session.attach(transport);
  if (options.fresh !== false) {
    transport.emit('state', stateBytes(options.state));
    transport.emit('telemetry', Buffer.from(JSON.stringify(telemetryDoc())));
  }
  const dispatcher = new CommandDispatcher({ transport, session, now: () => clock });
  return { transport, session, dispatcher, sent, tick: ms => { clock += ms; } };
}

test('attack dispatches the creature id and records acceptance only', async () => {
  const { dispatcher, sent } = harness();
  const record = await dispatcher.attack(1090851189);
  assert.deepEqual([sent[0].name, sent[0].parameter], ['attack', 1090851189]);
  assert.equal(record.inputAccepted, true);
  assert.equal(record.effectVerified, false);
  assert.equal(record.command, 'attack');
});

test('skills map to talk and hotkeys pass through', async () => {
  const { dispatcher, sent } = harness();
  await dispatcher.skill('m3');
  await dispatcher.hotkey('F8');
  assert.deepEqual(sent.map(row => [row.name, row.parameter]), [['talk', 'm3'], ['hotkey', 'F8']]);
});

test('walk validates the direction range', async () => {
  const { dispatcher, sent } = harness();
  await dispatcher.walk(3);
  assert.deepEqual([sent[0].name, sent[0].parameter], ['walk', 3]);
  await assert.rejects(dispatcher.walk(8), /direcao invalida/u);
  await assert.rejects(dispatcher.walk(-1), /direcao invalida/u);
});

test('stale or offline snapshots block the dispatch', async () => {
  const stale = harness();
  stale.tick(5000);
  await assert.rejects(stale.dispatcher.attack(7), error => error.code === 'STALE_SNAPSHOT');
  assert.equal(stale.sent.length, 0);

  const offline = harness({ state: { online: 0 } });
  await assert.rejects(offline.dispatcher.attack(7), error => error.code === 'CLIENT_OFFLINE');
  assert.equal(offline.sent.length, 0);
});

test('no snapshot at all blocks the dispatch', async () => {
  const empty = harness({ fresh: false });
  await assert.rejects(empty.dispatcher.attack(7), error => error.code === 'NO_SNAPSHOT');
  assert.equal(empty.sent.length, 0);
});

test('a non-zero ACK status surfaces as COMMAND_REJECTED', async () => {
  const rejected = harness({ status: 5 });
  await assert.rejects(rejected.dispatcher.attack(7), error => {
    assert.equal(error.code, 'COMMAND_REJECTED');
    assert.equal(error.status, 5);
    return true;
  });
  assert.equal(rejected.dispatcher.log.length, 0, 'rejected commands must not be logged as accepted');
});

test('unsupported commands are rejected before touching the transport', async () => {
  const { dispatcher, sent } = harness();
  await assert.rejects(dispatcher.send('teleport', 1), error => error.code === 'UNSUPPORTED_COMMAND');
  assert.equal(sent.length, 0);
});

test('capture builds a useWith payload with position and ids', async () => {
  const { dispatcher, sent } = harness();
  await dispatcher.capture({ itemId: 15650, targetId: 4029, stack: 2, pos: { x: 101, y: 100, z: 7 } });
  assert.equal(sent[0].name, 'useWith');
  assert.deepEqual(sent[0].parameter, { itemId: 15650, targetId: 4029, stack: 2, x: 101, y: 100, z: 7 });
  await assert.rejects(dispatcher.capture({ itemId: 1, targetId: 2, pos: null }), /posicao de captura/u);
});

test('invalid target ids are rejected', async () => {
  const { dispatcher, sent } = harness();
  for (const bad of [0, -1, 1.5, 0x100000000, '7']) {
    await assert.rejects(dispatcher.attack(bad), /targetId invalido/u);
  }
  assert.equal(sent.length, 0);
});
