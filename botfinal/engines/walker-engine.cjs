'use strict';

/**
 * WalkerEngine: roteamento por waypoints com controle de passo pendente.
 *
 * PROBLEMA QUE ESTE MOTOR RESOLVE (medido no cliente em 2026-11-06 01:24Z):
 *
 *   waypoint (957,1403,6), origem (957,1404,6) — 1 tile ao norte.
 *   Dois comandos `walk 0` saíram com 294 ms de diferença; o personagem
 *   terminou em y=1402 (passou do alvo).
 *
 *   Causa: a cadência de despacho era 280 ms, mas a telemetria (de onde vem
 *   a posição) só atualiza a cada 1000 ms. O segundo tick leu a MESMA amostra
 *   e despachou outro passo sem saber que o primeiro já tinha surtido efeito.
 *
 * INVARIANTES GARANTIDAS AGORA:
 *
 *   1. Um passo pendente bloqueia qualquer novo despacho.
 *   2. Só uma amostra MAIS NOVA (tick maior) é usada para reconciliar.
 *      Amostra repetida ou fora de ordem não conclui nada.
 *   3. Amostra nova com posição ainda na origem = ainda em voo; espera.
 *   4. Posição igual ao alvo = chegou; conclui sem comando extra.
 *   5. Deslocamento que não é origem nem alvo = inesperado; aborta.
 *   6. Sem progresso além do prazo = bloqueia; não repete automaticamente.
 *   7. Mudança de entidade (playerId) ou de andar (z) = aborta.
 *   8. Ticks concorrentes não produzem dois despachos.
 *   9. pause() invalida continuações assíncronas em voo.
 *
 * O que este motor NÃO garante:
 *   - que o cliente processou o comando (só a posição confirma);
 *   - cancelar movimento já enviado (não há API para isso);
 *   - precisão temporal melhor que o intervalo da telemetria.
 *
 * LIMITAÇÃO DECLARADA: a reconciliação depende de `telemetry.tick` mudar.
 * Se o servidor publicar duas amostras com o mesmo tick, a segunda é ignorada
 * para fins de confirmação. Isso é conservador de propósito: preferimos não
 * despachar a despachar com observação duplicada.
 */

const DIRECTIONS = {
  north: 0,
  east: 1,
  south: 2,
  west: 3,
  northeast: 4,
  southeast: 5,
  southwest: 6,
  northwest: 7,
};

const ARROW_KEYS = {
  0: 'up',
  1: 'right',
  2: 'down',
  3: 'left',
};

const STEP_OFFSETS = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
  [1, -1], [1, 1], [-1, 1], [-1, -1],
];

const CADENCE_MS = 280;
const DEFAULT_PROGRESS_TIMEOUT_MS = 2500;

function getDirection(current, target) {
  const dx = target.x - current.x;
  const dy = target.y - current.y;

  if (dx === 0 && dy < 0) return DIRECTIONS.north;
  if (dx > 0 && dy === 0) return DIRECTIONS.east;
  if (dx === 0 && dy > 0) return DIRECTIONS.south;
  if (dx < 0 && dy === 0) return DIRECTIONS.west;
  if (dx > 0 && dy < 0) return DIRECTIONS.northeast;
  if (dx > 0 && dy > 0) return DIRECTIONS.southeast;
  if (dx < 0 && dy > 0) return DIRECTIONS.southwest;
  if (dx < 0 && dy < 0) return DIRECTIONS.northwest;

  return null;
}

const samePos = (a, b) => Boolean(a && b)
  && a.x === b.x && a.y === b.y && a.z === b.z;

class WalkerEngine {
  constructor(config = {}, options = {}) {
    this.config = config.walker || {};
    this.waypoints = Array.isArray(this.config.waypoints) ? this.config.waypoints : [];
    this.currentIndex = 0;
    this.waitUntil = 0;
    this.paused = false;
    this.lastWalkTime = 0;

    /* Relógio injetável: testes controlam o tempo sem sleep real. Em produção
     * é Date.now. A versão anterior usava Date.now direto, o que tornava o
     * controle de tempo não testável. */
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.progressTimeoutMs = Number.isFinite(options.progressTimeoutMs)
      ? options.progressTimeoutMs : DEFAULT_PROGRESS_TIMEOUT_MS;
    /* Identidade esperada da sessão. Se ausente, adotamos a primeira que
     * aparecer — mas nunca trocamos depois. */
    this.expectedPlayerId = Number.isInteger(options.playerId) ? options.playerId : null;

    /* Passo pendente: existe enquanto um comando foi despachado e o efeito
     * ainda não foi observado. Bloqueia novos despachos. */
    this.pendingStep = null;
    /* Bloqueio que não se libera sozinho. Exige resume()/updateConfig(). */
    this.blocked = null;
    /* Guarda contra ticks concorrentes. */
    this.inFlight = false;
    /* Invalida continuações assíncronas antigas após pause/stop. */
    this.epoch = 0;
  }

  updateConfig(config = {}) {
    this.config = config.walker || {};
    this.waypoints = Array.isArray(this.config.waypoints) ? this.config.waypoints : [];
    /* Config nova é decisão explícita do operador: limpa bloqueio e pendente. */
    this.blocked = null;
    this.pendingStep = null;
  }

  pause() {
    this.paused = true;
    /* Invalida qualquer tick que esteja aguardando o envio resolver. */
    this.epoch += 1;
    this.pendingStep = null;
  }

  resume() {
    this.paused = false;
    this.blocked = null;
  }

  /** Exposto para inspeção/diagnóstico e para o teste de contrato. */
  get state() {
    return {
      index: this.currentIndex,
      paused: this.paused,
      pending: this.pendingStep ? { ...this.pendingStep } : null,
      blocked: this.blocked ? { ...this.blocked } : null,
    };
  }

  _block(reason, detail) {
    this.blocked = { reason, at: this.now(), ...(detail || {}) };
    this.pendingStep = null;
    return { status: 'blocked', reason, ...(detail || {}) };
  }

  async tick(telemetry, transportOrActuator) {
    if (this.paused) return { status: 'idle', reason: 'paused' };
    if (!this.config.enabled || !this.waypoints.length) {
      return { status: 'idle', reason: 'disabled-or-paused' };
    }
    if (this.blocked) {
      return { status: 'blocked', reason: this.blocked.reason, blocked: this.blocked };
    }
    /* Dois ticks simultâneos: o segundo não entra. */
    if (this.inFlight) return { status: 'awaiting-progress', reason: 'tick-in-flight' };

    const now = this.now();
    const playerPos = telemetry?.position;
    if (!playerPos) return { status: 'error', reason: 'no-player-pos' };

    const sample = {
      tick: Number.isInteger(telemetry?.tick) ? telemetry.tick : null,
      playerId: Number.isInteger(telemetry?.playerId) ? telemetry.playerId : null,
      pos: { x: playerPos.x, y: playerPos.y, z: playerPos.z },
    };

    /* Identidade da sessão: adota na primeira observação, nunca troca. */
    if (this.expectedPlayerId === null && sample.playerId !== null) {
      this.expectedPlayerId = sample.playerId;
    }
    if (this.expectedPlayerId !== null && sample.playerId !== null
        && sample.playerId !== this.expectedPlayerId) {
      return this._block('entity-changed', {
        expected: this.expectedPlayerId, observed: sample.playerId });
    }

    /* --- Há um passo pendente: reconciliar antes de qualquer novo despacho --- */
    if (this.pendingStep) {
      const reconciled = this._reconcile(sample, now);
      if (reconciled) return reconciled;
      /* Ainda em voo: não despacha nada neste tick. */
      return { status: 'awaiting-progress', pending: { ...this.pendingStep } };
    }

    /* --- Sem pendente: fluxo normal --- */
    if (now < this.waitUntil) {
      return { status: 'waiting', remaining: this.waitUntil - now };
    }

    const wp = this.waypoints[this.currentIndex];
    if (!wp) {
      this.currentIndex = 0;
      return { status: 'cycle-reset' };
    }

    if (samePos(sample.pos, wp.pos)) {
      if (wp.action === 'wait') {
        const waitMs = Number(wp.param || 1000);
        this.waitUntil = now + waitMs;
        this.currentIndex = (this.currentIndex + 1) % this.waypoints.length;
        return { status: 'waypoint-reached', action: 'wait', ms: waitMs };
      }
      this.currentIndex = (this.currentIndex + 1) % this.waypoints.length;
      return { status: 'waypoint-reached', nextIndex: this.currentIndex };
    }

    /* z diferente = outro andar. Andar cardinal sem escada levaria o
     * personagem a se mover no andar errado. */
    if (Number.isInteger(wp.pos?.z) && Number.isInteger(sample.pos.z)
        && wp.pos.z !== sample.pos.z) {
      this.currentIndex = (this.currentIndex + 1) % this.waypoints.length;
      return { status: 'waypoint-skipped-z-diff',
        fromZ: sample.pos.z, toZ: wp.pos.z, targetWp: wp.pos };
    }

    const dir = getDirection(sample.pos, wp.pos);
    if (dir === null) {
      this.currentIndex = (this.currentIndex + 1) % this.waypoints.length;
      return { status: 'waypoint-skipped-no-direction', targetWp: wp.pos };
    }

    /* Cadência: evita rajada, mas NÃO é o mecanismo de controle. Quem controla
     * é o passo pendente. */
    if (now - this.lastWalkTime < CADENCE_MS) {
      return { status: 'pacing' };
    }

    const [dx, dy] = STEP_OFFSETS[dir];
    const target = { x: sample.pos.x + dx, y: sample.pos.y + dy, z: sample.pos.z };
    return this._dispatch({ dir, from: sample.pos, target, waypoint: wp.pos, sample, now,
      transportOrActuator });
  }

  /**
   * Reconcilia o passo pendente com uma amostra.
   * Devolve um resultado quando conclui algo; `null` quando continua em voo.
   */
  _reconcile(sample, now) {
    const pending = this.pendingStep;

    /* Amostra antiga, repetida ou fora de ordem: NÃO confirma nada. */
    if (sample.tick === null || pending.sampleTick === null
        || sample.tick <= pending.sampleTick) {
      this._checkTimeout(now);
      return null;
    }

    /* Andar mudou: interrompe, não reinterpreta. */
    if (sample.pos.z !== pending.target.z) {
      return this._block('floor-changed', {
        expectedZ: pending.target.z, observedZ: sample.pos.z });
    }

    /* Chegou ao alvo: conclui sem novo comando. */
    if (samePos(sample.pos, pending.target)) {
      this.pendingStep = null;
      if (!samePos(sample.pos, this.waypoints[this.currentIndex]?.pos)) {
        return { status: 'step-confirmed', nextIndex: this.currentIndex,
          confirmedBy: { tick: sample.tick, pos: sample.pos } };
      }
      this.currentIndex = (this.currentIndex + 1) % this.waypoints.length;
      return { status: 'waypoint-reached', nextIndex: this.currentIndex,
        confirmedBy: { tick: sample.tick, pos: sample.pos } };
    }

    /* Voltou à origem = ainda em voo (o jogo pode reportar antes do passo
     * aparecer). Continua aguardando; o prazo decide. */
    if (samePos(sample.pos, pending.from)) {
      this._checkTimeout(now);
      return null;
    }

    /* Não é origem nem alvo: deslocamento inesperado (overshoot, empurrão,
     * algo externo). Aborta em vez de reinterpretar como sucesso. */
    return this._block('unexpected-displacement', {
      from: pending.from, target: pending.target, observed: sample.pos,
      note: 'nem origem nem alvo; nao reinterpretado como chegada' });
  }

  /** Sem progresso além do prazo: bloqueia. Não repete. */
  _checkTimeout(now) {
    if (!this.pendingStep) return;
    if (now - this.pendingStep.dispatchedAt < this.progressTimeoutMs) return;
    this._block('no-progress-timeout', {
      dispatchedAt: this.pendingStep.dispatchedAt,
      waitedMs: now - this.pendingStep.dispatchedAt,
      timeoutMs: this.progressTimeoutMs,
      from: this.pendingStep.from, target: this.pendingStep.target,
      note: 'efeito desconhecido; nenhum novo comando e enviado' });
  }

  async _dispatch({ dir, from, target, waypoint, sample, now, transportOrActuator }) {
    /* Registra o pendente ANTES de enviar: se o envio estourar, o estado já
     * reflete que houve tentativa. Se o envio falhar de forma conhecida,
     * limpamos abaixo. */
    const pending = {
      direction: dir,
      from: { ...from },
      target: { ...target },
      sampleTick: sample.tick,
      playerId: sample.playerId,
      dispatchedAt: now,
    };
    this.pendingStep = pending;
    this.lastWalkTime = now;
    this.inFlight = true;
    const epoch = this.epoch;
    try {
      if (typeof transportOrActuator.sendCommand === 'function') {
        await transportOrActuator.sendCommand('walk', dir);
      } else if (typeof transportOrActuator.sendKey === 'function') {
        const arrow = ARROW_KEYS[dir];
        if (!arrow) throw Error('direcao sem seta cardinal: ' + dir);
        await transportOrActuator.sendKey(arrow);
      } else {
        throw Error('transporte sem sendCommand/sendKey');
      }
    } catch (err) {
      /* Falha de envio: não deixamos um pendente fantasma segurando o motor. */
      if (this.pendingStep === pending) this.pendingStep = null;
      return { status: 'error', command: 'walk', error: err.message };
    } finally {
      this.inFlight = false;
    }

    /* pause()/stop durante o envio: descarta a continuação. O comando já saiu
     * e não é cancelável; só não confirmamos nem despachamos outro. */
    if (epoch !== this.epoch || this.paused) {
      if (this.pendingStep === pending) this.pendingStep = null;
      return { status: 'aborted', reason: 'paused-during-dispatch' };
    }

    return {
      status: 'step-dispatched',
      direction: dir,
      targetWp: waypoint,
      pending: { ...pending },
    };
  }
}

module.exports = {
  WalkerEngine, DIRECTIONS, CADENCE_MS, DEFAULT_PROGRESS_TIMEOUT_MS,
};
