'use strict';

/**
 * Regressao do healer de PRODUCAO (botfinal/engines/healer-engine.cjs).
 *
 * Contexto medido em 2026-11-12: com HP 20% e a config de producao, o healer
 * retornava `no-action-needed` e NAO emitia comando nenhum. O motor paralelo
 * do botfinal so' conhecia `healPokemonName`+`returnPokemonName` e
 * `potionItemId` (campo que nao existe na config real). `healMoveSlot` — o
 * canal que o Shiba usa (`talk mN`) — era ignorado.
 *
 * Estes testes travam os tres canais e o fallback sem foco.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { HealerEngine, ENV_STATUS, BAN_MS } = require(path.join(__dirname, '..', 'engines', 'healer-engine.cjs'));

const telemetry = (patch = {}) => ({
  healthPercent: 20,
  pokemonName: 'Dugtrio',
  ownPokemon: { name: 'Dugtrio', healthPercent: 20 },
  roster: [],
  conditions: [],
  ...patch,
});

function sink(statusFor = () => 0) {
  const sent = [];
  return {
    sent,
    transport: {
      async sendCommand(name, parameter) {
        sent.push({ name, parameter });
        return { status: statusFor(name, parameter) };
      },
    },
  };
}

const config = patch => ({
  healer: { enabled: true, healHpPercent: 60, healMoveSlot: 1, ...(patch.healer || {}) },
  hoenn: { ...(patch.hoenn || {}) },
});

test('cura pelo move nativo quando nao ha canal de item configurado', async () => {
  const engine = new HealerEngine(config({}));
  const { sent, transport } = sink();
  const result = await engine.tick(telemetry(), transport, true);
  assert.equal(result.status, 'heal');
  assert.deepEqual(sent, [{ name: 'talk', parameter: 'm1' }]);
});

test('prefere potion (hotkey medido do Shiba) e cai no move se a tecla for recusada sem foco', async () => {
  const engine = new HealerEngine(config({
    hoenn: { potionHpPercent: 60, potionHotkey: 'Alt+f', potionCooldownMs: 1500 },
  }));
  const { sent, transport } = sink(name => (name === 'hotkey' ? 5 : 0));
  const result = await engine.tick(telemetry(), transport, true);
  assert.deepEqual(sent.map(row => row.name), ['hotkey', 'talk']);
  assert.equal(result.status, 'heal');
  assert.ok(result.bans.includes('hotkey'), 'canal sem foco deve ser banido');
});

test('status 5 nao bane o canal nativo (talk) — sobe como erro em vez de silencio', async () => {
  const engine = new HealerEngine(config({
    healer: { healHpPercent: 60, healMoveSlot: 2 },
  }));
  const { sent, transport } = sink(() => 5);
  const result = await engine.tick(telemetry(), transport, true);
  assert.deepEqual(sent, [{ name: 'talk', parameter: 'm2' }]);
  assert.equal(result.status, 'error');
  assert.equal(result.detail.status, 5);
  assert.deepEqual(result.bans, [], 'talk e nativo: recusa e defeito, nao banimento');
});

test('reset desligado nao gera talk m0', async () => {
  const engine = new HealerEngine(config({
    healer: { healHpPercent: 60, healMoveSlot: 1, healResetSlot: 0 },
  }));
  const { sent, transport } = sink();
  await engine.tick(telemetry(), transport, true);
  await engine.tick(telemetry({ healthPercent: 100, ownPokemon: { healthPercent: 100 } }), transport, false);
  assert.ok(!sent.some(row => row.parameter === 'm0'), 'm0 nao existe: ' + JSON.stringify(sent));
});

test('emergencia do arbitro acima do limiar do healer ainda emite cura', async () => {
  // lowHpComboPercent (arbitro) = 20, healHpPercent = 10: sem o ajuste, o
  // motor base nao veria necessidade e o bot ficaria em HEALING mudo.
  const engine = new HealerEngine(config({ healer: { healHpPercent: 10, healMoveSlot: 1 } }));
  const { sent, transport } = sink();
  const result = await engine.tick(telemetry({ healthPercent: 15 }), transport, true);
  assert.equal(result.status, 'heal');
  assert.deepEqual(sent, [{ name: 'talk', parameter: 'm1' }]);
});

test('HP saudavel nao emite nada', async () => {
  const engine = new HealerEngine(config({}));
  const { sent, transport } = sink();
  const result = await engine.tick(telemetry({ healthPercent: 100, ownPokemon: { healthPercent: 100 } }), transport, false);
  assert.equal(result.status, 'idle');
  assert.deepEqual(sent, []);
});

test('healer desabilitado nao emite nada', async () => {
  const engine = new HealerEngine(config({ healer: { enabled: false } }));
  const { sent, transport } = sink();
  const result = await engine.tick(telemetry(), transport, true);
  assert.equal(result.status, 'disabled');
  assert.deepEqual(sent, []);
});

test('sem transporte recusa em vez de fingir sucesso', async () => {
  const engine = new HealerEngine(config({}));
  const result = await engine.tick(telemetry(), null, true);
  assert.equal(result.status, 'blocked');
  assert.equal(result.detail.reason, 'no-transport');
});

test('banimento expira depois de BAN_MS e o canal volta a ser usado', async () => {
  const engine = new HealerEngine(config({
    hoenn: { potionHpPercent: 60, potionHotkey: 'Alt+f' },
  }));
  const { transport } = sink(() => 5);
  await engine.tick(telemetry(), transport, true);
  assert.ok(engine.banned.has('hotkey'));
  // Forca expiracao sem dormir.
  engine.banned.set('hotkey', Date.now() - 1);
  engine.applyBans();
  assert.equal(engine.hoenn.potionHpPercent, 60, 'canal volta apos expirar');
});

test('ENV_STATUS cobre os codigos de ambiente medidos no protocolo', () => {
  assert.deepEqual([...ENV_STATUS].sort(), [4, 5, 6]);
  assert.ok(BAN_MS >= 1000);
});
