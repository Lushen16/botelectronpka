'use strict';

/**
 * Contratos do DynamicLure.
 *
 * Todos os tempos e deltas vem da captura real do Shiba em hunt ativa
 * (PID 17748, 6.616 frames dynamic, checkpoint adendo 14):
 *
 *   travel     3672 ms mediana   dx∈[-3..3] dy∈[-5..5]
 *   arc          32 ms mediana   dx∈[-1..2] dy∈[-1..1]
 *   stationary  234 ms mediana   delta 0
 *   wait       1406 ms mediana
 *
 *   transicoes: travel<->arc 28/27, travel<->stationary 11/11, travel<->wait 2/3
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { DynamicLure, LURE_PHASE, MEASURED_MS, chebyshev } = require('../engines/dynamic-lure.cjs');

const CONFIG = {
  luring: { enabled: false, frontEnabled: true },
  hoenn: { minWildsToEngage: 8, bestTileRange: 4, perfectLureTimeoutMs: 10000, perfectLureMinHp: 30 },
};

const CENTER = { x: 100, y: 100, z: 7 };

/** Cria N selvagens a uma distancia Chebyshev `dist` do centro. */
function wilds(n, dist = 2) {
  return Array.from({ length: n }, (_, i) => ({
    id: 1000 + i, name: 'Geodude', canAttack: true, healthPercent: 100,
    pos: { x: CENTER.x + dist, y: CENTER.y + (i % 2), z: 7 },
  }));
}

function telemetry(creatures = wilds(3), hp = 100) {
  return { position: CENTER, ownPokemon: { pos: CENTER, healthPercent: hp }, creatures };
}

test('lure desligado: fase OFF e nenhuma acao', () => {
  const lure = new DynamicLure({ luring: { enabled: false, frontEnabled: false } });
  const r = lure.decide(telemetry(), { now: 1000 });
  assert.equal(r.phase, LURE_PHASE.OFF);
  assert.equal(r.action, 'none');
});

test('sem monstros: continua a rota (travel)', () => {
  const lure = new DynamicLure(CONFIG);
  const r = lure.decide(telemetry([]), { now: 1000 });
  assert.equal(r.phase, LURE_PHASE.TRAVEL);
  assert.equal(r.action, 'walk-route');
});

test('formacao fechada (>= minWilds na box): libera o combo', () => {
  const lure = new DynamicLure(CONFIG);
  const full = wilds(8, 2);
  const r = lure.decide(telemetry(full), { now: 1000 });
  assert.equal(r.action, 'release');
  assert.equal(r.boxed, 8);
  assert.match(r.reason, /formacao fechada/);
});

test('monstros fora do alcance NAO contam para a box', () => {
  const lure = new DynamicLure(CONFIG);
  // 8 selvagens, mas a distancia 10 (range=4 -> nenhum na box)
  const r = lure.decide(telemetry(wilds(8, 10), 100), { now: 1000 });
  assert.equal(r.boxed, 0);
  assert.notEqual(r.action, 'release');
});

test('hp do tank abaixo do limite libera mesmo sem formacao', () => {
  const lure = new DynamicLure(CONFIG);
  const r = lure.decide(telemetry(wilds(2, 2), 20), { now: 1000 });
  assert.equal(r.action, 'release');
  assert.match(r.reason, /hp do tank/);
});

test('timeout de formacao libera (perfectLureTimeoutMs)', () => {
  const lure = new DynamicLure(CONFIG);
  const t0 = 100000;
  lure.decide(telemetry(wilds(3, 2)), { now: t0 });          // entra em ajuste
  const r = lure.decide(telemetry(wilds(3, 2)), { now: t0 + 10001 });
  assert.equal(r.action, 'release');
  assert.match(r.reason, /timeout/);
});

test('pulso arc dura ~40ms e depois avanca de fase', () => {
  const lure = new DynamicLure(CONFIG);
  const t0 = 5000;
  const first = lure.decide(telemetry(wilds(3, 2)), { now: t0 });
  assert.equal(first.phase, LURE_PHASE.ARC, 'primeiro pulso e arc (medido: 28x travel->arc)');

  // dentro da janela: segura
  const held = lure.decide(telemetry(wilds(3, 2)), { now: t0 + MEASURED_MS.arc - 10 });
  assert.equal(held.phase, LURE_PHASE.ARC);
  assert.equal(held.action, 'hold');

  // passou da janela: muda de fase
  const next = lure.decide(telemetry(wilds(4, 2)), { now: t0 + MEASURED_MS.arc + 1 });
  assert.notEqual(next.phase, LURE_PHASE.ARC);
});

test('sem progresso por frontRegroupSteps volta a andar a rota', () => {
  const lure = new DynamicLure({ ...CONFIG, luring: { enabled: true, frontEnabled: true, frontRegroupSteps: 3 } });
  let now = 10000;
  const stuck = () => telemetry(wilds(2, 2)); // sempre 2 na box, nunca cresce
  let r = lure.decide(stuck(), { now });
  for (let i = 0; i < 8; i++) {
    now += 300; // avanca o suficiente para sair de qualquer pulso
    r = lure.decide(stuck(), { now });
    if (r.action === 'walk-route') break;
  }
  assert.equal(r.action, 'walk-route', 'sem progresso ele volta para a rota, nao trava agrupando');
  assert.match(r.reason, /sem progresso/);
});

test('progresso reseta o contador de estagnacao', () => {
  const lure = new DynamicLure({ ...CONFIG, luring: { enabled: true, frontEnabled: true, frontRegroupSteps: 1 } });
  let now = 20000;
  lure.decide(telemetry(wilds(2, 2)), { now });
  now += 300;
  lure.decide(telemetry(wilds(3, 2)), { now }); // progresso: 3 na box
  now += 300;
  const r = lure.decide(telemetry(wilds(4, 2)), { now }); // mais progresso
  assert.notEqual(r.action, 'walk-route');
});

test('chebyshev: usa o maior eixo e z diferente e infinito', () => {
  assert.equal(chebyshev({ x: 0, y: 0, z: 7 }, { x: 3, y: 1, z: 7 }), 3);
  assert.equal(chebyshev({ x: 0, y: 0, z: 7 }, { x: 1, y: 1, z: 7 }), 1);
  assert.equal(chebyshev({ x: 0, y: 0, z: 7 }, { x: 1, y: 1, z: 6 }), Infinity);
});

test('as duracoes usadas sao as medidas na captura', () => {
  // Trava os numeros: se alguem mudar sem medir, o teste avisa.
  assert.equal(MEASURED_MS.arc, 40);
  assert.equal(MEASURED_MS.stationary, 240);
  assert.equal(MEASURED_MS.wait, 1400);
});
