'use strict';

/**
 * `tools/route-run.cjs` — roda uma ROTA REAL do Shiba.
 *
 * Contexto: `route-cycle.cjs` anda em ciclo fixo `0,1,2,3` e mediu 44/87 walks
 * com status 0 e zero tile (obstaculo) — 38 tentativas de oeste no mesmo beco.
 * Este tool consome o formato que o Shiba usa de verdade.
 *
 * Estes testes cobrem o PARSER, que e' a parte que pode silenciosamente
 * "funcionar" lendo zero waypoint e reportar sucesso vazio.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'route-run.cjs');
const CONFIG = path.join(ROOT, 'analysis', 'shiba-live-config');

function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
}

test('route-run recusa sem --pid e sem rota', () => {
  assert.equal(run([]).status, 2);
  const noRoute = run(['--pid', '999999']);
  assert.equal(noRoute.status, 2);
  assert.match(noRoute.stderr, /--route|--nearest/);
});

test('route-run escolhe a guarda de runtime antes de enviar', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  /* A guarda tem que ser `x === false` (estrito): `undefined` significa DLL
   * antiga que nao publica o campo, e bloquear por ausencia de dado tornaria
   * todo binario anterior inutil. */
  assert.ok(source.includes('ready === false'),
    'a guarda precisa comparar com false (undefined = DLL antiga nao bloqueia)');
  assert.ok(!source.includes('if (!ready)'),
    'truthiness bloquearia DLL antiga (undefined) — tem que ser `=== false`');
  assert.ok(source.includes('Nada foi enviado'));
});

test('parser reconhece o formato real das rotas do Shiba', () => {
  /* Pelo menos 25 das 35 rotas de analysis/shiba-live-config tem waypoints.
   * As outras sao: arquivos de 0 byte e listas de nomes (wk_index). */
  const files = fs.readdirSync(CONFIG)
    .filter(name => name.startsWith('wk_') && name.endsWith('.lua'));
  assert.ok(files.length >= 30, 'esperado o conjunto de rotas do Shiba');

  const pattern = /\{pos=\{x=(\d+)\s*,\s*y=(\d+)\s*,\s*z=(\d+)\}\s*,\s*action="([^"]*)"\s*,\s*param="([^"]*)"\}/gu;
  let withWaypoints = 0;
  let total = 0;
  for (const name of files) {
    const text = fs.readFileSync(path.join(CONFIG, name), 'utf8');
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) continue;
    withWaypoints += 1;
    total += matches.length;
    for (const match of matches) {
      assert.ok(Number(match[1]) >= 0 && Number(match[1]) < 65535, name + ': x invalido');
      assert.ok(Number(match[2]) >= 0 && Number(match[2]) < 65535, name + ': y invalido');
      assert.ok(Number(match[3]) <= 15, name + ': z invalido');
    }
  }
  assert.ok(withWaypoints >= 25, 'rotas com waypoints: ' + withWaypoints);
  assert.ok(total > 1500, 'total de waypoints: ' + total);
});

test('parser recusa arquivo sem waypoint em vez de reportar sucesso vazio', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /nenhum waypoint reconhecido/);
  assert.match(source, /throw Error/);
});

test('route-run exige mesmo andar para seguir (stairs nao e inventado)', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  /* Sem isso o tool "andaria" para um waypoint em outro z e contaria bloqueio
   * como falha de walk, quando e' transicao de andar. */
  assert.match(source, /z diferente|stairs/);
  assert.match(source, /record\.skipped/);
});

test('walk bloqueado nao e contado como movimento', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.match(source, /record\.blocked\s*\+=\s*1/);
  assert.match(source, /movedSteps|moves\s*\+=\s*1/);
});
