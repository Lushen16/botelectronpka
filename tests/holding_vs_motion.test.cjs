'use strict';

/**
 * Contratos do coletor de posicao e do comparador holding x movimento.
 *
 *   node --test tests/holding_vs_motion.test.cjs
 *
 * COBRE o que e' verificavel sem o jogo:
 *   - deteccao de parada/retomada a partir de posicao (casos sinteticos)
 *   - pouco movimento NAO vira parada (limiar de permanencia)
 *   - z diferente nao conta como movimento horizontal
 *   - parada no fim do registro nao inventa retomada
 *   - pareamento 1:1 respeita direcao e tolerancia
 *   - nao pareados de cada lado sao preservados
 *   - kind6 so' entra quando mode=dynamic e paused!=true
 *
 * NAO cobre: acuracia contra o PokeAlliance real (exige sessao viva).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON || 'python';

function py(script, args = []) {
  const r = spawnSync(PY, [path.join(ROOT, 'tools', script), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  return r;
}

/** Gera arquivos sinteticos e roda o comparador. */
function runSynthetic({ posRows, kind6Rows, tolerance = 250, stopMin = 300 }) {
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvm-'));
  const posPath = path.join(dir, 'pos.jsonl');
  const k6Path = path.join(dir, 'kind6.jsonl');
  const outPath = path.join(dir, 'out.json');

  fs.writeFileSync(posPath, posRows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(k6Path, kind6Rows.map(r => {
    const payload = {
      luring: { mode: 'dynamic', holding: r.holding, phase: r.holding ? 'arc' : 'travel',
        count: 5, minCount: 8 },
      paused: r.paused === true, phase: 'sintetico',
    };
    return JSON.stringify({ t: r.t, dir: 's2c', pid: 1, h: '0', kind: 6, n: 10,
      trunc: false, d: Buffer.from(JSON.stringify(payload), 'utf8').toString('hex') });
  }).join('\n') + '\n');

  const r = py('holding_vs_motion.py', [
    '--kind6', k6Path, '--position', posPath, '--out', outPath,
    '--tolerance-ms', String(tolerance), '--stop-min-ms', String(stopMin),
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { json: JSON.parse(fs.readFileSync(outPath, 'utf8')), dir, stdout: r.stdout };
}

function posSeries(segments) {
  // segments: [{n, y} | {n, y, still:true}]
  //   y      -> anda 1 tile por amostra (y + i)
  //   still  -> permanece no mesmo (x,y)
  const rows = [];
  let t = 1000;
  for (const s of segments) {
    for (let i = 0; i < s.n; i++) {
      rows.push({
        t,
        x: s.x !== undefined ? s.x : 100,
        y: s.still ? s.y : (s.y + i),
        z: s.z !== undefined ? s.z : 7,
        hp: 100, name: 'T', id: 1, online: true, err: null,
      });
      t += 33;
    }
  }
  return rows;
}

function kind6Series(points) {
  return points.map(p => ({ t: p.t, holding: p.holding, paused: p.paused }));
}

test('detecta uma parada e uma retomada e pareia com holding', () => {
  // anda 20, para 12 (396 ms), anda 10
  const pos = posSeries([
    { n: 20, y: 100 },
    { n: 12, y: 119, still: true },
    { n: 10, y: 120 },
  ]);
  const k6 = [];
  for (let t = 1000; t < 2400; t += 203) {
    k6.push({ t, holding: t >= 1650 && t < 2050 });
  }
  const { json } = runSynthetic({ posRows: pos, kind6Rows: k6 });

  assert.equal(json.result.stop.visual_events, 1, 'uma parada real');
  assert.equal(json.result.stop.pairs, 1, 'parada pareada');
  assert.equal(json.result.stop.unmatched_visual, 0);
  assert.equal(json.result.resume.visual_events, 1, 'uma retomada real');
  assert.equal(json.result.resume.pairs, 1, 'retomada pareada');
  // publicacao de 5 Hz chega depois do movimento continuo
  assert.ok(json.result.stop.dt_ms.median > 0, 'holding depois da parada');
});

test('movimento de uma amostra NAO vira parada', () => {
  // uma unica amostra repetida (33 ms) nao atinge 300 ms
  const pos = posSeries([
    { n: 5, y: 100 },
    { n: 1, y: 104 },
    { n: 5, y: 105 },
  ]);
  const { json } = runSynthetic({
    posRows: pos,
    kind6Rows: [{ t: 1000, holding: false }, { t: 1400, holding: false }],
  });
  assert.equal(json.result.stop.visual_events, 0, 'piscada curta nao e parada');
  assert.equal(json.result.resume.visual_events, 0);
});

test('z diferente nao conta como movimento horizontal', () => {
  const pos = [];
  let t = 1000;
  for (let i = 0; i < 12; i++) {
    pos.push({ t, x: 100, y: 100, z: 6 + (i % 2), hp: 100, name: 'T', id: 1, online: true, err: null });
    t += 33;
  }
  const { json } = runSynthetic({
    posRows: pos,
    kind6Rows: [{ t: 1000, holding: false }, { t: 1400, holding: false }],
  });
  // x,y constantes => uma parada longa, nenhuma retomada
  assert.equal(json.result.stop.visual_events, 1);
  assert.equal(json.result.resume.visual_events, 0, 'z nao gera retomada');
});

test('parada no fim do registro nao inventa retomada', () => {
  const pos = posSeries([
    { n: 5, y: 100 },
    { n: 20, y: 104, still: true },
  ]);
  const { json } = runSynthetic({
    posRows: pos,
    kind6Rows: [{ t: 1000, holding: false }, { t: 1400, holding: true }],
  });
  assert.equal(json.result.stop.visual_events, 1);
  assert.equal(json.result.resume.visual_events, 0, 'sem dado apos a parada');
});

test('kind6 pausado ou fora de dynamic e ignorado', () => {
  // Sem kind6 valido o comparador RECUSA (exit != 0) em vez de inventar
  // resultado. Esse e' o contrato: nao ha "resultado vazio" silencioso.
  const fs = require('node:fs');
  const os = require('node:os');
  const pos = posSeries([{ n: 20, y: 100 }, { n: 12, y: 119, still: true }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hvm-'));
  const posPath = path.join(dir, 'pos.jsonl');
  const k6Path = path.join(dir, 'kind6.jsonl');
  fs.writeFileSync(posPath, pos.map(r => JSON.stringify(r)).join('\n') + '\n');
  const k6 = [];
  for (let t = 1000; t < 2000; t += 203) k6.push({ t, holding: true, paused: true });
  fs.writeFileSync(k6Path, k6.map(r => {
    const payload = { luring: { mode: 'dynamic', holding: r.holding }, paused: true, phase: 'x' };
    return JSON.stringify({ t: r.t, dir: 's2c', pid: 1, h: '0', kind: 6, n: 10,
      trunc: false, d: Buffer.from(JSON.stringify(payload), 'utf8').toString('hex') });
  }).join('\n') + '\n');

  const r = py('holding_vs_motion.py', ['--kind6', k6Path, '--position', posPath,
    '--out', path.join(dir, 'out.json')]);
  assert.notEqual(r.status, 0, 'recusa quando nao ha kind6 de lure');
  assert.match(r.stderr, /dados insuficientes/);
});

test('tolerancia zero pareia apenas timestamp identico', () => {
  const pos = posSeries([{ n: 20, y: 100 }, { n: 12, y: 119, still: true }]);
  const k6 = [];
  for (let t = 1000; t < 2000; t += 203) k6.push({ t, holding: t >= 1650 });
  const { json } = runSynthetic({ posRows: pos, kind6Rows: k6, tolerance: 0 });
  assert.equal(json.result.stop.pairs, 0, 'tolerancia 0 nao casa por aproximacao');
  assert.ok(json.result.stop.unmatched_visual >= 1, 'visual preservado');
  assert.ok(json.result.stop.unmatched_holding >= 1, 'holding preservado');
});

test('position_sampler recusa pid inexistente sem travar', () => {
  const r = spawnSync(PY, [
    path.join(ROOT, 'tools', 'position_sampler.py'),
    '--pid', '999999999', '--seconds', '1', '--hz', '5',
    '--out', path.join(require('node:os').tmpdir(), 'hvm-none.jsonl'),
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.notEqual(r.status, 0, 'deve falhar, nao pendurar');
});
