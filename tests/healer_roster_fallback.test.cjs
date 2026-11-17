'use strict';

/**
 * Healer com roster VAZIO — regressao do bug de 2026-11-12.
 *
 * CONTEXTO: nossa `pka_native.dll` publica `roster: []` (hardcoded). O healer
 * exigia `rosterMatches()` em modo nativo, entao travava em
 * `heal-pokemon-unresolved` e NUNCA curava. O fallback por `ownPokemon` so'
 * existia com `keyboardOnly`, que nao e' o modo de producao.
 *
 * Estes testes travam o comportamento novo:
 *   - roster vazio + Pokemon ativo compativel  -> CURA
 *   - roster vazio + Pokemon ativo incompativel -> NAO cura (evita curar errado)
 *   - roster valido                             -> CURA (caminho original intacto)
 *   - sem nome configurado + roster vazio       -> cura o ativo
 *   - HP saudavel                               -> nao faz nada
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createHealerEngine } = require(path.join(__dirname, '..', 'reconstruction', 'engines', 'healer-engine.cjs'));

const CFG = {
  healer: {
    enabled: true, healHpPercent: 50, healPokemonName: 'Dugtrio',
    healMoveSlot: 5, healResetSlot: 1,
  },
};

function run(telemetry, config = CFG) {
  const emitted = [];
  const engine = createHealerEngine(config, { keyboardOnly: false });
  const result = engine.step(telemetry, { command: (n, p) => emitted.push([n, p]) }, Date.now());
  return { result, emitted };
}

test('roster vazio + Pokemon ativo compativel: healer CURA', () => {
  const { result, emitted } = run({
    healthPercent: 40,
    ownPokemon: { id: 1, name: 'Dugtrio', healthPercent: 30 },
    roster: [],
    pokemonName: 'Dugtrio',
  });
  assert.equal(result.action, 'heal');
  assert.deepEqual(emitted, [['talk', 'm5']],
    'deve curar pelo slot configurado');
  assert.deepEqual(result.blocked, [], 'nao pode bloquear com o ativo valido');
});

test('roster vazio + Pokemon ativo INCOMPATIVEL: nao cura', () => {
  const { result, emitted } = run({
    healthPercent: 40,
    ownPokemon: { id: 1, name: 'Squirtle', healthPercent: 30 },
    roster: [],
    pokemonName: 'Squirtle',
  });
  assert.equal(result.action, 'idle', 'nao pode curar o Pokemon errado');
  assert.deepEqual(emitted, []);
  assert.ok(result.blocked.includes('heal-pokemon-unresolved'));
});

test('roster valido continua funcionando', () => {
  const { result, emitted } = run({
    healthPercent: 40,
    ownPokemon: { id: 1, name: 'Outro', healthPercent: 100 },
    roster: [{ name: 'Dugtrio', uuid: 'u1', healthPercent: 30 }],
    pokemonName: 'Outro',
  });
  assert.equal(result.action, 'heal');
  assert.deepEqual(emitted, [['talk', 'm5']]);
});

test('sem healPokemonName configurado + roster vazio: cura o ativo', () => {
  const { result, emitted } = run(
    { healthPercent: 40, ownPokemon: { name: 'Qualquer' }, roster: [], pokemonName: 'Qualquer' },
    { healer: { enabled: true, healHpPercent: 50, healMoveSlot: 5 } },
  );
  assert.equal(result.action, 'heal');
  assert.deepEqual(emitted, [['talk', 'm5']]);
});

test('HP saudavel: healer nao age', () => {
  const { result, emitted } = run({
    healthPercent: 100,
    ownPokemon: { name: 'Dugtrio', healthPercent: 100 },
    roster: [],
    pokemonName: 'Dugtrio',
  });
  assert.equal(result.action, 'idle');
  assert.deepEqual(emitted, []);
});

test('roster vazio sem ownPokemon: bloqueia (nao inventa identidade)', () => {
  const { result, emitted } = run({
    healthPercent: 40,
    ownPokemon: null,
    roster: [],
    pokemonName: '',
  });
  assert.equal(result.action, 'idle');
  assert.deepEqual(emitted, []);
  assert.ok(result.blocked.includes('heal-pokemon-unresolved'));
});
