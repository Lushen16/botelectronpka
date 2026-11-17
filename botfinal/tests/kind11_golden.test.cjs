'use strict';

/**
 * Teste-ouro do codec kind 11 contra os 20 frames capturados do fornecedor.
 *
 *   node --test botfinal/tests/kind11_golden.test.cjs
 *
 * Os arquivos em captures/kind11-clean/ foram extraidos do tap
 * (native/pka_tap_8036.jsonl). Cada um tem o payload c2s cru. Se o nosso
 * codec reproduz o JSON byte a byte, o envelope esta certo por construcao —
 * nao por leitura de documentacao.
 *
 * NAO prova que o runtime aceita o frame. Isso exige o jogo.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
/* Fixtures versionados dentro do botfinal: capturas/ cai no .gitignore (a regra
 * e' `captures/`, em qualquer nivel) e o teste nao pode depender de arquivo nao
 * rastreado. */
const CAPTURES = path.join(__dirname, '..', 'config', 'kind11', 'fixtures');
const codec = require(path.join(__dirname, '..', 'core', 'kind11-codec.cjs'));

const HEX32 = /^[0-9a-f]{32}$/u;

function loadAll() {
  if (!fs.existsSync(CAPTURES)) return [];
  return fs.readdirSync(CAPTURES)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => ({
      name,
      payload: JSON.parse(fs.readFileSync(path.join(CAPTURES, name), 'utf8')).payload,
    }));
}

/** Reconstroi o payload a partir do que o codec sabe, usando a identidade capturada. */
function rebuild(captured) {
  const identity = { boot: captured.boot, client: captured.client };
  const common = { identity, seq: captured.seq };
  switch (captured.op) {
    case 'start': return codec.buildPayload('start', { ...common, module: captured.module });
    case 'stop': return codec.buildPayload('stop', { ...common, module: captured.module });
    case 'monitor':
      return codec.buildPayload('monitor', { ...common, enabled: captured.enabled });
    case 'togglePause':
      return codec.buildPayload('togglePause', { ...common,
        pauseMonitor: captured.pauseMonitor, key: captured.key });
    default: throw Error('op sem rebuild: ' + captured.op);
  }
}

const captures = loadAll();

test('captura limpa presente e com os 20 frames', () => {
  assert.equal(captures.length, 20, 'esperado 20 frames kind 11 em captures/kind11-clean/');
  const ids = captures.map(c => c.payload.seq);
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => i + 1),
    'seq 1..20, monotonomico na sessao');
});

test('todo frame capturado tem identidade 32 hex e protocol 1', () => {
  for (const { name, payload } of captures) {
    assert.equal(payload.protocol, 1, name);
    assert.match(payload.boot, HEX32, name + ' boot');
    assert.match(payload.client, HEX32, name + ' client');
  }
});

test('codec reproduz cada um dos 20 frames byte a byte', () => {
  const divergences = [];
  for (const { name, payload } of captures) {
    let rebuilt;
    try { rebuilt = rebuild(payload); }
    catch (error) { divergences.push({ name, error: error.message }); continue; }
    const expected = JSON.stringify(payload);
    const actual = JSON.stringify(rebuilt);
    if (expected !== actual) divergences.push({ name, expected, actual });
  }
  assert.deepEqual(divergences, [], 'frames divergentes: '
    + divergences.map(d => d.name + (d.error ? ' (' + d.error + ')' : '')).join(', '));
});

test('config base e identica nos 5 frames que a carregam', () => {
  const withConfig = captures.filter(c => c.payload.config);
  assert.equal(withConfig.length, 5, 'start x4 + monitor(true) x1');
  const first = JSON.stringify(withConfig[0].payload.config);
  for (const { name, payload } of withConfig) {
    assert.equal(JSON.stringify(payload.config), first, name);
  }
  const config = withConfig[0].payload.config;
  assert.equal(config.target.combo.sequenceText, 'm5',
    'captura so tem m5; nenhuma prova de m3');
  assert.equal(config.target.combo.useNativeSequence, true);
  assert.deepEqual(Object.keys(config).sort(),
    ['alerts', 'healer', 'hoenn', 'looting', 'scripts', 'target', 'tools', 'walker'],
    'as 8 secoes');
});

test('stop nunca leva config; monitor(false) nunca leva config', () => {
  for (const { name, payload } of captures) {
    if (payload.op === 'stop') assert.equal(payload.config, undefined, name);
    if (payload.op === 'monitor' && payload.enabled === false) {
      assert.equal(payload.config, undefined, name);
    }
  }
});

test('start so aparece para target e walker; stop(hoenn) existe so como stop', () => {
  const starts = captures.filter(c => c.payload.op === 'start').map(c => c.payload.module);
  assert.deepEqual([...new Set(starts)].sort(), ['target', 'walker'],
    'nao deduzir start(hoenn) de stop(hoenn)');
  const stops = captures.filter(c => c.payload.op === 'stop').map(c => c.payload.module);
  assert.ok(stops.includes('hoenn'));
  assert.ok(!starts.includes('hoenn'));
});

test('codec recusa op/module nao observados e identidade invalida', () => {
  const identity = { boot: 'a'.repeat(32), client: 'b'.repeat(32) };
  assert.throws(() => codec.buildPayload('update', { identity, seq: 1 }),
    /nao foi observado/u);
  assert.throws(() => codec.buildPayload('start', { identity, seq: 1, module: 'healer' }),
    /nao foi observado/u);
  assert.throws(() => codec.buildPayload('start', { identity: { boot: 'x', client: 'y' },
    seq: 1, module: 'target' }), /32 hex/u);
  assert.throws(() => codec.buildPayload('stop', { identity, seq: 1 }), /exige module/u);
});
