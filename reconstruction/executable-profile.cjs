'use strict';

/**
 * Perfis de executavel aceitos pelo runtime.
 *
 * O cliente e atualizado pelo fornecedor e o hash muda a cada build. Em vez de
 * fixar um unico valor em cada arquivo (o que quebra o pipeline inteiro quando
 * o jogo atualiza), a lista fica aqui e todos consultam este modulo.
 *
 * Regra: um build novo so entra na lista depois de o layout ser VERIFICADO no
 * processo real — offset de tipo, vtables de Creature/Player e leitura de
 * posicao/hp/name/posse. Adicionar hash no achismo derruba a garantia de
 * identidade que protege contra ler a estrutura errada.
 *
 * builds verificados:
 *   473df25c...  build anterior (2026-10 / 2026-11-02)
 *   82eadedc...  build de 2026-11-03 (secoes com nomes ofuscados; layout
 *                confirmado por RTTI no PID 25876, typeOffset 0x186)
 */

const EXECUTABLE_SHA256 = '473df25c1edd23e7464ad3ba9b923a603051a8b4ae8004a95c06402f678294e6';

const SUPPORTED_EXECUTABLE_SHA256 = Object.freeze([
  EXECUTABLE_SHA256,
  '82eadedcba74e368a7b981a11a6a4d20546b490be6bd4565026c2de847554e1c',
]);

const SUPPORTED = new Set(SUPPORTED_EXECUTABLE_SHA256);

function isSupportedExecutable(sha256) {
  return typeof sha256 === 'string' && SUPPORTED.has(sha256.toLowerCase());
}

/** Perfil de layout por build. Offsets confirmados em processo real. */
const LAYOUTS = Object.freeze({
  '473df25c1edd23e7464ad3ba9b923a603051a8b4ae8004a95c06402f678294e6': Object.freeze({
    typeOffset: '0x186', label: 'build-2026-10',
  }),
  '82eadedcba74e368a7b981a11a6a4d20546b490be6bd4565026c2de847554e1c': Object.freeze({
    typeOffset: '0x186', label: 'build-2026-11-03',
  }),
});

function layoutFor(sha256) {
  if (typeof sha256 !== 'string') return null;
  return LAYOUTS[sha256.toLowerCase()] || null;
}

module.exports = {
  EXECUTABLE_SHA256,
  SUPPORTED_EXECUTABLE_SHA256,
  isSupportedExecutable,
  layoutFor,
  LAYOUTS,
};
