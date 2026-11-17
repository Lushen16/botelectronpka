'use strict';

/**
 * Canal de comando real do botfinal — kind 11 (automation_control).
 *
 * CONTEXTO (medido, nao suposto)
 * O fornecedor NAO usa comandos avulsos por criatura. O menu manda a CONFIG
 * INTEIRA uma vez, com op:"start", e o runtime em C++ executa com a arvore de
 * entidades dele. Medido: kind 9 = 0 em 105.722 frames; kind 11 = 20 na
 * captura limpa. Ver research/shiba_tap/KIND11_SCHEMA.md.
 *
 * ESTE MODULO
 * Fala o kind 11 pelo transporte que o botfinal ja usa, com estados explicitos
 * e sem dependencia de research/: o codec e' botfinal/core/kind11-codec.cjs e
 * a config base e' botfinal/config/kind11/target-config.json.
 *
 *   preparado -> conectado -> pronto
 *   falhas  : busy | orphaned | missing | bad-key | timeout | rejected | no-boot
 *
 * IDENTIDADE (medida em native/pka_tap_8036.jsonl)
 *   boot   -> nasce no SERVIDOR. Aparece no kind 6 (s2c) 51.409 frames antes
 *             de qualquer kind 12. O menu apenas ecoa o valor no lease.
 *             Portanto o boot tem que ser aprendido da sessao; um boot local
 *             so' serve de fallback e nunca foi provado aceito pelo fornecedor.
 *   client -> nasce no MENU (c2s). Primeira aparicao no kind 12, 32 hex
 *             proprios. Pode ser gerado localmente.
 *   lease  -> kind 12 sai c2s no MESMO t de cada kind 11, com `counter`
 *             crescente (1,2,3,...). Nunca sai sozinho.
 *
 * LIMITE DECLARADO
 * O kind 11 NAO tem ACK. "Enviado" significa que o frame saiu pelo transporte
 * autenticado. O efeito so' pode ser confirmado pelo kind 6 / telemetria.
 * Este modulo nunca reporta `effect: true` sem essa confirmacao.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  KIND_AUTOMATION_CONTROL, KIND_AUTOMATION_LEASE,
  OBSERVED_OP, OBSERVED_MODULE, baseConfig, buildPayload, buildLeasePayload, HEX32,
} = require('./kind11-codec.cjs');

const STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  READY: 'ready',
  BUSY: 'busy',
  ERROR: 'error',
});

const KIND_AUTOMATION = 6;
const KIND_LEASE = 12;

const localHex = () => crypto.randomBytes(16).toString('hex');

/**
 * Identidade local: `client` e' legitimo (o menu gera o dele). `boot` NAO e' —
 * fica marcado como `local` para o chamador saber que ele nao veio da sessao.
 */
function freshIdentity(pid) {
  return { boot: localHex(), client: localHex(), pid, bootSource: 'local' };
}

function decodeBody(payload) {
  if (!payload) return null;
  if (Buffer.isBuffer(payload)) {
    try { return JSON.parse(payload.toString('utf8')); } catch { return null; }
  }
  if (typeof payload === 'string') {
    try { return JSON.parse(payload); } catch { return null; }
  }
  if (typeof payload === 'object') return payload;
  return null;
}

class AutomationControl {
  constructor(options = {}) {
    if (!options.transport) throw Error('transport e obrigatorio');
    this.transport = options.transport;
    this.pid = options.pid ?? this.transport.pid ?? null;
    this.identity = normalizeIdentity(options.identity, this.pid);
    this.state = STATE.DISCONNECTED;
    this.lastError = null;
    this.log = [];
    this.sent = [];
    this.leases = [];
    this.seq = Number.isInteger(options.seq) ? options.seq : 0;
    this.counter = Number.isInteger(options.counter) ? options.counter : 0;
    this.strict = options.strict !== false;
    this.config = options.config || null;

    /* Lease: medido no fornecedor (kind 12 antes de cada kind 11), mas nao
     * provado necessario no nosso runtime. Desligado por padrao. */
    this.withLease = options.withLease === true;
    this.requireSessionBoot = options.requireSessionBoot === true;
    this.bootWaitMs = options.bootWaitMs ?? 0;

    this._connecting = null;
    this._emitter = new EventEmitter();
    this._attachIdentitySource();
  }

  /* A API publica do EventEmitter local (usada nos testes). */
  on(...args) { this._emitter.on(...args); return this; }
  emit(...args) { return this._emitter.emit(...args); }

  /**
   * O servidor publica `boot` no kind 6 e o menu ecoa no kind 12. Escutamos os
   * dois: o primeiro boot valido vira o nosso e passa a ter precedencia sobre
   * qualquer id local.
   */
  _attachIdentitySource() {
    const onFrame = item => {
      if (!item || typeof item !== 'object') return;
      if (item.kind !== KIND_AUTOMATION && item.kind !== KIND_LEASE) return;
      const body = decodeBody(item.payload);
      if (!body) return;
      if (typeof body.boot === 'string' && HEX32.test(body.boot)) {
        this.identity.boot = body.boot;
        this.identity.bootSource = 'session';
        this.identity.bootFrom = item.kind === KIND_LEASE ? 'lease' : 'automation';
      }
      if (typeof body.client === 'string' && HEX32.test(body.client)) {
        /* Observado, nao adotado: o client da sessao e' de OUTRO menu. */
        this.identity.sessionClient = body.client;
      }
    };
    const onError = error => { this.lastTransportError = error?.message || String(error); };
    const onClose = () => {
      if (this.state === STATE.READY || this.state === STATE.CONNECTING) {
        this._set(STATE.DISCONNECTED, 'canal fechado');
      }
    };
    this.transport.on?.('frame', onFrame);
    this.transport.on?.('error', onError);
    this.transport.on?.('close', onClose);
    this._offFrame = () => {
      try { this.transport.removeListener?.('frame', onFrame); } catch { /* ignore */ }
      try { this.transport.removeListener?.('error', onError); } catch { /* ignore */ }
      try { this.transport.removeListener?.('close', onClose); } catch { /* ignore */ }
    };
  }

  /** Muda de estado e registra. Nao engole erro. */
  _set(next, detail) {
    this.state = next;
    if (detail) this.lastError = detail; else if (next !== STATE.ERROR) this.lastError = null;
    this.log.push({ at: Date.now(), state: next, detail: detail || null });
    return next;
  }

  /** Aborta o transporte depois de um timeout: nao deixa socket pendurado. */
  _abort(error) {
    try { this.transport.destroy?.(error); } catch { /* ignore */ }
    try { this.transport.close?.(); } catch { /* ignore */ }
  }

  /**
   * Conecta e valida a sessao.
   *
   * O timer NAO e' unref'd: um timer unref'd deixa o event loop morrer antes de
   * disparar quando nada mais esta' pendente — foi exatamente o
   * `cancelledByParent` do node:test. Ele e' limpo em todo caminho de saida,
   * entao nao segura o processo depois.
   */
  async connect({ timeoutMs = 5000 } = {}) {
    if (this._connecting) return this._connecting;
    const attempt = this._connect({ timeoutMs });
    this._connecting = attempt.finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connect({ timeoutMs }) {
    this._set(STATE.CONNECTING);
    const started = Date.now();
    /* Ja autenticado por fora (index.cjs conectou antes)? Nao reconecta:
     * MockTransport.connect() subiria um segundo servidor. */
    const already = this.transport.authenticated === true;
    const outcome = already ? { ok: true } : await this._raceConnect(timeoutMs);

    if (!outcome.ok) {
      const kind = classifyFailure(outcome.error);
      this._set(kind === 'busy' ? STATE.BUSY : STATE.ERROR, outcome.error.message);
      return { ok: false, state: this.state, failure: kind,
        message: outcome.error.message, elapsedMs: Date.now() - started };
    }

    if (this.requireSessionBoot && this.identity.bootSource !== 'session'
        && this.bootWaitMs > 0) {
      await this._waitForBoot(this.bootWaitMs);
    }
    if (this.requireSessionBoot && this.identity.bootSource !== 'session') {
      const error = Object.assign(Error('boot da sessao ausente no kind 6/12'),
        { code: 'ENOBOOT' });
      this._set(STATE.ERROR, error.message);
      return { ok: false, state: this.state, failure: 'no-boot',
        message: error.message, elapsedMs: Date.now() - started };
    }

    this._set(STATE.READY);
    return {
      ok: true, state: this.state, elapsedMs: Date.now() - started,
      identity: { ...this.identity },
    };
  }

  /**
   * Uma promise, um timer, uma flag. A promise do transporte e' SEMPRE
   * consumida (os dois handlers existem), entao uma rejeicao tardia depois do
   * timeout nao vira unhandledRejection e nao muda o estado.
   */
  _raceConnect(timeoutMs) {
    return new Promise(resolve => {
      let settled = false;
      const finish = outcome => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        const error = Object.assign(Error('connect timeout'), { code: 'ETIMEDOUT' });
        /* Fecha o que estiver aberto ANTES de resolver: socket pendurado segura
         * o event loop e o node:test cancela o resto da suite. */
        this._abort(error);
        finish({ ok: false, error });
      }, timeoutMs);
      Promise.resolve()
        .then(() => this.transport.connect())
        .then(
          () => finish({ ok: true }),
          error => finish({ ok: false,
            error: error instanceof Error ? error : Error(String(error)) }),
        );
    });
  }

  _waitForBoot(timeoutMs) {
    if (this.identity.bootSource === 'session') return Promise.resolve(true);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); clearInterval(tick); };
      const timer = setTimeout(() => { done(); resolve(false); }, timeoutMs);
      const tick = setInterval(() => {
        if (this.identity.bootSource === 'session') { done(); resolve(true); }
      }, 10);
      tick.unref?.();
    });
  }

  /** Envia frames crus. Unico ponto que fala com o transporte. */
  async _send(kind, payload) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    if (typeof this.transport.sendFrame === 'function'
        && this.transport.authenticated !== false) {
      this.transport.sendFrame(kind, bytes);
      /* kind 11/12 nao tem ACK. Sem drenar a fila, um close() imediato
       * descarta o frame e o servidor nunca recebe — ja' aconteceu no
       * caminho --auto. */
      if (typeof this.transport.flush === 'function') {
        await this.transport.flush(this.flushTimeoutMs ?? 2000);
      } else {
        await new Promise(resolve => setImmediate(resolve));
      }
      return { kind, bytes: bytes.length };
    }
    if (typeof this.transport.sendRaw === 'function') {
      await this.transport.sendRaw(kind, bytes);
      return { kind, bytes: bytes.length };
    }
    throw Error('transporte sem sendFrame/sendRaw');
  }

  /** kind 12 imediatamente antes do controle, como o menu faz. */
  async lease() {
    this.counter += 1;
    const payload = buildLeasePayload(this.identity, this.counter);
    const { bytes } = await this._send(KIND_AUTOMATION_LEASE, payload);
    const record = { kind: KIND_AUTOMATION_LEASE, counter: payload.counter, bytes,
      boot: payload.boot, client: payload.client };
    this.leases.push(record);
    return record;
  }

  /** Envolve uma operacao com checagem de estado. Nunca engole a excecao. */
  async _op(name, fn) {
    if (this.state !== STATE.READY) {
      return { ok: false, op: name, failure: this.state, message: 'canal nao esta pronto' };
    }
    try {
      if (this.withLease) await this.lease();
      const result = await fn();
      this.log.push({ at: Date.now(), op: name, seq: result.seq, bytes: result.bytes });
      return {
        ok: true, op: name, seq: result.seq, bytes: result.bytes,
        module: result.module ?? null,
        boot: result.boot ?? this.identity.boot,
        client: result.client ?? this.identity.client,
        bootSource: this.identity.bootSource ?? null,
        /* Enviado != executado. O kind 11 nao tem ACK. */
        sent: true, effect: 'unverified',
      };
    } catch (error) {
      this._set(STATE.ERROR, error.message);
      return { ok: false, op: name, failure: classifyFailure(error),
        message: error.message };
    }
  }

  /** Monta o payload e envia. `seq` e' compartilhado e monotonomico. */
  async send(op, options = {}) {
    this.seq += 1;
    const payload = buildPayload(op, {
      identity: this.identity,
      seq: this.seq,
      module: options.module ?? null,
      config: options.config || this.config || undefined,
      enabled: options.enabled,
      pauseMonitor: options.pauseMonitor,
      key: options.key,
      forceConfig: options.forceConfig,
      strict: this.strict,
    });
    const { bytes } = await this._send(KIND_AUTOMATION_CONTROL, payload);
    const record = { kind: KIND_AUTOMATION_CONTROL, op, seq: payload.seq, bytes,
      boot: payload.boot, client: payload.client };
    if (payload.module) record.module = payload.module;
    this.sent.push(record);
    return record;
  }

  start(module, overrides = {}) {
    return this._op('start', () => this.send('start', { ...overrides, module }));
  }

  stop(module, overrides = {}) {
    return this._op('stop', () => this.send('stop', { ...overrides, module }));
  }

  monitor(enabled = true, overrides = {}) {
    return this._op('monitor', () => this.send('monitor', { ...overrides, enabled }));
  }

  togglePause(pauseMonitor = false, overrides = {}) {
    return this._op('togglePause', () => this.send('togglePause', { ...overrides, pauseMonitor }));
  }

  /** Fecha o transporte e volta a DISCONNECTED. */
  async close() {
    this._offFrame?.();
    try { await this.transport.close?.(); } catch { /* ignore */ }
    this._set(STATE.DISCONNECTED);
    return { state: this.state };
  }
}

function normalizeIdentity(identity, pid) {
  const base = identity ? { ...identity } : { client: localHex() };
  if (!HEX32.test(String(base.client || ''))) base.client = localHex();
  if (HEX32.test(String(base.boot || ''))) {
    base.bootSource = base.bootSource || 'provided';
  } else {
    base.boot = localHex();
    base.bootSource = 'local';
  }
  if (pid != null) base.pid = pid;
  return base;
}

function classifyFailure(error) {
  const message = String(error?.message || '');
  const code = error?.code || null;
  if (code === 'EAGAIN' || code === 'EBUSY' || /busy|Handshake expirou/iu.test(message)) return 'busy';
  if (code === 'EPIPE' || code === 'ECONNRESET' || error?.errno === -4046
      || /EPIPE|ECONNRESET|NOT_CONNECTED|233/u.test(message)) return 'orphaned';
  if (code === 'ENOENT' || /no such file|ENOENT/iu.test(message)) return 'missing';
  if (code === 'ETIMEDOUT' || /timeout|expirou/iu.test(message)) return 'timeout';
  if (code === 'ENOBOOT' || /boot da sessao ausente/iu.test(message)) return 'no-boot';
  if (/prova do servidor invalida|prova do cliente invalida/iu.test(message)) return 'bad-key';
  return 'unknown';
}

module.exports = { AutomationControl, STATE, classifyFailure, freshIdentity,
  normalizeIdentity, localHex, baseConfig, OBSERVED_OP, OBSERVED_MODULE };
