'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { NativeSession, normalizeCreature, healthFromState, MAX_AGE_MS } = require('../core/native-session.cjs');

const baseTelemetry = () => ({
  schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1,
  fightMode: 0, chaseMode: 0, clockMs: 0, position: { x: 100, y: 100, z: 7 },
  activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'Charizard',
  comboPokemonName: 'Charizard', conditionEvents: true, conditionsKnown: true,
  conditions: [], roster: [{ slot: 1, uuid: 'uuid-1', name: 'Charizard', healthPercent: 100, moves: [] }],
  creatures: [], items: [], tiles: [],
});

function stateBytes({ online = 1, health = 100 } = {}) {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(online, 4);
  bytes.writeUInt32LE(health, 8);
  bytes.writeDoubleLE(500, 12);
  bytes.writeDoubleLE(100, 20);
  bytes.writeDoubleLE(600, 28);
  bytes.writeUInt32LE(0, 36);
  bytes.writeUInt32LE(0, 40);
  bytes.writeUInt32LE(1, 44);
  return bytes;
}

function fakeTransport() {
  const { EventEmitter } = require('node:events');
  return new EventEmitter();
}

test('session builds a snapshot from state and telemetry frames', () => {
  let clock = 1000;
  const session = new NativeSession({ pid: 42, now: () => clock });
  const transport = fakeTransport();
  session.attach(transport);
  transport.emit('state', stateBytes());
  transport.emit('telemetry', Buffer.from(JSON.stringify(baseTelemetry())));
  const snap = session.snapshot();
  assert.equal(snap.pid, 42);
  assert.equal(snap.online, true);
  assert.equal(snap.stale, false);
  assert.equal(snap.healthPercent, 100);
  assert.equal(snap.telemetry.playerName ?? '', '');
  assert.equal(session.usable(), true);
});

test('snapshot goes stale after maxAgeMs without new frames', () => {
  let clock = 1000;
  const session = new NativeSession({ pid: 42, now: () => clock });
  const transport = fakeTransport();
  session.attach(transport);
  transport.emit('state', stateBytes());
  transport.emit('telemetry', Buffer.from(JSON.stringify(baseTelemetry())));
  clock += MAX_AGE_MS + 1;
  const snap = session.snapshot();
  assert.equal(snap.stale, true);
  assert.equal(session.usable(), false);
});

test('no snapshot before both frames arrive', () => {
  const session = new NativeSession({ pid: 42, now: () => 1000 });
  const transport = fakeTransport();
  session.attach(transport);
  assert.equal(session.snapshot(), null);
  transport.emit('state', stateBytes());
  assert.equal(session.snapshot(), null);
});

test('out-of-range HP in a state frame is rejected instead of clamped', () => {
  const session = new NativeSession({ pid: 42, now: () => 1000 });
  const transport = fakeTransport();
  session.attach(transport);
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(999, 8);
  bytes.writeDoubleLE(1, 12);
  bytes.writeDoubleLE(1, 20);
  bytes.writeDoubleLE(1, 28);
  transport.emit('state', bytes);
  assert.ok(session.error, 'decodeState must reject HP > 100');
  assert.equal(session.state, null);
  transport.emit('telemetry', Buffer.from(JSON.stringify(baseTelemetry())));
  assert.equal(session.snapshot(), null, 'a rejected state frame cannot produce a snapshot');
  assert.equal(healthFromState({ healthPercent: 999 }), undefined);
  assert.equal(healthFromState({ healthPercent: 40 }), 40);
});

test('creature type is mapped from the wire field and bad rows are dropped', () => {
  const row = normalizeCreature({ id: 7, name: 'Geodude', healthPercent: 100,
    type: 1, canAttack: true, pos: { x: 101, y: 100, z: 7 } });
  assert.equal(row.creatureType, 1);
  assert.equal(normalizeCreature({ id: 0, name: 'x', healthPercent: 1, pos: { x: 1, y: 1, z: 7 } }), null);
  assert.equal(normalizeCreature({ id: 7, name: '', healthPercent: 1, pos: { x: 1, y: 1, z: 7 } }), null);
  assert.equal(normalizeCreature({ id: 7, name: 'x', healthPercent: 101, pos: { x: 1, y: 1, z: 7 } }), null);
  assert.equal(normalizeCreature({ id: 7, name: 'x', healthPercent: 50, pos: null }), null);
});

test('own pokemon is resolved only when there is exactly one pet', () => {
  const build = creatures => {
    const session = new NativeSession({ pid: 42, now: () => 1000 });
    const transport = fakeTransport();
    session.attach(transport);
    transport.emit('state', stateBytes());
    transport.emit('telemetry', Buffer.from(JSON.stringify({ ...baseTelemetry(), creatures })));
    return session.snapshot();
  };
  const pet = { id: 9, name: 'Eevee', healthPercent: 100, type: 3, canAttack: false, pos: { x: 100, y: 101, z: 7 } };
  assert.equal(build([pet]).telemetry.ownPokemon.id, 9);
  assert.equal(build([pet, { ...pet, id: 10 }]).telemetry.ownPokemon, null);
  assert.equal(build([]).telemetry.ownPokemon, null);
});

test('an offline state frame reports offline and blocks usable()', () => {
  const session = new NativeSession({ pid: 42, now: () => 1000 });
  const transport = fakeTransport();
  session.attach(transport);
  transport.emit('state', stateBytes({ online: 0 }));
  transport.emit('telemetry', Buffer.from(JSON.stringify(baseTelemetry())));
  assert.equal(session.snapshot().online, false);
  assert.equal(session.usable(), false);
});

test('invalid telemetry is surfaced as an error, not silently accepted', () => {
  const session = new NativeSession({ pid: 42, now: () => 1000 });
  const transport = fakeTransport();
  session.attach(transport);
  transport.emit('state', stateBytes());
  transport.emit('telemetry', Buffer.from('{"schema":1}'));
  assert.ok(session.error);
  assert.equal(session.snapshot(), null);
});
