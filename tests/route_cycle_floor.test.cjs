'use strict';

/**
 * Regressao da regra de alvo do `route-cycle`: SO' ATACA NO MESMO ANDAR.
 *
 * Medido em 2026-11-12 (18 ataques reais, `captures/routes/cycle-final.json`):
 *
 *     com efeito   (n=5):  dz=0 em 5/5    dist 1-2
 *     sem efeito   (n=13): dz=1 em 11/13  dist 1-2
 *
 * Ou seja: 100% dos ataques no mesmo andar acertaram; 85% dos ataques um
 * andar acima NAO acertaram, mesmo a 1-2 tiles no plano. O `nearest()` antigo
 * ordenava por dz e depois atacava o primeiro da lista mesmo com dz>0 —
 * preferia o andar certo e atirava no errado.
 *
 * Estes testes travam a regra no codigo-fonte do tool (ele fala pipe, nao da'
 * para unit-testar a decisao sem um jogo).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'tools', 'route-cycle.cjs'), 'utf8');

function code() {
  return SOURCE.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n\r]*/gu, ' ');
}

test('selecao de alvo exige dz === 0', () => {
  assert.match(code(), /c\.dz\s*===\s*0/,
    'o alvo tem que estar no mesmo andar; sem isso o ataque nao aplica dano');
});

test('a regra esta documentada com a medicao que a sustenta', () => {
  assert.match(SOURCE, /dz=0 em 5\/5|com efeito.*dz=0/isu,
    'sem a medicao o proximo agente "otimiza" a regra de volta');
});

test('ciclo sem alvo no andar e reportado, nao escondido', () => {
  /* Se o personagem so' tem monstros um andar acima, `kills 0` parece bug de
   * ataque. O campo separa cena de defeito. */
  assert.match(code(), /noSameFloorTarget/);
  assert.match(code(), /cyclesWithoutSameFloorTarget/);
});

test('relatorio separa executado de efeito', () => {
  /* status 0 = handler rodou. NAO significa dano. A confusao dos dois foi o
   * que fez 17 ataques "funcionarem" sem baixar HP nenhum. */
  assert.match(code(), /executed/);
  assert.match(code(), /hpSeries/);
});
