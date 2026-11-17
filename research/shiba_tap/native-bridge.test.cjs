'use strict';

/**
 * Testes da ponte com o dispatcher nativo.
 *
 *   node --test research/shiba_tap/native-bridge.test.cjs
 *
 * Usa um diretorio temporario como `native/` e um jsonl sintetico, para nao
 * depender do jogo estar aberto nem sujar as capturas reais.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const { NativeBridge } = require('./native-bridge.cjs');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-'));
  const loopLog = path.join(dir, 'pka_attack_loop.log');
  return {
    dir,
    /* o log do loop e' isolado por teste: o log real em %TEMP% tem 'loop up'
    /* e faria ready() reportar pronto num sandbox sem loop. */
    loopLog,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Escreve um tap sintetico com uma telemetria contendo `creatures`. */
function writeTap(dir, pid, creatures, player = { x: 100, y: 100, z: 7 }) {
  const payload = {
    schema: 2, pulseVersion: 3, nativeVerified: true, playerName: 'Tester',
    position: player, creatures,
  };
  const record = {
    t: Date.now(), dir: 's2c', pid, kind: 5, n: Buffer.byteLength(JSON.stringify(payload)),
    trunc: false, d: Buffer.from(JSON.stringify(payload)).toString('hex'),
  };
  const file = path.join(dir, `pka_tap_${pid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
  return file;
}

const hostile = (id, x = 101, y = 100, hp = 100) => ({
  id, name: 'Rattata', type: 1, canAttack: true, healthPercent: hp,
  pos: { x, y, z: 7 },
});

test('construtor valida pid', () => {
  assert.throws(() => new NativeBridge({}), /pid invalido/u);
  assert.throws(() => new NativeBridge({ pid: 0 }), /pid invalido/u);
  assert.throws(() => new NativeBridge({ pid: '123' }), /pid invalido/u);
});

test('ready nega quando tap ausente', () => {
  const box = sandbox();
  try {
    const bridge = new NativeBridge({ pid: 999999, nativeDir: box.dir, loopLog: box.loopLog });
    const state = bridge.ready();
    assert.equal(state.ready, false);
    assert.match(state.reason, /tap ausente/u);
  } finally { box.cleanup(); }
});

test('ready nega quando loop nao injetado, mesmo com tap', () => {
  const box = sandbox();
  try {
    writeTap(box.dir, 424242, []);
    fs.writeFileSync(path.join(box.dir, 'pka_attack_loop_config.txt'), 'dispatcher_rva=15280\n');
    const bridge = new NativeBridge({ pid: 424242, nativeDir: box.dir, loopLog: box.loopLog });
    const state = bridge.ready();
    assert.equal(state.ready, false);
    assert.match(state.reason, /pka_attack_loop\.dll nao injetado/u);
    assert.match(state.reason, /pka_inject\.exe --pid 424242/u);
  } finally { box.cleanup(); }
});

test('snapshot le a telemetria do fim do arquivo', () => {
  const box = sandbox();
  try {
    writeTap(box.dir, 111, [hostile(9001)], { x: 10, y: 20, z: 7 });
    const bridge = new NativeBridge({ pid: 111, nativeDir: box.dir, loopLog: box.loopLog });
    const snapshot = bridge.snapshot();
    assert.equal(snapshot.playerName, 'Tester');
    assert.deepEqual(snapshot.position, { x: 10, y: 20, z: 7 });
    assert.equal(snapshot.creatures.length, 1);
  } finally { box.cleanup(); }
});

test('hostiles filtra tipo, canAttack e hp', () => {
  const box = sandbox();
  try {
    writeTap(box.dir, 222, [
      { id: 1, name: 'Player', type: 0, canAttack: true, healthPercent: 100 },
      { id: 2, name: 'Meu', type: 3, canAttack: false, healthPercent: 100 },
      hostile(3, 100, 100, 50),
      hostile(4, 100, 100, 0),
      { id: 5, name: 'Alheio', type: 1, canAttack: false, healthPercent: 80 },
    ]);
    const bridge = new NativeBridge({ pid: 222, nativeDir: box.dir, loopLog: box.loopLog });
    const list = bridge.hostiles();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 3);
  } finally { box.cleanup(); }
});

test('hostiles ordena pelo mais proximo', () => {
  const box = sandbox();
  try {
    writeTap(box.dir, 333, [hostile(10, 130, 130), hostile(11, 101, 100)], { x: 100, y: 100, z: 7 });
    const bridge = new NativeBridge({ pid: 333, nativeDir: box.dir, loopLog: box.loopLog });
    const list = bridge.hostiles();
    assert.equal(list[0].id, 11, 'o mais próximo vem primeiro');
    assert.equal(list[1].id, 10);
  } finally { box.cleanup(); }
});

test('attack rejeita targetId invalido com status 1', async () => {
  const box = sandbox();
  try {
    const bridge = new NativeBridge({ pid: 444, nativeDir: box.dir, loopLog: box.loopLog });
    for (const bad of [0, -1, 1.5, null, undefined, '7']) {
      const result = await bridge.attack(bad);
      assert.equal(result.status, 1, 'aceitou: ' + bad);
      assert.equal(result.dispatched, false);
    }
  } finally { box.cleanup(); }
});

test('attack devolve status 2 quando a ponte nao esta pronta', async () => {
  const box = sandbox();
  try {
    const bridge = new NativeBridge({ pid: 555, nativeDir: box.dir, loopLog: box.loopLog });
    const result = await bridge.attack(123);
    assert.equal(result.status, 2);
    assert.equal(result.dispatched, false);
    assert.match(result.message, /nao injetado|ausente/u);
  } finally { box.cleanup(); }
});

test('attack incrementa o contador e escreve o arquivo de alvo', async () => {
  const box = sandbox();
  try {
    writeTap(box.dir, 666, [hostile(42)]);
    fs.writeFileSync(path.join(box.dir, 'pka_attack_loop_config.txt'), 'dispatcher_rva=15280\n');
    const bridge = new NativeBridge({ pid: 666, nativeDir: box.dir, loopLog: box.loopLog, timeoutMs: 200 });
    /* finge que o loop esta' injetado, no log ISOLADO do sandbox */
    fs.writeFileSync(box.loopLog, 'loop up: dispatcher=0x1\n');

    const before = bridge.counter;
    const result = await bridge.attack(42);
    /* com 'loop up' no log o bridge se considera pronto; sem loop real nao ha
     * resposta, entao o status e' 3 (runtime nao respondeu). */
    assert.equal(result.status, 3);
    assert.match(result.message, /nao respondeu|recusou|retornou 0/u);

    const written = fs.readFileSync(path.join(box.dir, 'pka_attack_target.txt'), 'utf8');
    assert.equal(written, `42,0,${before + 1}`);
    assert.equal(bridge.counter, before + 1);
  } finally { box.cleanup(); }
});

test('attackNearest devolve null sem hostis', async () => {
  const box = sandbox();
  try {
    writeTap(box.dir, 777, [{ id: 1, name: 'Player', type: 0, canAttack: true, healthPercent: 100 }]);
    const bridge = new NativeBridge({ pid: 777, nativeDir: box.dir, loopLog: box.loopLog });
    assert.equal(await bridge.attackNearest(), null);
  } finally { box.cleanup(); }
});

test('attackNearest escolhe o mais proximo e reporta o alvo', async () => {
  const box = sandbox();
  try {
    writeTap(box.dir, 888, [hostile(20, 130, 130), hostile(21, 101, 100)], { x: 100, y: 100, z: 7 });
    const bridge = new NativeBridge({ pid: 888, nativeDir: box.dir, loopLog: box.loopLog, timeoutMs: 150 });
    const result = await bridge.attackNearest();
    assert.ok(result, 'deveria devolver resultado');
    /* a escolha do alvo acontece ANTES da checagem de prontidao, entao o alvo
     * vem preenchido mesmo quando o loop nao esta' injetado (status 2). Isso e'
     * proposital: quem chama sabe qual alvo seria atacado. */
    assert.equal(result.target.id, 21);
    assert.equal(result.status, 2, 'sem loop injetado no sandbox, espera-se 2');
  } finally { box.cleanup(); }
});



