'use strict';

/**
 * Camada de transporte do botfinal — dois modos, uma API.
 *
 *   native : canal real do jogo (`\\.\pipe\pka-runtime-2-<pid>`), HMAC-SHA256
 *            nos dois sentidos. E o alvo final.
 *   mock   : servidor local (tools/mock_game_pipe.cjs) que fala o MESMO
 *            protocolo, no mesmo pipe, com mundo simulado. Serve para exercitar
 *            as engines sem depender do cliente.
 *
 * Os dois expoem: connect(), close(), sendCommand(name, param, options),
 * eventos 'state'/'telemetry'/'ack'/'error'/'close'. Assim os motores e o
 * BotRuntime nao sabem qual esta embaixo.
 *
 * O handshake do modo nativo e o provado em reconstruction/transport.cjs; nada
 * de HMAC proprio. O modo mock injeta a chave de teste no servidor local.
 */

const { EventEmitter } = require('node:events');
const { Transport, KIND, pipePath, proof, CLIENT_DOMAIN, SERVER_DOMAIN } = require('../../reconstruction/transport.cjs');

const PIPE_BUSY_MS = 1500;
const TRANSPORTS = Object.freeze(['native', 'mock']);

/** Erros do canal, classificados para o relatorio do --probe. */
function classify(error) {
  const message = String(error?.message || '');
  const code = error?.code || null;
  if (code === 'EAGAIN' || code === 'EBUSY' || /busy|Handshake expirou/iu.test(message)) {
    return 'busy';
  }
  if (code === 'EPIPE' || code === 'ECONNRESET' || error?.errno === -4046
      || /EPIPE|ECONNRESET|NOT_CONNECTED|233/u.test(message)) {
    return 'orphaned';
  }
  if (code === 'ENOENT' || /no such file|ENOENT/iu.test(message)) return 'missing';
  if (/prova do servidor invalida/iu.test(message)) return 'bad-key';
  return 'unknown';
}

class NativeTransport extends Transport {
  constructor(options = {}) {
    super(options);
    this.mode = 'native';
    this.pipeBusy = false;
    this.pipeOrphaned = false;
    this.failure = null;
    // O transporte base emite 'error' durante o handshake; sem listener
    // interno o EventEmitter vira excecao nao capturada.
    this.on('error', error => {
      this.failure = { kind: classify(error), message: error.message, code: error.code || null };
    });
  }

  async connect() {
    try {
      return await super.connect();
    } catch (error) {
      const kind = classify(error);
      if (kind === 'busy') { this.pipeBusy = true; error.pipeBusy = true; }
      if (kind === 'orphaned') { this.pipeOrphaned = true; error.pipeOrphaned = true; }
      error.failureKind = kind;
      throw error;
    }
  }
}

/**
 * Transporte mock: sobe o servidor local (ou usa um ja existente) e conecta
 * pelo mesmo caminho do nativo.
 */
class MockTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!Number.isInteger(options.pid) || options.pid <= 0) throw Error('PID invalido.');
    if (typeof options.key !== 'string' || !options.key) throw Error('Chave ausente.');
    this.mode = 'mock';
    this.pid = options.pid;
    this.key = options.key;
    this.path = options.path || pipePath(options.pid);
    this.tickMs = options.tickMs ?? 100;
    this.ownsServer = !options.server;
    this.server = options.server || null;
    this.inner = null;
    this.authenticated = false;
    this.state = null;
    this.telemetry = null;
    this.failure = null;
  }

  async connect() {
    if (!this.server) {
      const { MockGamePipe } = require('../../tools/mock_game_pipe.cjs');
      this.server = new MockGamePipe({
        pid: this.pid, key: this.key, tickMs: this.tickMs, path: this.path,
      });
      this.server.on('error', () => {});
      await this.server.start();
    }
    // O cliente e o mesmo do modo nativo: protocolo identico.
    this.inner = new NativeTransport({
      pid: this.pid, key: this.key, path: this.path,
      startupTimeoutMs: 5000, commandTimeoutMs: 3000,
    });
    this.inner.on('state', value => { this.state = value; this.emit('state', value); });
    this.inner.on('telemetry', value => { this.telemetry = value; this.emit('telemetry', value); });
    this.inner.on('ack', value => this.emit('ack', value));
    this.inner.on('ready', () => this.emit('ready'));
    /* kind 11/12 do servidor chegam por 'frame'; sem repassar, o
     * AutomationControl nao aprende o boot da sessao no modo mock. */
    this.inner.on('frame', item => this.emit('frame', item));
    this.inner.on('lease', value => this.emit('lease', value));
    this.inner.on('close', () => { this.authenticated = false; this.emit('close'); });
    this.inner.on('error', error => {
      this.failure = { kind: classify(error), message: error.message };
      this.emit('error', error);
    });
    await this.inner.connect();
    this.authenticated = true;
    return this;
  }

  sendCommand(name, parameter, options) {
    if (!this.inner) return Promise.reject(Error('Transporte mock nao conectado.'));
    return this.inner.sendCommand(name, parameter, options);
  }

  /** Mesmo contrato do nativo: frames crus (kind 11/12) precisam passar. */
  sendFrame(kind, payload) {
    if (!this.inner) throw Error('Transporte mock nao conectado.');
    return this.inner.sendFrame(kind, payload);
  }

  write(kind, payload) {
    if (!this.inner) throw Error('Transporte mock nao conectado.');
    return this.inner.write(kind, payload);
  }

  destroy(error) {
    try { this.inner?.destroy?.(error); } catch { /* ignore */ }
  }

  flush(timeoutMs) {
    if (!this.inner) return Promise.resolve(false);
    return this.inner.flush(timeoutMs);
  }

  get pending() { return this.inner?.pending ?? new Map(); }

  async close() {
    try { this.inner?.close(); } catch { /* ignore */ }
    this.authenticated = false;
    if (this.ownsServer && this.server) {
      const server = this.server;
      this.server = null;
      await server.close();
    }
  }
}

function createTransport(mode, options = {}) {
  if (!TRANSPORTS.includes(mode)) {
    throw Error('Transporte invalido: ' + mode + ' (use native ou mock).');
  }
  return mode === 'mock' ? new MockTransport(options) : new NativeTransport(options);
}

/**
 * Probe: conecta, espera state+telemetry por ate timeoutMs, e devolve relatorio.
 * Nao envia comando nenhum.
 */
async function probeTransport(mode, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const started = Date.now();
  const transport = createTransport(mode, options);
  const report = {
    mode, pid: options.pid, keyPresent: Boolean(options.key),
    authenticated: false, failure: null, state: null, telemetry: null,
    elapsedMs: 0, version: options.version ?? null,
  };
  let state = null;
  let telemetry = null;
  transport.on('state', value => { state = value; });
  transport.on('telemetry', value => { telemetry = value; });
  try {
    await transport.connect();
    report.authenticated = true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !(state && telemetry)) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    report.state = state;
    report.telemetry = telemetry;
    report.ok = Boolean(state && telemetry);
    report.reason = report.ok ? null : 'sem state/telemetry no prazo';
  } catch (error) {
    report.failure = { kind: error.failureKind || transport.failure?.kind || classify(error),
      message: error.message, code: error.code || null };
    report.ok = false;
    report.reason = report.failure.kind;
  } finally {
    report.elapsedMs = Date.now() - started;
    try { await transport.close(); } catch { /* ignore */ }
  }
  return { report, transport };
}

module.exports = {
  NativeTransport, MockTransport, createTransport, probeTransport,
  classify, TRANSPORTS, PIPE_BUSY_MS, KIND, pipePath, proof,
  CLIENT_DOMAIN, SERVER_DOMAIN,
};
