'use strict';

/**
 * Adaptador de estado do Shiba (kind6) para as entradas do nosso StateArbiter.
 *
 * POR QUE EXISTE: comparar o nosso arbitro com o do Shiba exigia traduzir o
 * payload kind6 para `{ validTargets, isLureReady, isFormationHeld,
 * isRepositioning, isRevivePending }`. Essa traducao vivia num script de
 * analise (tools/arbiter-compare.cjs) e por isso nao era testavel nem
 * reaproveitavel. Aqui ela fica versionada, com os achados medidos.
 *
 * TRES ACHADOS MEDIDOS (hunt real, PID 17748, 45 MB de captura):
 *
 * 1. `core.phase` / `core.movementOwner` ficam DESATUALIZADOS.
 *    Em 408 frames `core.phase="combat"` enquanto `phases.walker` dizia
 *    "Walker · WP 1/23 · walk". A fonte correta e' `phases.target` +
 *    `phases.walker`.
 *
 * 2. `luring.count === 0` com `luring.mode === 'off'` NAO significa "sem
 *    monstros" — significa ausencia de dado (o lure nao esta' no modo
 *    dynamic). O numero real esta' dentro de `phases.target`, nas frases
 *    "Perfect lure: N/M" e "Best Tile ... N/N".
 *
 * 3. `Dynamic Lure` (luring.phase em arc/stationary/wait) e' AGRUPAMENTO e
 *    tem PRECEDENCIA sobre a fase do Target: ele fecha a box primeiro e so'
 *    depois solta o combo. Medido: 51 frames de GROUPING contra o nosso
 *    COMBAT.
 *
 * Este modulo nao fala pipe nem jogo: recebe o objeto ja' decodificado.
 */

/** Fases de `phases.target` que significam combate ativo. */
const TARGET_COMBAT_PHASES = /best tile|pokestop|autocombo|perfect lure|preservando combo/i;
/** Fases de `luring.phase` que significam reposicionamento (Dynamic Lure). */
const REPOSITION_PHASES = new Set(['arc', 'stationary', 'wait']);

/** Le "N/M" de uma fase textual. Devolve null quando nao ha numero. */
function countFromPhase(text) {
  const m = String(text || '').match(/(\d+)\s*\/\s*(\d+)/);
  return m ? { n: Number(m[1]), total: Number(m[2]) } : null;
}

/**
 * Converte um payload kind6 nas entradas do arbiter.
 *
 * @param {object} obj  payload kind6 decodificado
 * @param {object} [opts]
 * @param {number} [opts.defaultMinWilds=8]  minCount quando o payload nao traz
 * @returns {{
 *   inputs: { validTargets: any[], isLureReady: boolean, isFormationHeld: boolean,
 *             isRepositioning: boolean, isRevivePending: boolean, inCombat: boolean },
 *   observed: { action: string, count: number, min: number, source: string },
 *   comparable: boolean
 * }}
 */
function adapt(obj, opts = {}) {
  const defaultMinWilds = Number(opts.defaultMinWilds ?? 8);
  const phases = obj?.phases || {};
  const targetPh = String(phases.target || '');
  const walkerPh = String(phases.walker || '');
  const luring = obj?.luring || {};
  const topPhase = String(obj?.phase || '');

  // ---- pausa / offline: nao e' decisao de arbitragem
  if (obj?.paused || /pausa/i.test(topPhase) || topPhase === 'Pausado') {
    return skipped('PAUSED', 'pausado');
  }
  if (!topPhase || /cliente offline/i.test(topPhase)) {
    return skipped('OFFLINE', 'sem dados de mundo');
  }

  // ---- contagem: luring.count so' vale em mode=dynamic (achado 2)
  const fromPhase = countFromPhase(targetPh);
  const hasDynamicCount = Number.isFinite(luring.count) && luring.count > 0;
  const count = hasDynamicCount ? luring.count : (fromPhase ? fromPhase.n : 0);
  const min = Number.isFinite(luring.minCount) && luring.minCount > 0
    ? luring.minCount
    : (fromPhase ? fromPhase.total : defaultMinWilds);

  const isRepositioning = REPOSITION_PHASES.has(String(luring.phase || ''));

  // ---- revive: a fonte e' phases.target (o topo `phase` tambem serve)
  const isRevivePending = /revive/i.test(targetPh) || /revive/i.test(topPhase);

  // ---- formacao: dois sinais, e o Dynamic manda (achados 1 e 3)
  const targetInCombatPhase = TARGET_COMBAT_PHASES.test(targetPh);
  let isFormationHeld;
  if (isRepositioning) {
    // ainda posicionando: NAO e' combate, mesmo que o Target ja' diga 8/8
    isFormationHeld = false;
  } else {
    isFormationHeld = luring.holding === true
      || (luring.mode === 'off' && targetInCombatPhase);
  }

  const hasMonsters = count > 0;
  const inputs = {
    // O payload nao traz posicoes; a contagem e' o proxy de "tem monstro".
    // Isto e' LIMITE DO DADO, nao do nosso motor: com telemetria real
    // (kind 5) o chamador passa os alvos de verdade.
    validTargets: hasMonsters ? new Array(count).fill(null) : [],
    isLureReady: count >= min,
    isFormationHeld,
    isRepositioning,
    isRevivePending,
    inCombat: false,
  };

  // ---- acao observada (para comparar)
  let action;
  if (isRevivePending) action = 'REVIVING';
  else if (isRepositioning) action = 'GROUPING';
  else if (targetInCombatPhase) action = 'COMBAT';
  else if (luring.holding === true) action = 'GROUPING';
  else if (walkerPh || luring.phase === 'travel' || /walker|dynamic/i.test(topPhase)) action = 'MOVING';
  else action = 'OTHER';

  return {
    inputs,
    observed: {
      action,
      count,
      min,
      source: hasDynamicCount ? 'luring' : (fromPhase ? 'phases.target' : 'nenhum'),
      walkerPhase: walkerPh,
      targetPhase: targetPh,
    },
    comparable: action !== 'OTHER',
  };
}

function skipped(action, reason) {
  return {
    inputs: {
      validTargets: [], isLureReady: false, isFormationHeld: false,
      isRepositioning: false, isRevivePending: false, inCombat: false,
    },
    observed: { action, count: 0, min: 0, source: 'nenhum', reason },
    comparable: false,
  };
}

module.exports = { adapt, countFromPhase, TARGET_COMBAT_PHASES, REPOSITION_PHASES };
