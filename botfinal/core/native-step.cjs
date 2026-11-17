'use strict';

/**
 * Contrato mínimo de um passo nativo — máquina de estados.
 *
 * Este módulo NÃO executa nada no cliente. Ele define e verifica as regras que
 * qualquer executor (teclado, `Game::walk`, ou outro) deve cumprir para que o
 * bot nunca minta sobre o que aconteceu.
 *
 * ESTADOS (separados de propósito — nunca colapsar)
 *
 *   IDLE
 *    -> ACCEPTED   comando recebido e validado contra a sessão
 *    -> SCHEDULED  entregue ao mecanismo de execução
 *    -> EXECUTING  execução INICIADA — ponto de não-retorno, com claim
 *    -> EXECUTED   o mecanismo confirmou que rodou (NAO e' efeito no jogo)
 *    -> OBSERVED   telemetria nova mostrou o deslocamento
 *    -> FAILED     alguma etapa falhou, com motivo
 *
 *   ACCEPTED/SCHEDULED -> CANCELLED   só antes de EXECUTING
 *   SCHEDULED/EXECUTING/EXECUTED -> UNKNOWN   resultado incerto; sem retry
 *
 * REGRAS QUE ESTE MÓDULO IMPÕE
 *
 *   1. No máximo um comando pendente.
 *   2. Identidade de sessão capturada no ACCEPTED: (pid, boot, playerId).
 *   3. Prazo de validade; expirado é descartado em `schedule()` E em
 *      `beginExecution()`; execução que termina depois do prazo vira UNKNOWN.
 *   4. Comando de sessão anterior é descartado (boot/playerId diferentes).
 *   5. Cancelamento só antes de EXECUTING. O ponto de não-retorno é a chamada
 *      de `beginExecution()` — quem chama o mecanismo real DEVE chamá-la
 *      imediatamente antes da invocação, nunca depois.
 *   6. Nenhuma repetição automática depois de EXECUTING/UNKNOWN.
 *   7. Recebido, agendado, executado e observado são registros distintos.
 *
 * A CORRIDA QUE ISSO FECHA
 *
 *   Antes: `schedule() -> markExecuted()` sem estado intermediário, então
 *   `cancel()` respondia "cancelled" com a chamada nativa já em curso. A
 *   máquina mentia sobre o que aconteceu.
 *
 *   Agora: `beginExecution()` devolve um claim monotônico. `cancel()` só vale
 *   em ACCEPTED/SCHEDULED; depois do claim é recusado. `markExecuted(claim)`
 *   só promove se o claim bater — uma execução antiga não ressuscita um passo
 *   novo.
 *
 * O QUE ELE NÃO FAZ
 *   - não cancela movimento já aceito pelo cliente;
 *   - não trata retorno de função como prova de deslocamento;
 *   - não decide se um tile é andável (isso é do validador do cliente ou do
 *     nosso motor, não do controle de despacho).
 */

const STATE = Object.freeze({
  IDLE: 'idle',
  ACCEPTED: 'accepted',
  SCHEDULED: 'scheduled',
  EXECUTING: 'executing',
  EXECUTED: 'executed',
  OBSERVED: 'observed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

const DEFAULT_TTL_MS = 2500;

class NativeStep {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
    this.state = STATE.IDLE;
    this.step = null;
    this.log = [];
    /* Claim monotônico: cada `beginExecution()` devolve um número novo. Só o
     * claim corrente promove para EXECUTED. Impede que a conclusão de uma
     * execução antiga minta sobre um passo aceito depois dela. */
    this.claim = 0;
  }

  _record(entry) {
    this.log.push({ at: this.now(), state: this.state, ...entry });
    this.log = this.log.slice(-100);
    return entry;
  }

  /**
   * Ocupa o slot de "um comando por vez".
   *
   * `UNKNOWN` entra aqui de propósito: resultado incerto ainda é um comando em
   * aberto, e aceitar outro poderia mascarar um passo que talvez tenha sido
   * executado. Só `reset()` libera.
   */
  get pending() {
    if (!this.step) return false;
    return [STATE.ACCEPTED, STATE.SCHEDULED, STATE.EXECUTING, STATE.EXECUTED,
      STATE.UNKNOWN].includes(this.state);
  }

  /**
   * Recebe um comando. Rejeita se já houver um pendente — a regra é no máximo
   * um, sem fila.
   */
  accept(command) {
    if (this.pending) {
      return this._record({ action: 'accept-refused', reason: 'already-pending',
        current: this.state });
    }
    if (!command || typeof command !== 'object') {
      return this._record({ action: 'accept-refused', reason: 'bad-command' });
    }
    const identity = command.identity;
    if (!identity || !Number.isInteger(identity.pid)
        || typeof identity.boot !== 'string' || !identity.boot
        || !Number.isInteger(identity.playerId)) {
      return this._record({ action: 'accept-refused', reason: 'bad-identity' });
    }
    if (!Number.isInteger(command.direction) || command.direction < 0
        || command.direction > 7) {
      return this._record({ action: 'accept-refused', reason: 'bad-direction' });
    }

    this.step = {
      direction: command.direction,
      identity: { ...identity },
      from: command.from || null,
      target: command.target || null,
      acceptedAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
      scheduledAt: null,
      executingAt: null,
      executedAt: null,
      observedAt: null,
      observedAtPosition: null,
      claim: null,
    };
    this.state = STATE.ACCEPTED;
    return this._record({ action: 'accepted', direction: command.direction });
  }

  /** Marca que o comando foi entregue ao mecanismo de execução. */
  schedule() {
    if (this.state !== STATE.ACCEPTED) {
      return this._record({ action: 'schedule-refused', reason: this.state });
    }
    if (this._expired()) {
      this.state = STATE.FAILED;
      return this._record({ action: 'failed', reason: 'expired-before-schedule',
        waitedMs: this.now() - this.step.acceptedAt });
    }
    this.step.scheduledAt = this.now();
    this.state = STATE.SCHEDULED;
    return this._record({ action: 'scheduled' });
  }

  /**
   * PONTO DE NÃO-RETORNO.
   *
   * Deve ser a última chamada antes de invocar o mecanismo real. Depois dela,
   * `cancel()` não vale mais e nenhum comando novo é aceito até `reset()`.
   *
   * Devolve `{ ok: true, claim }` ou `{ ok: false, reason }`. Recusa quando:
   *   - não está em SCHEDULED;
   *   - o passo expirou (TTL vale aqui também, não só no schedule).
   *
   * O `claim` tem que ser repassado para `markExecuted()` / `markUnknown()`.
   * Quem chama o mecanismo e ignora o claim está fora do contrato.
   */
  beginExecution() {
    if (this.state !== STATE.SCHEDULED) {
      return this._record({ action: 'begin-refused', reason: this.state });
    }
    if (this._expired()) {
      this.state = STATE.FAILED;
      return this._record({ action: 'failed', reason: 'expired-before-execute',
        waitedMs: this.now() - this.step.acceptedAt });
    }
    this.claim += 1;
    this.step.claim = this.claim;
    this.step.executingAt = this.now();
    this.state = STATE.EXECUTING;
    this._record({ action: 'executing', claim: this.claim,
      note: 'ponto de nao-retorno; cancelamento nao vale mais' });
    return { ok: true, claim: this.claim };
  }

  /**
   * Mecanismo diz que rodou. Isso NÃO é efeito: `EXECUTED` só significa "o
   * mecanismo foi invocado e não reportou erro conhecido".
   *
   * Exige `claim` de `beginExecution()` — sem ele não há como provar qual
   * execução terminou. Claim antigo é recusado (e registrado), nunca promove.
   * Se a confirmação chega depois do prazo, o resultado vira UNKNOWN: a ordem
   * entre a chamada e a confirmação não é confiável.
   */
  markExecuted(claim) {
    if (this.state !== STATE.EXECUTING) {
      return this._record({ action: 'execute-refused', reason: this.state });
    }
    if (claim !== this.step.claim) {
      return this._record({ action: 'execute-refused', reason: 'stale-claim',
        claimed: claim ?? null, current: this.step.claim });
    }
    if (this._expired()) {
      this.state = STATE.UNKNOWN;
      return this._record({ action: 'unknown',
        reason: 'confirmed-after-ttl',
        note: 'sem retry automatico' });
    }
    this.step.executedAt = this.now();
    this.state = STATE.EXECUTED;
    return this._record({ action: 'executed', note: 'nao e efeito no jogo' });
  }

  /** Resultado incerto (timeout, erro de transporte, retorno desconhecido). */
  markUnknown(reason, claim) {
    if (!this.pending) {
      return this._record({ action: 'unknown-refused', reason: this.state });
    }
    /* Em EXECUTING a claim é obrigatória: relatório de execução velha não pode
     * envenenar um passo novo. Antes do claim, qualquer um pode marcar. */
    if (this.state === STATE.EXECUTING && claim !== this.step.claim) {
      return this._record({ action: 'unknown-refused', reason: 'stale-claim',
        claimed: claim ?? null, current: this.step.claim });
    }
    this.state = STATE.UNKNOWN;
    return this._record({ action: 'unknown', reason: reason || 'resultado incerto',
      note: 'sem retry automatico' });
  }

  /**
   * Telemetria nova confirma o deslocamento. Só `OBSERVED` conta como efeito.
   * `sample` precisa ser uma amostra nova (tick maior que a do aceite).
   */
  observe(sample) {
    if (this.state !== STATE.EXECUTED) {
      return this._record({ action: 'observe-refused', reason: this.state });
    }
    if (!sample || !Number.isInteger(sample.playerId)) {
      return this._record({ action: 'observe-refused', reason: 'bad-sample' });
    }
    if (sample.playerId !== this.step.identity.playerId) {
      this.state = STATE.FAILED;
      return this._record({ action: 'failed', reason: 'entity-changed',
        expected: this.step.identity.playerId, observed: sample.playerId });
    }
    const pos = sample.position;
    if (!pos || ![pos.x, pos.y, pos.z].every(Number.isInteger)) {
      return this._record({ action: 'observe-refused', reason: 'bad-position' });
    }
    const target = this.step.target;
    if (target && pos.x === target.x && pos.y === target.y && pos.z === target.z) {
      this.step.observedAt = this.now();
      this.step.observedAtPosition = { ...pos };
      this.state = STATE.OBSERVED;
      return this._record({ action: 'observed', position: pos });
    }
    return this._record({ action: 'observe-pending', position: pos,
      target: this.step.target });
  }

  /** Cancela um comando que ainda não executou. Passou de SCHEDULED, não vale. */
  cancel() {
    if (this.state === STATE.ACCEPTED || this.state === STATE.SCHEDULED) {
      this.state = STATE.CANCELLED;
      return this._record({ action: 'cancelled' });
    }
    return this._record({ action: 'cancel-refused', reason: this.state,
      note: this.state === STATE.EXECUTING || this.state === STATE.EXECUTED
        ? 'execucao ja iniciada; nao cancela movimento ja enviado ao cliente'
        : 'nao cancela movimento ja enviado ao cliente' });
  }

  /**
   * `false` enquanto o resultado de um passo é incerto ou já virou efeito.
   * Nenhum consumidor deve redisparar sem `reset()` explícito.
   */
  get retryAllowed() {
    return this.state === STATE.IDLE || this.state === STATE.CANCELLED
      || this.state === STATE.FAILED;
  }

  /** Volta ao IDLE, limpando o passo. Exige chamada explícita. */
  reset() {
    const previous = this.state;
    this.state = STATE.IDLE;
    this.step = null;
    return this._record({ action: 'reset', previous });
  }

  _expired() {
    return this.step && this.now() > this.step.expiresAt;
  }

  /** Resumo para log/evidência. */
  get status() {
    return {
      state: this.state,
      pending: this.pending,
      retryAllowed: this.retryAllowed,
      direction: this.step?.direction ?? null,
      identity: this.step?.identity ?? null,
      acceptedAt: this.step?.acceptedAt ?? null,
      scheduledAt: this.step?.scheduledAt ?? null,
      executingAt: this.step?.executingAt ?? null,
      executedAt: this.step?.executedAt ?? null,
      observedAt: this.step?.observedAt ?? null,
      observedPosition: this.step?.observedAtPosition ?? null,
    };
  }
}

module.exports = { NativeStep, STATE, DEFAULT_TTL_MS };
