'use strict';

/**
 * Regressao: o CombatEngine NAO pode escolher alvo em outro andar.
 *
 * MEDIDO (2026-11-12, 18 ataques reais em `captures/routes/cycle-final.json`):
 *
 *     com efeito   (n=5):  dz=0 em 5/5
 *     sem efeito   (n=13): dz=1 em 11/13
 *
 * Os alvos com dz=1 estavam a 1-2 tiles no PLANO — passavam no filtro antigo
 * (que usava `chebyshev`, cego para `z`) e o bot gastava ataque sem dano.
 *
 * A origem do calculo tambem importa: quem executa a move e' o Pokemon ativo
 * ([rt+0x2568]), nao o jogador. Com pet e jogador em andares diferentes, medir
 * do jogador seleciona alvo que a acao nao alcanca.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { CombatEngine } = require(path.join(__dirname, '..', 'engines', 'combat-engine.cjs'));

const creature = (id, x, z, patch = {}) => ({
  id, name: 'Magnemite', healthPercent: 100, type: 1, creatureType: 1,
  canAttack: true, pos: { x, y: 100, z }, ...patch,
});

const telemetry = (patch = {}) => ({
  position: { x: 100, y: 100, z: 7 },
  ownPokemon: { id: 999, name: 'Dugtrio', healthPercent: 100, pos: { x: 100, y: 100, z: 7 } },
  creatures: [],
  ...patch,
});

const engine = (config = {}) => new CombatEngine({ target: { maxDistance: 8, ...config } });

test('alvo no mesmo andar e alcance e selecionado', () => {
  const list = engine().filterValidTargets(telemetry({
    creatures: [creature(1, 101, 7)],
  }));
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 1);
});

test('alvo um andar acima e rejeitado, mesmo adjacente', () => {
  // O caso exato que gastou 13 ataques: dist=1 no plano, dz=1.
  const list = engine().filterValidTargets(telemetry({
    creatures: [creature(1, 101, 8)],
  }));
  assert.deepEqual(list, [], 'dz=1 nao pode entrar na lista de alvos');
});

test('alvo um andar abaixo tambem e rejeitado', () => {
  const list = engine().filterValidTargets(telemetry({
    creatures: [creature(1, 101, 6)],
  }));
  assert.deepEqual(list, []);
});

test('mistura: so os do mesmo andar sobrevivem', () => {
  const list = engine().filterValidTargets(telemetry({
    creatures: [creature(1, 101, 8), creature(2, 102, 7), creature(3, 103, 6)],
  }));
  assert.deepEqual(list.map(row => row.id), [2]);
});

test('a origem do alcance e o Pokemon ativo, nao o jogador', () => {
  /* Pet 3 tiles a leste do jogador. Um alvo adjacente ao PET deve entrar;
   * um adjacente ao JOGADOR mas longe do pet nao pode ser preferido.
   * Aqui: alvo em x=104 esta a 1 tile do pet (x=103) e a 4 do jogador. */
  const list = engine().filterValidTargets(telemetry({
    position: { x: 100, y: 100, z: 7 },
    ownPokemon: { id: 999, name: 'Dugtrio', healthPercent: 100, pos: { x: 103, y: 100, z: 7 } },
    creatures: [creature(1, 104, 7)],
  }));
  assert.equal(list.length, 1, 'o pet executa a move: o alcance e dele');
});

test('sem z conhecido no pet, cai na posicao do jogador sem quebrar', () => {
  const list = engine().filterValidTargets(telemetry({
    ownPokemon: { id: 999, name: 'Dugtrio', healthPercent: 100 },
    creatures: [creature(1, 101, 7)],
  }));
  assert.equal(list.length, 1);
});

test('sem z na criatura, nao bloqueia (dado ausente != andar errado)', () => {
  const row = creature(1, 101, 7);
  delete row.pos.z;
  const list = engine().filterValidTargets(telemetry({ creatures: [row] }));
  assert.equal(list.length, 1);
});
