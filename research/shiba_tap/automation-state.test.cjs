'use strict';

/**
 * Testes do modelo kind 6 contra AMOSTRAS REAIS da captura.
 *
 * Nao usa fixture inventada: le o jsonl do tap, pega frames kind 6 verdadeiros
 * e valida que o parser nao perde informacao nem inventa campo.
 *
 *   node --test research/shiba_tap/automation-state.test.cjs
 *
 * Se a captura nao existir, os testes que dependem dela sao pulados - o resto
 * continua rodando.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const model = require('./automation-state.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const CAPTURES = [
  path.join(ROOT, 'captures', 'shiba-session-full-401mb.jsonl'),
  path.join(ROOT, 'captures', 'shiba-session-2026-11-04.jsonl'),
  path.join(ROOT, 'native', 'pka_tap_10244.jsonl'),
];

/**
 * Le `limit` frames kind 6 ESPALHADOS pela captura.
 *
 * Ler so o comeco pega o bot em `idle` (o combate acontece depois), e um teste
 * de `movementOwner` falharia sem o codigo estar errado. Amostrar de forma
 * uniforme cobre idle, walker, combat e lure.
 */
function loadSamples(limit = 300) {
  const file = CAPTURES.find(candidate => fs.existsSync(candidate));
  if (!file) return { file: null, samples: [] };

  const candidates = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.kind !== 6 || record.trunc || !record.d) continue;
    candidates.push(Buffer.from(record.d, 'hex'));
  }
  if (!candidates.length) return { file, samples: [] };

  const step = Math.max(1, Math.floor(candidates.length / limit));
  const samples = [];
  for (let i = 0; i < candidates.length && samples.length < limit; i += step) {
    samples.push(candidates[i]);
  }
  return { file, samples };
}

const loaded = loadSamples();

/* ------------------------------------------------------------ enums */

test('enums batem com a captura real', () => {
  for (const name of model.LURE_PHASE) {
    assert.equal(typeof name, 'string');
  }
  assert.deepEqual([...model.CORE_PHASE].sort(), ['combat', 'idle']);
  assert.deepEqual([...model.LURE_MODE].sort(), ['dynamic', 'off']);
  assert.ok(model.LURE_PHASE.includes('observe'), 'observe apareceu na sessao de 80 min');
});

test('toda transicao mapeada veio da captura', () => {
  const seen = Object.entries(model.LURE_TRANSITIONS);
  assert.ok(seen.length >= 14, 'esperado ao menos 14 transicoes mapeadas');
  for (const [key, count] of seen) {
    assert.match(key, /^[a-z]+>[a-z]+$/u);
    assert.ok(Number.isInteger(count) && count > 0, key + ' tem contagem invalida');
  }
  assert.equal(model.isCommonLureTransition('off', 'travel'), true);
  assert.equal(model.isCommonLureTransition('observe', 'stationary'), false);
});

/* ------------------------------------------------------ parser basico */

test('parser aceita Buffer, string e objeto', () => {
  const payload = {
    protocol: 1, tick: 123, pid: 42, authorized: true, busy: false, error: '',
    core: { movementOwner: null, phase: 'idle' },
    luring: { mode: 'off', phase: 'off', holding: false, count: 0, minCount: 0 },
    walkerIndex: 3, walkerTimer: { phase: 'idle', remainingMs: 0 },
    modules: [], events: [], phase: 'Pausado',
  };
  const asObject = model.parse(payload);
  const asString = model.parse(JSON.stringify(payload));
  const asBuffer = model.parse(Buffer.from(JSON.stringify(payload)));
  for (const parsed of [asObject, asString, asBuffer]) {
    assert.equal(parsed.ok, true);
    assert.equal(parsed.tick, 123);
    assert.equal(parsed.walker.index, 3);
    assert.deepEqual(parsed.issues, []);
  }
});

test('payload invalido nao derruba o parser', () => {
  assert.equal(model.parse(null).ok, false);
  assert.equal(model.parse('nao e json').ok, false);
  assert.equal(model.parse(42).ok, false);
});

test('campo de enum desconhecido vira issue, nao excecao', () => {
  const parsed = model.parse({
    core: { phase: 'fase-nova-do-fornecedor' },
    luring: { mode: 'hyper', phase: 'teleport', count: 1, minCount: 0 },
    modules: ['target', 'modulo-novo'],
  });
  assert.equal(parsed.ok, true);
  const fields = parsed.issues.map(issue => issue.field);
  assert.ok(fields.includes('core.phase'));
  assert.ok(fields.includes('modules'));
  /* valor preservado para diagnostico, nao zerado */
  assert.equal(parsed.core?.phase, undefined);
  assert.equal(parsed.phase.core, 'fase-nova-do-fornecedor');
});

/* ------------------------------------------------------- movimento */

test('movementPermission nega quando target dirige', () => {
  const parsed = model.parse({ core: { movementOwner: 'target', phase: 'combat' } });
  const permission = model.movementPermission(parsed);
  assert.equal(permission.allowed, false);
  assert.match(permission.reason, /target/u);
});

test('movementPermission nega durante lure', () => {
  const parsed = model.parse({
    core: { movementOwner: null, phase: 'idle' },
    luring: { mode: 'dynamic', phase: 'arc' },
  });
  assert.equal(model.movementPermission(parsed).allowed, false);
});

test('movementPermission libera so em estado ocioso', () => {
  const parsed = model.parse({
    core: { movementOwner: null, phase: 'idle' },
    luring: { mode: 'off', phase: 'off' },
  });
  const permission = model.movementPermission(parsed);
  assert.equal(permission.allowed, true);
  assert.equal(permission.reason, 'livre');
});

test('movementPermission nega em combate mesmo sem dono', () => {
  const parsed = model.parse({ core: { movementOwner: null, phase: 'combat' } });
  assert.equal(model.movementPermission(parsed).allowed, false);
});

/* ---------------------------------------------------------- stall */

test('detectStall ignora ticks diferentes', () => {
  const a = model.parse({ tick: 1, core: { phase: 'idle' }, luring: { phase: 'off' } });
  const b = model.parse({ tick: 2, core: { phase: 'idle' }, luring: { phase: 'off' } });
  assert.equal(model.detectStall(a, b, 20000), null);
});

test('detectStall acusa quadro repetido por tempo demais', () => {
  const snapshot = { tick: 7, core: { phase: 'combat' }, luring: { phase: 'wait' }, walkerIndex: 4 };
  const a = model.parse(snapshot);
  const b = model.parse(snapshot);
  assert.equal(model.detectStall(a, b, 3000), null, 'ainda dentro do normal');
  const stall = model.detectStall(a, b, 15000);
  assert.ok(stall, 'deveria acusar travamento');
  assert.equal(stall.kind, 'stall');
  assert.equal(stall.lurePhase, 'wait');
});

/* ------------------------------------------- captura real (opcional) */

test('parser cobre todas as amostras reais sem erro', { skip: !loaded.samples.length }, () => {
  let ok = 0;
  let withIssues = 0;
  for (const buffer of loaded.samples) {
    const parsed = model.parse(buffer);
    assert.equal(parsed.ok, true, 'falhou em ' + buffer.length + ' bytes');
    if (parsed.issues.length) withIssues++;
    else ok++;
  }
  assert.ok(ok > 0, 'nenhuma amostra limpa');
  /* tolera ate 5% com enum desconhecido (build mais nova que o mapa) */
  assert.ok(withIssues / loaded.samples.length <= 0.05,
    withIssues + ' de ' + loaded.samples.length + ' amostras com issue');
});

test('amostras reais produzem fases dentro do enum', { skip: !loaded.samples.length }, () => {
  const seen = new Set();
  for (const buffer of loaded.samples) {
    const parsed = model.parse(buffer);
    if (parsed.lure.phase) seen.add(parsed.lure.phase);
    if (parsed.phase.core) assert.ok(model.CORE_PHASE.includes(parsed.phase.core));
  }
  for (const phase of seen) {
    assert.ok(model.LURE_PHASE.includes(phase), 'fase fora do enum: ' + phase);
  }
  assert.ok(seen.size > 0, 'nenhuma fase de lure vista');
});

test('movementOwner real aparece e e coerente', { skip: !loaded.samples.length }, () => {
  let sawTarget = false;
  for (const buffer of loaded.samples) {
    const parsed = model.parse(buffer);
    if (parsed.movementOwner === 'target') {
      sawTarget = true;
      /* quando target dirige, o walker nao pode ser liberado */
      assert.equal(model.movementPermission(parsed).allowed, false);
    }
  }
  assert.ok(sawTarget, 'captura deveria conter movementOwner=target em combate');
});
