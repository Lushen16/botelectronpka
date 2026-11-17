'use strict';

/**
 * Amostras de posicao ATRASADAS, FORA DE ORDEM, REPETIDAS e SEM TICK.
 *
 * O defeito original (medido 2026-11-14, registrado em AGENTS.md): a guarda
 * comparava `telemetry.tick === state.lastMoveTick` — IGUALDADE. So' barrava a
 * amostra repetida; atrasada e fora de ordem passavam e o motor despachava
 * outro passo para a MESMA posicao (o personagem andava dois tiles para um
 * alvo de um). Sem tick nao havia guarda nenhuma.
 *
 * A regra correta e' de ORDEM: so' amostra com tick ESTRITAMENTE maior que o
 * do despacho confirma ou nega o passo.
 *
 * Este arquivo existe separado de engines.test.cjs porque cada caso aqui e'
 * uma leitura que o cliente REALMENTE produz (o walker RPM le a memoria a cada
 * ~100 ms e a posicao chega com defasagem; ver walker_input_runtime.test.cjs).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWalkerEngine, STUCK_LIMIT, PROGRESS_TIMEOUT_MS, TICK_RESET_MIN }
  = require('../reconstruction/engines/walker-engine.cjs');
const { DIRECTIONS } = require('../reconstruction/engines/shared.cjs');

/* `stepIntervalMs: 0`: aqui interessa a ordenacao das amostras, nao a
 * cadencia. Os passos sao forcados a sair no mesmo tick logico em varios
 * casos, o que o piso de 406 ms barraria. */
const engineAt = (x, waypoint = { x: 104, y: 100, z: 7 }) => createWalkerEngine({
  walker: { loop: false, stepIntervalMs: 0, waypoints: [{ action: 'walk', pos: waypoint }] },
});

const recorder = () => {
  const events = [];
  return { events, command: (name, parameter) => events.push([name, parameter]) };
};

const at = (x, extra = {}) => ({ position: { x, y: 100, z: 7 }, ...extra });

/** Despacha o primeiro passo e devolve o motor ja' com um passo em voo. */
function dispatched() {
  const engine = engineAt(100);
  const sink = recorder();
  assert.equal(engine.step(at(100, { tick: 10, playerId: 1 }), sink, 0).action, 'move');
  return { engine, sink };
}

test('amostra repetida nao gera segundo passo', () => {
  const { engine, sink } = dispatched();
  for (let now = 100; now <= 700; now += 100) {
    assert.equal(engine.step(at(100, { tick: 10, playerId: 1 }), sink, now).reason,
      'await-position-sample');
  }
  assert.deepEqual(sink.events, [['walk', DIRECTIONS.east]]);
});

test('amostra ATRASADA (tick menor) nao gera segundo passo', () => {
  const { engine, sink } = dispatched();
  for (const tick of [9, 9, 9]) {
    assert.equal(engine.step(at(100, { tick, playerId: 1 }), sink, 100).reason,
      'await-position-sample');
  }
  assert.deepEqual(sink.events, [['walk', DIRECTIONS.east]]);
});

test('amostra FORA DE ORDEM (12 depois 11) nao gera passo extra', () => {
  const { engine, sink } = dispatched();
  assert.equal(engine.step(at(100, { tick: 12, playerId: 1 }), sink, 100).reason,
    'await-position-sample');
  assert.equal(engine.step(at(100, { tick: 11, playerId: 1 }), sink, 200).reason,
    'await-position-sample');
  assert.deepEqual(sink.events, [['walk', DIRECTIONS.east]]);
  /* E a amostra realmente nova volta a valer: 13 confirma o tile 101. */
  assert.equal(engine.step(at(101, { tick: 13, playerId: 1 }), sink, 300).action, 'move');
  assert.deepEqual(sink.events.at(-1), ['walk', DIRECTIONS.east]);
});

test('amostra atrasada nao confirma chegada ao tile do passo', () => {
  const { engine, sink } = dispatched();
  /* 101 e' o alvo do passo, mas o tick e' anterior ao despacho. */
  const stale = engine.step(at(101, { tick: 9, playerId: 1 }), sink, 100);
  assert.equal(stale.action, 'hold');
  assert.equal(stale.reason, 'await-position-sample');
  assert.deepEqual(sink.events, [['walk', DIRECTIONS.east]]);
});

test('sem tick: um passo por amostra e travamento detectado por tentativas', () => {
  const engine = engineAt(100);
  const sink = recorder();
  let now = 0;
  const reasons = [];
  /* 2 tiles de distancia, posicao congelada: o motor despacha por amostra
   * (sem tick nao ha ordem para esperar) e desiste em STALL_LIMIT. */
  for (let index = 0; index < 6; index += 1) {
    const result = engine.step(at(100), sink, now);
    reasons.push(result.action);
    now += 100;
  }
  assert.deepEqual(reasons, Array(6).fill('move'));
  /* Cada despacho a partir do mesmo tile conta como tentativa sem progresso. */
  assert.ok(sink.events.length >= STUCK_LIMIT);
  assert.equal(sink.events.at(-1)[0], 'walk');
  assert.equal(engine.step(at(100), sink, now).action, 'done');
});

test('queda grande de tick e reinicio da telemetria, nao espera o prazo', () => {
  const { engine, sink } = dispatched();
  const reset = engine.step(at(101, { tick: 10 - TICK_RESET_MIN, playerId: 1 }), sink, 100);
  /* Posicao 101 e' o alvo do passo pendente: com o contador reiniciado o
   * pendente e' descartado e a amostra vale — o motor despacha o proximo
   * passo em vez de ficar 2500 ms em hold. */
  assert.equal(reset.action, 'move');
  assert.equal(reset.reconciled, undefined);
  assert.deepEqual(sink.events.at(-1), ['walk', DIRECTIONS.east]);
});

test('reinicio de tick na origem nao repete o passo no mesmo tick', () => {
  const engine = engineAt(100);
  const sink = recorder();
  assert.equal(engine.step(at(100, { tick: 2000, playerId: 1 }), sink, 0).action, 'move');
  /* Telemetria reiniciou e a posicao ainda e' a origem: o pendente cai e o
   * motor NAO repete o passo neste tick. */
  const reset = engine.step(at(100, { tick: 1, playerId: 1 }), sink, 100);
  assert.equal(reset.action, 'hold');
  assert.equal(reset.reason, 'await-position-sample');
  assert.deepEqual(sink.events, [['walk', DIRECTIONS.east]]);
  /* No tick seguinte a posicao ainda e' a origem: agora despacha. */
  assert.equal(engine.step(at(100, { tick: 2, playerId: 1 }), sink, 200).action, 'move');
});

test('troca de personagem durante o passo aborta e recalcula no mesmo tick', () => {
  const { engine, sink } = dispatched();
  const changed = engine.step(at(100, { tick: 11, playerId: 2 }), sink, 100);
  assert.equal(changed.action, 'move');
  assert.equal(changed.reconciled, 'entity-changed');
  assert.deepEqual(sink.events.at(-1), ['walk', DIRECTIONS.east]);
});

test('deslocamento inesperado recalcula a rota no mesmo tick', () => {
  const { engine, sink } = dispatched();
  /* Nem origem (100) nem alvo do passo (101): algo moveu o personagem. */
  const pushed = engine.step({ position: { x: 100, y: 103, z: 7 }, tick: 11, playerId: 1 }, sink, 100);
  assert.equal(pushed.action, 'move');
  assert.equal(pushed.reconciled, 'unexpected-displacement');
  assert.deepEqual(sink.events.at(-1), ['walk', DIRECTIONS.northeast]);
});

test('mudanca de andar aborta e nao reinterpreta como chegada', () => {
  const { engine, sink } = dispatched();
  const floor = engine.step({ position: { x: 100, y: 100, z: 8 }, tick: 11, playerId: 1 }, sink, 100);
  assert.equal(floor.reconciled, 'floor-changed');
  assert.equal(floor.action, 'move');
  assert.equal(floor.emitted.length, 1);
});

test('passo sem confirmacao expira e conta tentativa, sem repetir o waypoint', () => {
  const { engine, sink } = dispatched();
  /* Amostra sempre na origem e prazo estourado: descarta o pendente. */
  const late = engine.step(at(100, { tick: 11, playerId: 1 }), sink, PROGRESS_TIMEOUT_MS + 1);
  assert.equal(late.action, 'move');
  assert.equal(engine.state.index, 0);
  assert.ok(sink.events.length >= 2);
});

test('a guarda de ordem nao trava a rota quando a posicao avanca', () => {
  const engine = engineAt(100, { x: 103, y: 100, z: 7 });
  const sink = recorder();
  assert.equal(engine.step(at(100, { tick: 10, playerId: 1 }), sink, 0).action, 'move');
  /* Tick repetido mostrando 101: nao confirma, mas tambem nao despacha. */
  assert.equal(engine.step(at(101, { tick: 10, playerId: 1 }), sink, 100).action, 'hold');
  /* Tick novo mostrando 101: confirma e despacha o proximo passo. */
  const next = engine.step(at(101, { tick: 11, playerId: 1 }), sink, 200);
  assert.equal(next.action, 'move');
  assert.equal(next.emitted.length, 1);
  assert.equal(sink.events.length, 2);
});
