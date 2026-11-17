'use strict';

/**
 * `runtimeReady` — o sinal de "posso agir agora?".
 *
 * Contexto medido (docs/MOTION_VS_HOLDING_RPM.md, adendo 6): 54 comandos de
 * walk retornaram sucesso com o jogo no MENU e ZERO tiles foram andados. Nenhum
 * sinal existente detectava:
 *
 *   `healthPercent` = 100 no menu tambem;
 *   `position`      = vtable-scan acha a instancia sem mapa ativo;
 *   `playerName`    = sobrevive a transicao.
 *
 * O gate [rt+0x2668] e' o unico discriminador. Estes testes travam:
 *   1. `false` bloqueia walk/attack (nao gasta comando);
 *   2. `undefined` (DLL antiga) NAO bloqueia — senao toda DLL anterior morre;
 *   3. o decode rejeita tipo errado em vez de coagir.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { NativeSession } = require(path.join(__dirname, '..', 'core', 'native-session.cjs'));
const { BotRuntime } = require(path.join(__dirname, '..', 'core', 'bot-runtime.cjs'));
const { CommandDispatcher } = require(path.join(__dirname, '..', 'core', 'command-dispatcher.cjs'));
const { decodeTelemetry } = require(path.join(__dirname, '..', '..', 'reconstruction', 'telemetry.cjs'));

function stateBytes({ online = 1, health = 100 } = {}) {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(online, 4);
  bytes.writeUInt32LE(health, 8);
  bytes.writeDoubleLE(100, 12);
  bytes.writeDoubleLE(50, 20);
  bytes.writeDoubleLE(50, 28);
  return bytes;
}

const doc = (patch = {}) => ({
  schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1,
  fightMode: 0, chaseMode: 0, clockMs: 0, position: { x: 100, y: 100, z: 7 },
  activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'Dugtrio',
  comboPokemonName: '', conditionEvents: false, conditionsKnown: false,
  conditions: [], roster: [], creatures: [], items: [], tiles: [], ...patch,
});

function harness(telemetryPatch) {
  const sent = [];
  const transport = new EventEmitter();
  transport.sendCommand = async (name, parameter) => {
    sent.push({ name, parameter });
    return { commandId: sent.length, type: 1, status: 0 };
  };
  const session = new NativeSession({ pid: 42 });
  session.attach(transport);
  const dispatcher = new CommandDispatcher({ transport, session });
  const walker = { updateConfig() {}, async tick() { await dispatcher.walk(1); return { action: 'move' }; } };
  const combat = {
    targetId: null, updateConfig() {},
    filterValidTargets: t => t.creatures.filter(c => c.canAttack),
    isLureConditionMet: (_t, c) => c.length > 0,
    isFormationHeld: (_t, c) => c.length > 0,
    isRepositioning: () => false,
    selectTarget: (_t, c) => c[0] || null,
    async tick(_t, d) { await d.attack(7); return { action: 'attack' }; },
  };
  const healer = { updateConfig() {}, async tick() { return { action: 'idle' }; } };
  const runtime = new BotRuntime({
    session, transport, combat, walker, healer, dispatcher,
    config: { target: { enabled: true, lowHpComboPercent: 20 }, walker: { enabled: true },
      healer: { enabled: true, healHpPercent: 15 } },
  });
  transport.emit('state', stateBytes());
  transport.emit('telemetry', Buffer.from(JSON.stringify(doc(telemetryPatch))));
  return { runtime, session, sent };
}

test('runtimeReady=false bloqueia o tick (personagem no menu)', async () => {
  const h = harness({ runtimeReady: false, creatures: [{ id: 7, name: 'Rattata', type: 1,
    healthPercent: 100, canAttack: true, pos: { x: 101, y: 100, z: 7 } }] });
  h.runtime.start();
  const result = await h.runtime.tick();
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'runtime-not-ready');
  assert.equal(result.inputAccepted, false);
  assert.deepEqual(h.sent, [], 'nao pode gastar comando fora do mundo');
  h.runtime.stop();
});

test('runtimeReady=true permite agir', async () => {
  const h = harness({ runtimeReady: true, creatures: [{ id: 7, name: 'Rattata', type: 1,
    healthPercent: 100, canAttack: true, pos: { x: 101, y: 100, z: 7 } }] });
  h.runtime.start();
  const result = await h.runtime.tick();
  assert.notEqual(result.status, 'blocked');
  assert.ok(h.sent.length >= 1, 'deve despachar no mundo');
  h.runtime.stop();
});

test('DLL antiga (campo ausente) continua funcionando', async () => {
  // Sem runtimeReady no payload: NAO pode bloquear. Bloquear por ausencia
  // inutilizaria todas as DLLs anteriores a este campo.
  const h = harness({ creatures: [{ id: 7, name: 'Rattata', type: 1,
    healthPercent: 100, canAttack: true, pos: { x: 101, y: 100, z: 7 } }] });
  assert.equal(h.session.snapshot().runtimeReady, undefined);
  h.runtime.start();
  const result = await h.runtime.tick();
  assert.notEqual(result.reason, 'runtime-not-ready');
  h.runtime.stop();
});

test('decode rejeita runtimeReady nao-booleano', () => {
  assert.throws(() => decodeTelemetry(Buffer.from(JSON.stringify(doc({ runtimeReady: 0 })))),
    /Prontidão do runtime/);
  assert.throws(() => decodeTelemetry(Buffer.from(JSON.stringify(doc({ runtimeReady: 'true' })))),
    /Prontidão do runtime/);
  assert.equal(decodeTelemetry(Buffer.from(JSON.stringify(doc({ runtimeReady: false })))).runtimeReady, false);
});
