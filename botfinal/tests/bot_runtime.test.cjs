'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { BotRuntime } = require('../core/bot-runtime.cjs');
const { NativeSession } = require('../core/native-session.cjs');
const { CommandDispatcher } = require('../core/command-dispatcher.cjs');
const { BOT_STATES } = require('../core/state-arbiter.cjs');

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

const telemetryDoc = (patch = {}) => ({
  schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1,
  fightMode: 0, chaseMode: 0, clockMs: 0, position: { x: 100, y: 100, z: 7 },
  activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'Charizard',
  comboPokemonName: 'Charizard', conditionEvents: true, conditionsKnown: true,
  conditions: [], roster: [], creatures: [], items: [], tiles: [], ...patch,
});

const monster = (id, x) => ({ id, name: 'Geodude', healthPercent: 100, type: 1,
  canAttack: true, pos: { x, y: 100, z: 7 } });

function harness({ config, telemetry, commands = {} } = {}) {
  let clock = 1000;
  const sent = [];
  const transport = new EventEmitter();
  transport.sendCommand = async (name, parameter) => {
    sent.push({ name, parameter });
    const status = commands[name]?.status ?? 0;
    return { commandId: sent.length, type: 1, status };
  };
  const session = new NativeSession({ pid: 42, now: () => clock });
  session.attach(transport);
  const dispatcher = new CommandDispatcher({ transport, session, now: () => clock });
  const walker = { ticks: 0, config, updateConfig() {}, pause() {}, resume() {},
    async tick() { this.ticks += 1; return { action: 'move' }; } };
  const healer = { ticks: 0, updateConfig() {}, async tick() { this.ticks += 1; return { action: 'heal' }; } };
  const combat = { targetId: null, step: 0, updateConfig() {},
    filterValidTargets(t) { return t.creatures.filter(c => c.canAttack); },
    isLureConditionMet(t, c) { return c.length > 0; },
    selectTarget(t, c) { return c[0] || null; },
    async tick(t, dispatcher) {
      this.targetId = 1;
      await dispatcher.attack(1);
      return { action: 'attack', targetId: 1 };
    } };
  const runtime = new BotRuntime({ session, transport, config: config || { target: { enabled: true },
    healer: { enabled: true }, walker: { enabled: true } },
    combat, walker, healer, dispatcher, now: () => clock });
  const push = (doc, state = {}) => {
    transport.emit('state', stateBytes(state));
    transport.emit('telemetry', Buffer.from(JSON.stringify(doc)));
  };
  return { runtime, session, dispatcher, sent, push, walker, healer, combat,
    tick: ms => { clock += ms; } };
}

test('tick reports waiting without a snapshot', async () => {
  const h = harness();
  h.runtime.start();
  const result = await h.runtime.tick();
  assert.equal(result.status, 'waiting');
  assert.equal(result.reason, 'no-snapshot');
  assert.equal(h.runtime.last.status, 'waiting');
  h.runtime.stop();
});

test('stale snapshot blocks the tick instead of acting', async () => {
  const h = harness();
  h.push(telemetryDoc({ creatures: [monster(7, 101)] }));
  h.runtime.start();
  h.tick(5000);
  const result = await h.runtime.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'stale-snapshot');
  h.runtime.stop();
});

test('offline client blocks the tick', async () => {
  const h = harness();
  h.push(telemetryDoc({ creatures: [monster(7, 101)] }), { online: 0 });
  h.runtime.start();
  const result = await h.runtime.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'client-offline');
  h.runtime.stop();
});

test('combat state delegates to the combat engine', async () => {
  const h = harness();
  h.push(telemetryDoc({ creatures: [monster(7, 101)] }));
  h.runtime.start();
  const result = await h.runtime.tick();
  assert.equal(result.status, 'combat');
  h.runtime.stop();
});

test('walking state delegates to the walker', async () => {
  const h = harness();
  h.push(telemetryDoc());
  h.runtime.start();
  await h.runtime.tick();
  assert.ok(h.walker.ticks >= 1);
  h.runtime.stop();
});

test('healing state delegates to the healer on critical HP', async () => {
  const h = harness();
  h.push(telemetryDoc(), { health: 5 });
  h.runtime.start();
  await h.runtime.tick();
  assert.ok(h.healer.ticks >= 1);
  h.runtime.stop();
});

test('a rejected command surfaces as an error tick, not a silent success', async () => {
  const h = harness();
  h.dispatcher.send = async () => { throw Object.assign(Error('Runtime rejeitou attack'), { code: 'COMMAND_REJECTED' }); };
  h.push(telemetryDoc({ creatures: [monster(7, 101)] }));
  h.runtime.start();
  const result = await h.runtime.tick();
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'COMMAND_REJECTED');
  assert.equal(result.inputAccepted, false);
  h.runtime.stop();
});

test('pause suspends ticks and resume brings them back', async () => {
  const h = harness();
  h.push(telemetryDoc({ creatures: [monster(7, 101)] }));
  h.runtime.start();
  await h.runtime.pause();
  assert.equal(await h.runtime.tick(), null);
  await h.runtime.resume();
  assert.ok(await h.runtime.tick());
  h.runtime.stop();
});

test('arbiter constants are the ones the runtime switches on', () => {
  assert.equal(BOT_STATES.COMBAT, 'COMBAT');
  assert.equal(BOT_STATES.WALKING, 'WALKING');
});
