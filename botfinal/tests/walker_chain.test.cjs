'use strict';

/**
 * Teste B — cadeia do WalkerEngine ate o despacho.
 *
 *   node --test botfinal/tests/walker_chain.test.cjs
 *
 * O que estes testes provam: dada uma configuracao e uma posicao lida, o
 * WalkerEngine escolhe a direcao, o BotRuntime orquestra, o StateArbiter
 * decide o estado e o CommandDispatcher despacha o comando certo.
 *
 * O que eles NAO provam: que o cliente executa. Isso exige o teste no jogo.
 * Aqui o transporte e' falso; nenhum frame sai.
 *
 * A diferenca em relacao ao teste A: ali o script escolhe a direcao e chama o
 * dispatcher direto. Aqui a direcao NASCE do motor. Se o motor estiver errado,
 * o comando sai errado mesmo com o transporte funcionando.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { BotRuntime } = require(path.join(__dirname, '..', 'core', 'bot-runtime.cjs'));
const { WalkerEngine } = require(path.join(__dirname, '..', 'engines', 'walker-engine.cjs'));
const { StateArbiter } = require(path.join(__dirname, '..', 'core', 'state-arbiter.cjs'));
const { CommandDispatcher } = require(path.join(__dirname, '..', 'core', 'command-dispatcher.cjs'));
const { NativeSession } = require(path.join(__dirname, '..', 'core', 'native-session.cjs'));

function stateBytes({ online = 1, health = 100 } = {}) {
  const b = Buffer.alloc(48);
  b.writeUInt32LE(1, 0);
  b.writeUInt32LE(online, 4);
  b.writeUInt32LE(health, 8);
  b.writeDoubleLE(1, 12);
  b.writeDoubleLE(1, 20);
  b.writeDoubleLE(1, 28);
  return b;
}

function telemetryDoc(pos) {
  return {
    schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1,
    fightMode: 0, chaseMode: 0, clockMs: 0, position: { ...pos },
    activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'X',
    comboPokemonName: 'X', conditionEvents: true, conditionsKnown: true,
    conditions: [], roster: [], creatures: [], items: [], tiles: [],
  };
}

/** Monta a cadeia completa com transporte falso. */
function harness({ position = { x: 100, y: 100, z: 7 }, waypoints, config = {} } = {}) {
  let clock = 1000;
  const sent = [];
  const transport = new EventEmitter();
  transport.sendCommand = async (name, parameter) => {
    sent.push({ name, parameter });
    return { commandId: sent.length, type: 1, status: 0 };
  };
  const session = new NativeSession({ pid: 1, now: () => clock });
  session.attach(transport);
  transport.emit('state', stateBytes());
  transport.emit('telemetry', Buffer.from(JSON.stringify(telemetryDoc(position))));

  const dispatcher = new CommandDispatcher({ transport, session, now: () => clock });
  const cfg = {
    target: { enabled: false, monsters: [], combo: { enabled: false } },
    healer: { enabled: false },
    walker: { enabled: true, smartWalking: true, waypoints: waypoints || [] },
    hoenn: { minWildsToEngage: 0, perfectLure: false },
    ...config,
  };
  const walker = new WalkerEngine(cfg);
  const arbiter = new StateArbiter(cfg);
  const runtime = new BotRuntime({
    session, transport, config: cfg, walker, arbiter, dispatcher,
    combat: { filterValidTargets: () => [], isLureConditionMet: () => false,
      targetId: null, tick: async () => ({ status: 'idle' }) },
    healer: { tick: async () => ({ status: 'idle' }) },
    tickMs: 40,
  });
  return { runtime, dispatcher, sent, cfg, walker, arbiter, session, tick: ms => { clock += ms; } };
}

const DIRECTIONS = { north: 0, east: 1, south: 2, west: 3 };

test('norte: o motor despacha walk 0', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 100, y: 99, z: 7 }, param: '' }] });
  h.runtime.start();
  await new Promise(r => setTimeout(r, 350));
  h.runtime.stop();
  assert.ok(h.sent.length > 0, 'o motor precisa despachar');
  assert.deepEqual([...new Set(h.sent.map(s => s.name))], ['walk']);
  assert.deepEqual([...new Set(h.sent.map(s => s.parameter))], [0]);
  assert.equal(h.runtime.state.state, 'WALKING');
});

test('leste: o motor despacha walk 1', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 101, y: 100, z: 7 }, param: '' }] });
  h.runtime.start();
  await new Promise(r => setTimeout(r, 350));
  h.runtime.stop();
  assert.ok(h.sent.length > 0);
  assert.deepEqual([...new Set(h.sent.map(s => s.parameter))], [1]);
});

test('sul: o motor despacha walk 2', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 100, y: 101, z: 7 }, param: '' }] });
  h.runtime.start();
  await new Promise(r => setTimeout(r, 350));
  h.runtime.stop();
  assert.ok(h.sent.length > 0);
  assert.deepEqual([...new Set(h.sent.map(s => s.parameter))], [2]);
});

test('oeste: o motor despacha walk 3', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 99, y: 100, z: 7 }, param: '' }] });
  h.runtime.start();
  await new Promise(r => setTimeout(r, 350));
  h.runtime.stop();
  assert.ok(h.sent.length > 0);
  assert.deepEqual([...new Set(h.sent.map(s => s.parameter))], [3]);
});

test('waypoint no mesmo tile nao despacha movimento', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 100, y: 100, z: 7 }, param: '' }] });
  h.runtime.start();
  await new Promise(r => setTimeout(r, 300));
  h.runtime.stop();
  assert.equal(h.sent.length, 0, 'ja esta no waypoint: nao deve andar');
});

test('waypoint em outro andar e pulado, sem comando', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 100, y: 99, z: 9 }, param: '' }] });
  h.runtime.start();
  await new Promise(r => setTimeout(r, 300));
  h.runtime.stop();
  assert.equal(h.sent.length, 0, 'z diferente: o motor nao deve tentar');
});

test('stop do runtime interrompe novos despachos', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 100, y: 90, z: 7 }, param: '' }] });
  h.runtime.start();
  await new Promise(r => setTimeout(r, 300));
  const beforeStop = h.sent.length;
  assert.ok(beforeStop > 0, 'produtor precisa estar ativo');
  h.runtime.stop();
  await h.runtime.pause();
  const atStop = h.sent.length;
  await new Promise(r => setTimeout(r, 400));
  assert.equal(h.sent.length, atStop, 'nenhum comando novo depois do stop');
});

test('snapshot stale bloqueia o motor em vez de andar as cegas', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 100, y: 99, z: 7 }, param: '' }] });
  h.tick(10000); // envelhece state/telemetry
  h.runtime.start();
  await new Promise(r => setTimeout(r, 300));
  h.runtime.stop();
  assert.equal(h.sent.length, 0, 'snapshot velho nao pode gerar comando');
});

test('cadencia: o motor nao despacha mais rapido que 280ms', async () => {
  const h = harness({ position: { x: 100, y: 100, z: 7 },
    waypoints: [{ action: 'walk', pos: { x: 100, y: 90, z: 7 }, param: '' }] });
  h.runtime.start();
  await new Promise(r => setTimeout(r, 700));
  h.runtime.stop();
  /* Em ~700ms, com cadencia de 280ms e tick de 40ms, cabem no maximo 3. */
  assert.ok(h.sent.length <= 3,
    'despachou ' + h.sent.length + ' em 700ms; cadencia de 280ms deveria limitar');
  assert.ok(h.sent.length >= 1, 'deveria despachar ao menos um');
});
