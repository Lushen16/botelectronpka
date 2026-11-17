'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StateArbiter, BOT_STATES } = require('../core/state-arbiter.cjs');
const { CombatEngine } = require('../engines/combat-engine.cjs');
const { WalkerEngine } = require('../engines/walker-engine.cjs');

test('StateArbiter: Walker cede prioridade ao Combat quando monstros estão no alcance', () => {
  const config = {
    target: { enabled: true, lowHpComboPercent: 20 },
    walker: { enabled: true },
    healer: { enabled: true, healHpPercent: 15 },
  };

  const arbiter = new StateArbiter(config);
  const telemetry = {
    healthPercent: 100,
    ownPokemon: { healthPercent: 100 },
    position: { x: 100, y: 100, z: 7 },
  };

  // Sem monstros: Walker deve andar
  let state = arbiter.evaluate(telemetry, { inCombat: false, validTargets: [], isLureReady: false });
  assert.equal(state, BOT_STATES.WALKING);

  // Monstros detectados e prontos para engajamento: Combate deve assumir
  state = arbiter.evaluate(telemetry, {
    inCombat: true,
    validTargets: [{ id: 1234, name: 'Pikachu', healthPercent: 100, pos: { x: 102, y: 100, z: 7 } }],
    isLureReady: true,
  });
  assert.equal(state, BOT_STATES.COMBAT);

  // Em combate, monstros ainda vivos: Healer NÃO deve roubar prioridade a menos que seja emergência
  state = arbiter.evaluate(
    { ...telemetry, healthPercent: 70, ownPokemon: { healthPercent: 50 } },
    { inCombat: true, validTargets: [{ id: 1234 }], isLureReady: true }
  );
  assert.equal(state, BOT_STATES.COMBAT);

  // Emergência crítica de vida (HP <= 20%): Healer assume
  state = arbiter.evaluate(
    { ...telemetry, healthPercent: 15 },
    { inCombat: true, validTargets: [{ id: 1234 }], isLureReady: true }
  );
  assert.equal(state, BOT_STATES.HEALING);
});

test('CombatEngine: Seleciona alvos sem projetar coordenadas de mouse e filtra ignorados', () => {
  const config = {
    target: {
      enabled: true,
      maxDistance: 8,
      ignoredCreaturesText: 'Caterpie, Weedle',
      shinyPriorityEnabled: true,
    },
  };

  const combat = new CombatEngine(config);
  const telemetry = {
    position: { x: 100, y: 100, z: 7 },
    ownPokemon: { id: 999 },
    creatures: [
      { id: 999, name: 'Diglett', canAttack: true, isOwnPokemon: true, healthPercent: 100, pos: { x: 100, y: 101, z: 7 } },
      { id: 1001, name: 'Caterpie', canAttack: true, healthPercent: 100, pos: { x: 101, y: 100, z: 7 } },
      { id: 1002, name: 'Patt', canAttack: true, healthPercent: 100, pos: { x: 102, y: 100, z: 7 } },
      { id: 1003, name: 'Shiny Rattata', canAttack: true, healthPercent: 100, pos: { x: 103, y: 100, z: 7 } },
    ],
  };

  const targets = combat.filterValidTargets(telemetry);
  // Deve excluir pet (999) e Caterpie ignorado
  assert.equal(targets.length, 2);
  assert.ok(targets.some(t => t.id === 1002));
  assert.ok(targets.some(t => t.id === 1003));

  // Prioridade para Shiny
  const selected = combat.selectTarget(telemetry, targets);
  assert.equal(selected.id, 1003);
  assert.equal(selected.name, 'Shiny Rattata');
});

/**
 * Regressao do criterio de disparo do combate.
 *
 * MEDIDO no Shiba (37.702 kind6 de sessao real, checkpoint adendo 10):
 *   count >= minCount  -> MOVING 1.882 frames | GROUPING 233
 *   luring.holding     -> GROUPING 855/856 (99,9%)
 *
 * Ou seja: contagem NAO dispara combate; formacao fechada dispara.
 * Estes testes travam o comportamento para nao voltar ao criterio antigo.
 */
test('StateArbiter: contagem de lure sozinha NAO dispara combate', () => {
  const arbiter = new StateArbiter({
    target: { lowHpComboPercent: 20 },
    walker: { enabled: true },
    healer: { enabled: true, healHpPercent: 15 },
  });
  const telemetry = { healthPercent: 100, ownPokemon: { healthPercent: 100 } };
  const targets = Array.from({ length: 10 }, (_, i) => ({ id: 1000 + i }));

  // 10 monstros e isLureReady=true, mas a formacao NAO fechou:
  // o Shiba continua andando. O nosso tambem tem que continuar.
  const state = arbiter.evaluate(telemetry, {
    inCombat: false,
    validTargets: targets,
    isLureReady: true,
    isFormationHeld: false,
  });
  assert.notEqual(state, BOT_STATES.COMBAT,
    'isLureReady sozinho nao pode disparar combate (medido: ele anda em 89%)');
  assert.equal(state, BOT_STATES.LURING);
});

test('StateArbiter: formacao fechada dispara combate mesmo com poucos monstros', () => {
  const arbiter = new StateArbiter({
    target: { lowHpComboPercent: 20 },
    walker: { enabled: true },
    healer: { enabled: true, healHpPercent: 15 },
  });
  const telemetry = { healthPercent: 100, ownPokemon: { healthPercent: 100 } };

  // 3 monstros na box fechada: o Shiba para. Contagem abaixo do minCount
  // nao importa — o que importa e' quem colou.
  const state = arbiter.evaluate(telemetry, {
    inCombat: false,
    validTargets: [{ id: 1 }, { id: 2 }, { id: 3 }],
    isLureReady: false,
    isFormationHeld: true,
  });
  assert.equal(state, BOT_STATES.COMBAT);
});

test('StateArbiter: sem isFormationHeld informado, mantem ordem sem quebrar', () => {
  // Compatibilidade: chamadores antigos nao passam isFormationHeld.
  // Nesse caso o combate so' dispara por inCombat explicito.
  const arbiter = new StateArbiter({
    target: { lowHpComboPercent: 20 },
    walker: { enabled: true },
    healer: { enabled: true, healHpPercent: 15 },
  });
  const telemetry = { healthPercent: 100, ownPokemon: { healthPercent: 100 } };

  const semFormacao = arbiter.evaluate(telemetry, {
    inCombat: false, validTargets: [{ id: 1 }], isLureReady: true,
  });
  assert.equal(semFormacao, BOT_STATES.LURING);

  const engajado = arbiter.evaluate(telemetry, {
    inCombat: true, validTargets: [{ id: 1 }], isLureReady: false,
  });
  assert.equal(engajado, BOT_STATES.COMBAT);
});

test('StateArbiter: formacao fechada SEM lista de alvos ainda dispara combate', () => {
  // MEDIDO (PID 17748): 908 frames em que o Shiba estava em "Best Tile 8/8"
  // (formacao fechada) mas o payload nao trazia a contagem em luring.count.
  // Formacao fechada IMPLICA que ha monstros; exigir a lista junto descartava
  // esses frames e fazia o nosso arbitro andar enquanto ele atacava.
  const arbiter = new StateArbiter({
    target: { lowHpComboPercent: 20 },
    walker: { enabled: true },
    healer: { enabled: true, healHpPercent: 15 },
  });
  const state = arbiter.evaluate(
    { healthPercent: 100, ownPokemon: { healthPercent: 100 } },
    { inCombat: false, validTargets: [], isLureReady: false, isFormationHeld: true },
  );
  assert.equal(state, BOT_STATES.COMBAT,
    'formacao fechada sem lista ainda e combate');
});

test('StateArbiter: inCombat sem alvos NAO forca combate', () => {
  // O caminho `inCombat` continua exigindo monstros: sem alvo nao ha o que
  // atacar, mesmo com o motor dizendo "engajado".
  const arbiter = new StateArbiter({
    target: { lowHpComboPercent: 20 },
    walker: { enabled: true },
    healer: { enabled: true, healHpPercent: 15 },
  });
  const state = arbiter.evaluate(
    { healthPercent: 100, ownPokemon: { healthPercent: 100 } },
    { inCombat: true, validTargets: [], isLureReady: false, isFormationHeld: false },
  );
  assert.equal(state, BOT_STATES.WALKING);
});
