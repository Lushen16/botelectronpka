'use strict';

/**
 * Integracao: PipeTransport -> NativeSession -> CommandDispatcher -> BotRuntime
 * contra o RuntimeServer de fixture (mesmo protocolo do runtime nativo).
 *
 * Isto prova a pilha montada de ponta a ponta sem o jogo. NAO prova efeito no
 * jogo: o servidor aqui e o reconstruido em reconstruction/runtime-server.cjs.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { RuntimeServer } = require('../../reconstruction/runtime-server.cjs');
const { NativeTransport } = require('../core/pipe-transport.cjs');
const { NativeSession } = require('../core/native-session.cjs');
const { CommandDispatcher } = require('../core/command-dispatcher.cjs');
const { BotRuntime } = require('../core/bot-runtime.cjs');
const { CombatEngine } = require('../engines/combat-engine.cjs');
const { WalkerEngine } = require('../engines/walker-engine.cjs');
const { HealerEngine } = require('../engines/healer-engine.cjs');
const { StateArbiter } = require('../core/state-arbiter.cjs');

const KEY = '4cf1efb6b1939579d5c3868138c28ffa';
const NONCE = Buffer.alloc(32, 3);
let nextPid = 59400 + (process.pid % 200);

function stateBytes({ online = 1, health = 100, target = 0 } = {}) {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(online, 4);
  bytes.writeUInt32LE(health, 8);
  bytes.writeDoubleLE(500, 12);
  bytes.writeDoubleLE(100, 20);
  bytes.writeDoubleLE(600, 28);
  bytes.writeUInt32LE(target, 36);
  return bytes;
}

function telemetryDoc(patch = {}) {
  return {
    schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 0x10000001,
    fightMode: 0, chaseMode: 0, clockMs: 0, position: { x: 100, y: 100, z: 7 },
    activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'Charizard',
    comboPokemonName: 'Charizard', conditionEvents: true, conditionsKnown: true,
    conditions: [], roster: [], creatures: [], items: [], tiles: [], ...patch,
  };
}

const rat = (id, x) => ({ id, name: 'Rattata', healthPercent: 100, type: 1,
  canAttack: true, pos: { x, y: 100, z: 7 } });

async function stack(t, { telemetry, state } = {}) {
  const pid = nextPid++;
  const server = new RuntimeServer({ pid, key: KEY, nonce: NONCE });
  server.on('error', () => {});
  await server.start();

  const transport = new NativeTransport({ pid, key: KEY });
  await transport.connect();
  const session = new NativeSession({ pid }).attach(transport);

  server.publishState(stateBytes(state));
  server.publishTelemetry(telemetry || telemetryDoc());
  // Deixa os quadros chegarem no parser do transporte.
  await new Promise(resolve => setTimeout(resolve, 80));

  const config = {
    target: { enabled: true, maxDistance: 8, monsters: [{ name: '*', range: 8, minCount: 1 }],
      combo: { enabled: true, useNativeSequence: false, sequenceText: 'm1 m2', stepDelay: 250 } },
    walker: { enabled: true, waypoints: [{ action: 'walk', pos: { x: 103, y: 100, z: 7 } }] },
    healer: { enabled: true, healHpPercent: 20 },
    hoenn: { minWildsToEngage: 0, perfectLure: false },
  };
  const dispatcher = new CommandDispatcher({ transport, session });
  const runtime = new BotRuntime({
    session, transport, config,
    combat: new CombatEngine(config), walker: new WalkerEngine(config),
    healer: new HealerEngine(config), arbiter: new StateArbiter(config), dispatcher,
  });
  t.after(async () => {
    runtime.stop();
    transport.close();
    await server.close();
  });
  return { server, transport, session, dispatcher, runtime, config, pid };
}

test('auth, real state and real telemetry arrive through the native pipe', async t => {
  const value = await stack(t);
  assert.equal(value.transport.authenticated, true);
  assert.equal(value.server.authenticated, true);
  const snapshot = value.session.snapshot();
  assert.ok(snapshot, 'snapshot must exist after state+telemetry');
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.healthPercent, 100);
  assert.deepEqual(snapshot.telemetry.position, { x: 100, y: 100, z: 7 });
});

test('combat tick dispatches attack in the manual frame and the server records it', async t => {
  const value = await stack(t, { telemetry: telemetryDoc({ creatures: [rat(7, 101)] }) });
  value.runtime.start();
  await value.runtime.tick();
  const frames = value.server.commands.filter(row => row.kind === 9);
  assert.equal(frames.length, 1, 'exactly one command frame per tick');
  const payload = frames[0].payload;
  assert.equal(payload.readUInt32LE(4), 2, 'attack opcode');
  assert.equal(payload.readUInt32LE(8), 7, 'creature id');
  value.runtime.stop();
});

test('a stale snapshot stops the stack before it can dispatch', async t => {
  const value = await stack(t, { telemetry: telemetryDoc({ creatures: [rat(7, 101)] }) });
  value.runtime.start();
  // Envelhece o snapshot sem publicar quadros novos.
  value.session.stateAt -= 5000;
  value.session.telemetryAt -= 5000;
  const result = await value.runtime.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'stale-snapshot');
  assert.equal(value.server.commands.length, 0);
  value.runtime.stop();
});

test('offline state keeps the stack silent', async t => {
  const value = await stack(t, {
    telemetry: telemetryDoc({ creatures: [rat(7, 101)] }), state: { online: 0 },
  });
  value.runtime.start();
  const result = await value.runtime.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'client-offline');
  assert.equal(value.server.commands.length, 0);
  value.runtime.stop();
});

test('walking dispatches the walk opcode with the computed direction', async t => {
  const value = await stack(t);
  value.runtime.start();
  await value.runtime.tick();
  const frames = value.server.commands.filter(row => row.kind === 9);
  assert.ok(frames.length >= 1);
  const walk = frames.find(row => row.payload.readUInt32LE(4) === 1);
  assert.ok(walk, 'walk opcode 1 must be present');
  assert.equal(walk.payload.readUInt32LE(8), 1, 'east');
  value.runtime.stop();
});

test('a server rejection surfaces as a command error, not success', async t => {
  const value = await stack(t, { telemetry: telemetryDoc({ creatures: [rat(7, 101)] }) });
  // Forca status != 0 em todo ACK.
  value.server.commandStatus = 5;
  value.runtime.start();
  const result = await value.runtime.tick();
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'COMMAND_REJECTED');
  assert.equal(result.inputAccepted, false);
  value.runtime.stop();
});
