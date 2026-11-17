'use strict';

/**
 * DynamicLure: reposicionamento de agrupamento (o "Dynamic Lure" do Shiba).
 *
 * POR QUE EXISTE: ate' aqui o nosso bot ou anda ou ataca. O Shiba faz um
 * terceiro movimento — continua a rota enquanto AJUSTA a posicao para fechar
 * a box de monstros, e so' solta o combo quando a formacao fecha. Era o que
 * faltava para a fluidez dele.
 *
 * MODELO EXTRAIDO DA CAPTURA REAL (hunt ativa, PID 17748, 6.616 frames
 * dynamic). Nao e' invencao: as fases e os tempos vem do kind6 dele.
 *
 *   luring.phase   o que faz              duracao mediana medida
 *   ------------   ---------------------  -----------------------
 *   travel         ANDA (rota normal)     3.672 ms
 *   arc            micro-ajuste (±1 tile)    32 ms
 *   stationary     parado agrupando         234 ms
 *   wait           espera curta           1.406 ms
 *
 *   delta de posicao do alvo por passo, medido:
 *     travel     dx ∈ [-3..3]  dy ∈ [-5..5]   (anda de verdade)
 *     arc        dx ∈ [-1..2]  dy ∈ [-1..1]   (ajuste fino)
 *     stationary dx = 0        dy = 0         (parado)
 *
 *   transicoes observadas: travel<->arc (28/27), travel<->stationary (11/11),
 *   travel<->wait (2/3). O ciclo base e' travel com pulsos curtos de ajuste.
 *
 * O QUE ESTE MODULO NAO FAZ: nao planeja o arco otimo (o Shiba tambem nao
 * parece planejar — sao micro-ajustes reativos). Nao move o personagem: devolve
 * uma DECISAO para o walker/combate executarem.
 */

const LURE_PHASE = Object.freeze({
  OFF: 'off',
  TRAVEL: 'travel',
  ARC: 'arc',
  STATIONARY: 'stationary',
  WAIT: 'wait',
  OBSERVE: 'observe',
});

/** Duracoes medidas (ms), usadas como default quando a config nao define. */
const MEASURED_MS = Object.freeze({
  arc: 40,
  stationary: 240,
  wait: 1400,
});

function chebyshev(a, b) {
  if (!a || !b) return Infinity;
  if (a.z !== b.z) return Infinity;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

class DynamicLure {
  constructor(config = {}) {
    this.config = config;
    this.updateConfig = (next) => { this.config = next || {}; };
    this.reset();
  }

  /** Ajusta min count / range / hp de emergencia em runtime, sem reescrever
   * o arquivo de config. A UI usa isto para os tres campos numericos.
   * Valor invalido (NaN, <= 0) e' ignorado, mantendo o que ja' valia. */
  setOverrides(next = {}) {
    const atuais = (this.config && this.config.overrides) || {};
    const limpo = { ...atuais };
    for (const chave of ['minWilds', 'range', 'minHpPercent']) {
      if (next[chave] === undefined || next[chave] === null) continue;
      const n = Number(next[chave]);
      if (Number.isFinite(n) && n > 0) limpo[chave] = n;
    }
    this.config = { ...(this.config || {}), overrides: limpo };
    /* Mudou o alvo de formacao: reinicia a fase para nao carregar um
     * "sem progresso" do valor antigo e liberar o combo cedo demais. */
    this.reset();
    return this.lureConfig;
  }

  reset() {
    this.phase = LURE_PHASE.OFF;
    this.phaseSince = 0;
    this.lastAdjustAt = 0;
    this.cyclesWithoutProgress = 0;
    this.bestBoxed = 0;
  }

  get lureConfig() {
    /* A config do Shiba (kind11/target-config.json) aninha `luring` e `combo`
     * DENTRO de `target`, mas `hoenn` fica no topo:
     *
     *   { target: { luring: {...}, combo: {...}, monsters: [...] }, hoenn: {...} }
     *
     * O codigo lia so' `this.config.luring` (topo), que nao existe na config
     * real — logo `enabled` saia SEMPRE false e o perfect lure nunca ligava.
     * Medido: com luring.frontEnabled=true no arquivo, `decide()` devolvia
     * `{ phase: 'off', reason: 'lure desligado' }`.
     *
     * SEGUNDO ERRO CORRIGIDO (2026-11-14): `range` vinha de
     * `hoenn.bestTileRange` (4). Mas `bestTileRange` e' o raio para escolher a
     * MELHOR TILE onde o personagem fica — outro conceito. O raio do perfect
     * lure e' `target.combo.perfectingLureRange` (3) e o HP de emergencia e'
     * `target.combo.perfectingLureHpPercent` (30). Usar o campo errado fazia
     * o lure esperar 4 tiles quando o jogador configurou 3.
     *
     * Os tres numeros que importam (todos ajustaveis no Shiba, e agora aqui):
     *   minWilds      target.monsters[].minCount / hoenn.minWildsToEngage  (8)
     *   range         target.combo.perfectingLureRange                     (3)
     *   minHpPercent  target.combo.perfectingLureHpPercent                 (30)
     *
     * `overrides` deixa a UI mandar esses tres sem editar arquivo. */
    const topo = this.config || {};
    const alvo = topo.target || {};
    const luring = topo.luring || alvo.luring || {};
    const combo = topo.combo || alvo.combo || {};
    const hoenn = topo.hoenn || {};
    const monsters = Array.isArray(alvo.monsters) ? alvo.monsters : [];
    const ov = topo.overrides || {};

    const minDoMonstro = monsters.length && Number.isFinite(Number(monsters[0].minCount))
      ? Number(monsters[0].minCount) : null;

    const pick = (v, def) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : def;
    };

    return {
      enabled: luring.enabled === true || luring.frontEnabled === true || luring.randomEnabled === true,
      dynamic: luring.frontEnabled === true,
      maxDistance: Number(luring.maxDistance ?? 3),
      frontRegroupMargin: Number(luring.frontRegroupMargin ?? 5),
      frontRegroupSteps: Number(luring.frontRegroupSteps ?? 3),
      /* MIN COUNT: quantos selvagens precisam estar no raio para o combo sair */
      minWilds: pick(ov.minWilds, pick(minDoMonstro ?? hoenn.minWildsToEngage, 8)),
      /* RANGE: quantos tiles do POKEMON contam como "agrupado" */
      range: pick(ov.range, pick(combo.perfectingLureRange, 3)),
      /* HP EMERGENCIAL: se o tank cair a este ponto, comba mesmo sem fechar */
      minHpPercent: pick(ov.minHpPercent, pick(combo.perfectingLureHpPercent ?? hoenn.perfectLureMinHp, 30)),
      timeoutMs: Number(hoenn.perfectLureTimeoutMs ?? 10000),
    };
  }

  /**
   * Decide a fase do lure para este tick.
   *
   * @param {object} telemetry  snapshot com position/ownPokemon/creatures
   * @param {object} ctx
   * @param {number} ctx.now            timestamp ms
   * @param {boolean} ctx.comboReady    o combo pode sair agora?
   * @param {boolean} ctx.walkerMoving  o walker esta em passo pendente?
   * @returns {{ phase: string, action: string, boxed: number, reason: string }}
   */
  decide(telemetry, ctx = {}) {
    const now = Number(ctx.now ?? Date.now());
    const cfg = this.lureConfig;

    if (!cfg.enabled) {
      if (this.phase !== LURE_PHASE.OFF) this._setPhase(LURE_PHASE.OFF, now);
      return { phase: LURE_PHASE.OFF, action: 'none', boxed: 0, reason: 'lure desligado' };
    }

    const center = telemetry?.ownPokemon?.pos || telemetry?.position;
    if (!center) {
      return { phase: this.phase, action: 'none', boxed: 0, reason: 'sem posicao' };
    }

    const creatures = Array.isArray(telemetry?.creatures) ? telemetry.creatures : [];
    const wilds = creatures.filter(c => c && c.canAttack && Number(c.healthPercent) > 0);
    const boxed = wilds.filter(c => chebyshev(center, c.pos) <= cfg.range).length;

    // ---- condicao de saida: formacao fechou OU hp baixo OU timeout
    const hp = Number(telemetry?.ownPokemon?.healthPercent ?? 100);
    const closed = boxed >= cfg.minWilds;
    const hpLow = hp <= cfg.minHpPercent;
    const timedOut = (now - (this.phaseSince || now)) >= cfg.timeoutMs;

    if (closed || hpLow || timedOut) {
      const reason = closed ? 'formacao fechada'
        : hpLow ? 'hp do tank abaixo do limite'
        : 'timeout de formacao';
      /* Marca a fase como OBSERVE (nao deixa em `off`, que significa "lure
       * desligado"). Antes o `release` mantinha a fase anterior e, logo apos
       * um reset, o display mostrava `off` com action `release` — parecia que
       * o lure estava desativado justamente quando ele liberou o combo. */
      this._setPhase(LURE_PHASE.OBSERVE, now);
      return { phase: LURE_PHASE.OBSERVE, action: 'release', boxed, reason };
    }

    // ---- sem monstros suficientes: continua o trajeto normal
    if (wilds.length === 0) {
      this._setPhase(LURE_PHASE.TRAVEL, now);
      return { phase: LURE_PHASE.TRAVEL, action: 'walk-route', boxed, reason: 'sem monstros' };
    }

    // ---- ha' monstros mas falta agrupar: pulso de ajuste
    //
    // MEDIDO: `arc` dura ~32-40 ms e mexe 1 tile; `stationary` dura ~234 ms e
    // nao mexe. O Shiba alterna travel com esses pulsos. Reproduzimos o ciclo
    // usando as MESMAS duracoes, nao um chute.
    const elapsed = now - (this.phaseSince || now);

    if (this.phase === LURE_PHASE.ARC && elapsed < MEASURED_MS.arc) {
      return { phase: LURE_PHASE.ARC, action: 'hold', boxed, reason: 'ajuste fino em curso' };
    }
    if (this.phase === LURE_PHASE.STATIONARY && elapsed < MEASURED_MS.stationary) {
      return { phase: LURE_PHASE.STATIONARY, action: 'hold', boxed, reason: 'parado agrupando' };
    }
    if (this.phase === LURE_PHASE.WAIT && elapsed < MEASURED_MS.wait) {
      return { phase: LURE_PHASE.WAIT, action: 'hold', boxed, reason: 'espera curta' };
    }

    // Progresso: a box esta' enchendo?
    if (boxed > this.bestBoxed) {
      this.bestBoxed = boxed;
      this.cyclesWithoutProgress = 0;
    } else {
      this.cyclesWithoutProgress++;
    }

    // Muito tempo sem progresso: para de ajustar e segue a rota
    // (o timeout de formacao no chamador cobre o resto).
    if (this.cyclesWithoutProgress > cfg.frontRegroupSteps) {
      this._setPhase(LURE_PHASE.TRAVEL, now);
      return { phase: LURE_PHASE.TRAVEL, action: 'walk-route', boxed,
        reason: `sem progresso em ${this.cyclesWithoutProgress} ciclos` };
    }

    // Escolhe o proximo pulso, ALTERNANDO com o atual.
    //
    // BUG CORRIGIDO (teste `pulso arc dura ~40ms`): a versao anterior usava
    // `cyclesWithoutProgress % 3 !== 2`, que devolvia `arc` de novo quando o
    // pulso anterior tambem era `arc` e o contador nao mudava. Resultado: ele
    // ficava preso em arc para sempre. Agora a escolha considera a fase atual.
    const useArc = this.phase !== LURE_PHASE.ARC;
    const next = useArc ? LURE_PHASE.ARC : LURE_PHASE.STATIONARY;
    this._setPhase(next, now);
    return {
      phase: next,
      action: useArc ? 'adjust-step' : 'hold',
      boxed,
      reason: useArc ? 'arco de agrupamento' : 'parado para colar',
    };
  }

  _setPhase(phase, now) {
    if (this.phase !== phase) {
      this.phase = phase;
      this.phaseSince = now;
      if (phase === LURE_PHASE.TRAVEL) this.bestBoxed = 0;
    }
  }
}

module.exports = { DynamicLure, LURE_PHASE, MEASURED_MS, chebyshev };
