'use strict';

/**
 * Contratos do adaptador kind6 -> entradas do arbiter, e da precedência do
 * Dynamic Lure.
 *
 * Todos os números aqui foram MEDIDOS numa hunt real do Shiba
 * (PID 17748, 45 MB de captura, checkpoint adendo 12). Estes testes travam os
 * três achados para não regredirem:
 *
 *   1. `core.phase` está desatualizado; a fonte é `phases.target`.
 *   2. `luring.count=0` com `mode=off` é dado AUSENTE, não zero monstros.
 *   3. Dynamic Lure (arc/stationary/wait) vence a fase do Target.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { adapt, countFromPhase } = require('../core/shiba-state-adapter.cjs');
const { StateArbiter, BOT_STATES } = require('../core/state-arbiter.cjs');

function makeArbiter() {
  return new StateArbiter({
    target: { lowHpComboPercent: 20 },
    walker: { enabled: true },
    healer: { enabled: true, healHpPercent: 15 },
  });
}

const TELEMETRY_OK = { healthPercent: 100, ownPokemon: { healthPercent: 100 } };

// ─────────────────────────────────────────────────────────── adaptador

test('adapter: le contagem "N/M" da fase do Target quando luring.count e zero', () => {
  // Caso real: lure off, Target em Best Tile com 8/8 na box
  const r = adapt({
    phase: 'Best Tile: posicionando Pokémon no centro da box 8/8',
    luring: { mode: 'off', count: 0, minCount: 0, holding: false, phase: 'off' },
    phases: {
      target: 'Best Tile: posicionando Pokémon no centro da box 8/8',
      walker: 'Walker: aguardando combate do Target · WP 1',
    },
  });
  assert.equal(r.observed.count, 8, 'contagem vem da fase, nao do luring zerado');
  assert.equal(r.observed.source, 'phases.target');
  assert.equal(r.inputs.isFormationHeld, true, 'Target em fase de combate = formacao fechada');
  assert.equal(r.observed.action, 'COMBAT');
});

test('adapter: luring.count vale quando o lure esta em dynamic', () => {
  const r = adapt({
    phase: 'Walker · WP 5/23 · walk',
    luring: { mode: 'dynamic', count: 6, minCount: 8, holding: false, phase: 'travel' },
    phases: { target: '', walker: 'Walker · WP 5/23 · walk' },
  });
  assert.equal(r.observed.count, 6);
  assert.equal(r.observed.source, 'luring');
  assert.equal(r.inputs.isFormationHeld, false);
  assert.equal(r.observed.action, 'MOVING');
});

test('adapter: Dynamic Lure parado NAO e combate, mesmo com Target em 8/8', () => {
  // Achado 3: 51 frames reais nessa combinacao
  const r = adapt({
    phase: 'Dynamic: aguardando aproximação do próprio Pokémon',
    luring: { mode: 'dynamic', count: 8, minCount: 8, holding: true, phase: 'stationary' },
    phases: {
      target: 'Perfect lure: 8/8 monstros na área do combo',
      walker: 'Walker: aguardando combate do Target · WP 1',
    },
  });
  assert.equal(r.inputs.isRepositioning, true);
  assert.equal(r.inputs.isFormationHeld, false,
    'reposicionamento nao fecha formacao: ele ainda esta posicionando');
  assert.equal(r.observed.action, 'GROUPING');
});

test('adapter: holding=true com lure dynamic e formacao', () => {
  const r = adapt({
    phase: 'Walker · WP 3/23 · walk',
    luring: { mode: 'dynamic', count: 7, minCount: 8, holding: true, phase: 'arc' },
    phases: { target: '', walker: 'Walker · WP 3/23 · walk' },
  });
  assert.equal(r.inputs.isRepositioning, true, 'arc e reposicionamento');
  assert.equal(r.observed.action, 'GROUPING');
});

test('adapter: revive vem de phases.target', () => {
  const r = adapt({
    phase: 'Revive: aguardando Pokémon recuperado',
    luring: { mode: 'off', count: 0, minCount: 0, holding: false, phase: 'off' },
    phases: { target: 'Revive: aguardando Pokémon recuperado', walker: '' },
  });
  assert.equal(r.inputs.isRevivePending, true);
  assert.equal(r.observed.action, 'REVIVING');
});

test('adapter: pausado e offline nao sao comparaveis', () => {
  const paused = adapt({ phase: 'Pausado', paused: false });
  assert.equal(paused.comparable, false);
  assert.equal(paused.observed.action, 'PAUSED');

  const offline = adapt({ phase: '', luring: { mode: 'off' } });
  assert.equal(offline.comparable, false);
  assert.equal(offline.observed.action, 'OFFLINE');
});

test('adapter: core.phase desatualizado NAO e usado como fonte', () => {
  // Caso real: core diz combat, mas o walker esta andando e target so procura
  const r = adapt({
    phase: 'Walker · WP 1/23 · walk',
    core: { movementOwner: 'target', phase: 'combat' },
    luring: { mode: 'off', count: 0, minCount: 0, holding: false, phase: 'off' },
    phases: { target: 'Target: procurando alvos', walker: 'Walker · WP 1/23 · walk' },
  });
  assert.equal(r.observed.action, 'MOVING',
    'core.phase=combat com target "procurando alvos" e walker andando = MOVING');
});

test('countFromPhase: le N/M e ignora quando nao ha numero', () => {
  assert.deepEqual(countFromPhase('Perfect lure: 7/9 monstros'), { n: 7, total: 9 });
  assert.deepEqual(countFromPhase('Best Tile: posicionando 8/8'), { n: 8, total: 8 });
  assert.equal(countFromPhase('Target: procurando alvos'), null);
  assert.equal(countFromPhase(''), null);
});

// ─────────────────────────────────────────────────────────── precedencia

test('arbiter: isRepositioning vence o combate (Dynamic Lure antes do combo)', () => {
  const arbiter = makeArbiter();
  const state = arbiter.evaluate(TELEMETRY_OK, {
    inCombat: false,
    validTargets: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 7 }, { id: 8 }],
    isLureReady: true,
    isFormationHeld: true,   // mesmo com formacao "fechada"...
    isRepositioning: true,   // ...o reposicionamento manda
  });
  assert.equal(state, BOT_STATES.LURING,
    'Dynamic Lure tem precedencia: fecha a box primeiro, ataca depois');
});

test('arbiter: emergencia de HP vence reposicionamento', () => {
  const arbiter = makeArbiter();
  const state = arbiter.evaluate(
    { healthPercent: 10, ownPokemon: { healthPercent: 10 } },
    { inCombat: false, validTargets: [{ id: 1 }], isLureReady: true,
      isFormationHeld: true, isRepositioning: true },
  );
  assert.equal(state, BOT_STATES.HEALING);
});

test('arbiter: revive vence reposicionamento', () => {
  const arbiter = makeArbiter();
  const state = arbiter.evaluate(TELEMETRY_OK, {
    inCombat: false, validTargets: [{ id: 1 }], isLureReady: false,
    isFormationHeld: false, isRepositioning: true, isRevivePending: true,
  });
  assert.equal(state, BOT_STATES.REVIVING);
});

test('integracao: adapt + arbiter reproduzem a decisao do Shiba nos 4 casos reais', () => {
  const cases = [
    {
      name: 'andando agrupando (travel, 6/8)',
      payload: {
        phase: 'Walker · WP 5/23 · walk',
        luring: { mode: 'dynamic', count: 6, minCount: 8, holding: false, phase: 'travel' },
        phases: { target: '', walker: 'Walker · WP 5/23 · walk' },
      },
      expected: BOT_STATES.LURING,
    },
    {
      name: 'Best Tile 8/8 com lure off',
      payload: {
        phase: 'Best Tile: posicionando Pokémon no centro da box 8/8',
        luring: { mode: 'off', count: 0, minCount: 0, holding: false, phase: 'off' },
        phases: { target: 'Best Tile: posicionando Pokémon no centro da box 8/8',
          walker: 'Walker: aguardando combate do Target · WP 1' },
      },
      expected: BOT_STATES.COMBAT,
    },
    {
      name: 'Dynamic stationary 8/8',
      payload: {
        phase: 'Dynamic: aguardando aproximação do próprio Pokémon',
        luring: { mode: 'dynamic', count: 8, minCount: 8, holding: true, phase: 'stationary' },
        phases: { target: 'Perfect lure: 8/8 monstros na área do combo',
          walker: 'Walker: aguardando combate do Target · WP 1' },
      },
      expected: BOT_STATES.LURING,
    },
    {
      name: 'revive',
      payload: {
        phase: 'Revive: aguardando Pokémon recuperado',
        luring: { mode: 'off', count: 0, minCount: 0, holding: false, phase: 'off' },
        phases: { target: 'Revive: aguardando Pokémon recuperado', walker: '' },
      },
      expected: BOT_STATES.REVIVING,
    },
  ];

  for (const c of cases) {
    const { inputs } = adapt(c.payload);
    const state = makeArbiter().evaluate(TELEMETRY_OK, inputs);
    assert.equal(state, c.expected, c.name);
  }
});
