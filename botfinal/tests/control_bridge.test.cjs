'use strict';

/**
 * Ponte kind 11 -> motores proprios.
 *
 *   node --test botfinal/tests/control_bridge.test.cjs
 *
 * O que estes testes provam: a config e' VALIDADA, os motores recebem a config,
 * o runtime e' armado, e stop/pause realmente param o despacho.
 *
 * O que eles NAO provam: que o cliente executa. `effectVerified` continua false
 * aqui — so' o cliente real fecha essa parte.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const { ControlBridge, validateConfig } = require(path.join(__dirname, '..', 'core', 'control-bridge.cjs'));

const CONFIG = {
  target: {
    monsters: [{ name: '*', range: 8, minCount: 1 }],
    combo: { enabled: true, sequenceText: 'm5' },
  },
  walker: {
    waypoints: [
      { action: 'walk', pos: { x: 100, y: 100, z: 7 } },
      { action: 'walk', pos: { x: 101, y: 100, z: 7 } },
    ],
  },
  healer: { healHpPercent: 60 },
};

/** Runtime falso: registra start/stop/pause/resume, sem rede. */
function fakeRuntime() {
  const calls = [];
  return {
    calls,
    ticks: 0,
    started: false,
    paused: false,
    updateConfig(config) { calls.push({ op: 'updateConfig', config }); },
    start() { this.started = true; calls.push({ op: 'start' }); },
    stop() { this.started = false; calls.push({ op: 'stop' }); },
    async pause() { this.paused = true; calls.push({ op: 'pause' }); },
    async resume() { this.paused = false; calls.push({ op: 'resume' }); },
  };
}

function fakeEngine() {
  const received = [];
  return {
    received,
    updateConfig(config) { received.push(config); },
  };
}

function build() {
  const runtime = fakeRuntime();
  const combat = fakeEngine();
  const walker = fakeEngine();
  const healer = fakeEngine();
  const arbiter = fakeEngine();
  const bridge = new ControlBridge({
    control: { state: 'ready' },
    runtime, combat, walker, healer, arbiter,
    config: {},
  });
  return { bridge, runtime, combat, walker, healer, arbiter };
}

test('validateConfig recusa walker sem waypoints', () => {
  const engines = { walker: {} };
  const result = validateConfig('walker', { walker: { waypoints: [] } }, engines);
  assert.equal(result.ok, false);
  assert.match(result.issues[0], /waypoints vazio/u);
});

test('validateConfig recusa waypoint fora dos limites', () => {
  const result = validateConfig('walker',
    { walker: { waypoints: [{ action: 'walk', pos: { x: 70000, y: 1, z: 7 } }] } },
    { walker: {} });
  assert.equal(result.ok, false);
  assert.match(result.issues[0], /fora dos limites/u);
});

test('validateConfig aceita a config capturada (23 waypoints, m5)', () => {
  const real = require(path.join(__dirname, '..', 'config', 'kind11', 'target-config.json'));
  const walkerOk = validateConfig('walker', real, { walker: {} });
  assert.equal(walkerOk.ok, true, JSON.stringify(walkerOk.issues));
  assert.equal(real.walker.waypoints.length, 23);
  const targetOk = validateConfig('target', real, { walker: {} });
  assert.equal(targetOk.ok, true, JSON.stringify(targetOk.issues));
});

test('start aplica config nos motores e arma o runtime', async () => {
  const { bridge, runtime, combat, walker, healer, arbiter } = build();
  const result = await bridge.start('walker', CONFIG);

  assert.equal(result.action, 'started');
  assert.deepEqual(bridge.state.modules, ['walker']);
  assert.equal(runtime.started, true);
  /* O runtime recebeu a config antes de armar. */
  assert.ok(runtime.calls.some(c => c.op === 'updateConfig' && c.config === CONFIG),
    'runtime.updateConfig precisa receber a config do start');
  assert.ok(runtime.calls.findIndex(c => c.op === 'updateConfig')
    < runtime.calls.findIndex(c => c.op === 'start'),
    'config antes de start, nunca depois');
  /* A config chegou em cada motor, nao so' no runtime. */
  assert.equal(walker.received.length, 1);
  assert.equal(combat.received.length, 1);
  assert.equal(healer.received.length, 1);
  assert.equal(arbiter.received.length, 1);
  assert.deepEqual(walker.received[0], CONFIG);
});

test('start com config invalida nao arma o runtime', async () => {
  const { bridge, runtime } = build();
  const result = await bridge.start('walker', { walker: { waypoints: [] } });

  assert.equal(result.action, 'config-rejected');
  assert.equal(runtime.started, false, 'runtime nao pode ser armado com config ruim');
  assert.deepEqual(bridge.state.modules, []);
  assert.ok(Array.isArray(result.issues) && result.issues.length > 0);
});

test('stop corta o runtime e limpa o modulo', async () => {
  const { bridge, runtime } = build();
  await bridge.start('walker', CONFIG);
  assert.equal(runtime.started, true);

  const stopped = await bridge.stop('walker');
  assert.equal(stopped.action, 'stopped');
  assert.equal(runtime.started, false, 'stop precisa parar o despacho, nao so marcar flag');
  assert.deepEqual(bridge.state.modules, []);
  assert.equal(bridge.state.started, false);
});

test('stop de modulo sem motor proprio e recusado, nao fingido', async () => {
  const { bridge } = build();
  for (const module of ['hoenn', 'healer', 'looting']) {
    const result = await bridge.stop(module);
    assert.equal(result.action, 'stop-refused', module);
  }
});

test('start de modulo sem motor proprio e recusado', async () => {
  const { bridge, runtime } = build();
  const result = await bridge.start('healer', CONFIG);
  assert.equal(result.action, 'start-refused');
  assert.equal(runtime.started, false);
});

test('pause para o runtime; resume religa', async () => {
  const { bridge, runtime } = build();
  await bridge.start('walker', CONFIG);

  await bridge.setPaused(true);
  assert.equal(runtime.paused, true);
  assert.equal(bridge.state.paused, true);

  await bridge.setPaused(false);
  assert.equal(runtime.paused, false);
  assert.equal(bridge.state.paused, false);
});

test('handle traduz os 4 ops do kind 11', async () => {
  const { bridge, runtime } = build();

  const start = await bridge.handle({ op: 'start', module: 'walker', config: CONFIG });
  assert.equal(start.ok, true);
  assert.equal(runtime.started, true);

  const monitorOff = await bridge.handle({ op: 'monitor', enabled: false });
  assert.equal(monitorOff.ok, true);
  assert.equal(bridge.state.paused, true);

  const monitorOn = await bridge.handle({ op: 'monitor', enabled: true });
  assert.equal(monitorOn.ok, true);
  assert.equal(bridge.state.paused, false);

  const pause = await bridge.handle({ op: 'togglePause', pauseMonitor: true });
  assert.equal(pause.ok, true);
  assert.equal(bridge.state.paused, true);

  const stop = await bridge.handle({ op: 'stop', module: 'walker' });
  assert.equal(stop.ok, true);
  assert.equal(runtime.started, false);
});

test('handle recusa op desconhecido e payload sem op', async () => {
  const { bridge } = build();
  assert.deepEqual(await bridge.handle({ op: 'update' }),
    { ok: false, failure: 'unknown-op', op: 'update' });
  assert.deepEqual(await bridge.handle(null), { ok: false, failure: 'bad-request' });
  assert.deepEqual(await bridge.handle({}), { ok: false, failure: 'bad-request' });
});

test('dois starts do mesmo modulo nao duplicam entrada', async () => {
  const { bridge } = build();
  await bridge.start('walker', CONFIG);
  await bridge.start('walker', CONFIG);
  assert.deepEqual(bridge.state.modules, ['walker']);
});

test('start de target e walker juntos mantem os dois', async () => {
  const { bridge } = build();
  await bridge.start('walker', CONFIG);
  await bridge.start('target', CONFIG);
  assert.deepEqual([...bridge.state.modules].sort(), ['target', 'walker']);
  await bridge.stop('walker');
  assert.deepEqual(bridge.state.modules, ['target']);
});
