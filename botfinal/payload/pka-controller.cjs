'use strict';

/**
 * Controlador injetado no Electron do menu original.
 *
 * Estrategia: em vez de competir pelo pipe (maxInstances=1, e o runtime fecha o
 * canal quando o menu cai), este modulo e carregado ANTES do main.jsc. Ele
 * intercepta `net.connect` e captura o socket que o menu original abre para
 * `\\.\pipe\pka-runtime-2-<pid>`. O menu faz o handshake nativo exatamente como
 * sempre; nos apenas observamos os quadros e escrevemos comandos no MESMO socket
 * ja autenticado.
 *
 * Nada aqui implementa HMAC proprio nem forja identidade: o processo continua
 * sendo o Electron do menu, com o mesmo caminho de imagem, o mesmo PID filho e
 * a mesma sessao. O DLL ve exatamente o cliente de sempre.
 *
 * Dependencias sao carregadas por caminho absoluto (PKA_BOTFINAL_DIR) para nao
 * precisar empacotar o repositorio dentro do app.asar.
 */

const net = require('node:net');
const path = require('node:path');

const RUNTIME_PIPE_MARKER = 'pka-runtime-2-';
const KIND = Object.freeze({
  challenge: 1, authenticate: 2, welcome: 3, state: 4, telemetry: 5,
  automation: 6, startup: 7, automation_revoked: 8, manual: 9, ack: 10,
  automation_control: 11, automation_lease: 12,
});
const MAX_FRAME = 2105344;

function rootDir() {
  // payload/ -> botfinal/ -> raiz do repositorio (onde vive reconstruction/)
  return process.env.PKA_BOTFINAL_DIR
    || path.resolve(__dirname, '..', '..');
}

function loadRepoModule(relative) {
  return require(path.join(rootDir(), relative));
}

function log(message) {
  try {
    const line = '[pka-controller] ' + message + '\n';
    process.stdout.write(line);
    const dir = process.env.PKA_CONTROLLER_LOG_DIR;
    if (dir) {
      require('node:fs').appendFileSync(path.join(dir, 'controller.log'), line);
    }
  } catch { /* logging nunca deve derrubar o menu */ }
}

/** Parser incremental de quadros [u32 len][u32 kind][payload]. */
function createParser(onFrame) {
  let buffer = Buffer.alloc(0);
  return function push(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 8) return;
      const length = buffer.readUInt32LE(0);
      if (length > MAX_FRAME) { buffer = Buffer.alloc(0); return; }
      if (buffer.length < 8 + length) return;
      const kind = buffer.readUInt32LE(4);
      const payload = buffer.subarray(8, 8 + length);
      buffer = buffer.subarray(8 + length);
      onFrame(kind, payload);
    }
  };
}

class CapturedChannel {
  constructor(socket, options) {
    this.socket = socket;
    this.options = options;
    this.authenticated = false;
    this.state = null;
    this.telemetry = null;
    this.stateAt = null;
    this.telemetryAt = null;
    this.error = null;
    this.closed = false;
    this.nextCommandId = 1;
    this.pending = new Map();
    this.now = options.now || Date.now;
    this.frame = options.frame;
    this.encodeCommand = options.encodeCommand;
    this.push = createParser((kind, payload) => this.onFrame(kind, payload));

    socket.on('data', chunk => this.push(chunk));
    socket.on('close', () => {
      this.closed = true;
      log('canal encerrado');
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(Error('Canal encerrado.'));
      }
      this.pending.clear();
    });
    socket.on('error', error => {
      this.error = error.message;
      log('erro no socket: ' + error.message);
    });
  }

  onFrame(kind, payload) {
    if (kind === KIND.welcome) {
      this.authenticated = true;
      log('welcome recebido; canal autenticado pelo menu');
      this.options.onAuthenticated?.(this);
      return;
    }
    if (kind === KIND.state) {
      try { this.state = this.options.decodeState(payload); this.stateAt = this.now(); }
      catch (error) { this.error = error.message; }
      return;
    }
    if (kind === KIND.telemetry) {
      try { this.telemetry = this.options.decodeTelemetry(payload); this.telemetryAt = this.now(); }
      catch (error) { this.error = error.message; }
      return;
    }
    if (kind === KIND.ack) {
      const commandId = payload.length >= 4 ? payload.readUInt32LE(0) : null;
      const status = payload.length >= 12 ? payload.readUInt32LE(8) : null;
      const pending = commandId !== null ? this.pending.get(commandId) : null;
      if (pending) {
        this.pending.delete(commandId);
        clearTimeout(pending.timer);
        pending.resolve({ commandId, status, type: payload.length >= 8 ? payload.readUInt32LE(4) : null });
      }
      return;
    }
    if (kind === KIND.automation_revoked) {
      this.error = 'automacao revogada';
      log('automacao revogada pelo runtime');
    }
  }

  /** Snapshot no formato consumido pelos motores, com frescor. */
  snapshot() {
    if (!this.state || !this.telemetry) return null;
    const stamp = this.now();
    const ageMs = Math.max(stamp - (this.stateAt || stamp), stamp - (this.telemetryAt || stamp));
    return {
      generatedAt: new Date(stamp).toISOString(),
      pid: this.options.pid,
      online: !this.closed && !this.error && this.state.online === true,
      stale: !Number.isFinite(ageMs) || ageMs < 0 || ageMs > (this.options.maxAgeMs || 1500),
      ageMs,
      error: this.error,
      authExpired: this.state.authExpired === true,
      healthPercent: this.state.healthPercent,
      telemetry: this.telemetry,
    };
  }

  /** Envia comando no quadro `manual`, como o menu faz. */
  sendCommand(name, parameter = 0, options = {}) {
    if (!this.authenticated) return Promise.reject(Error('Canal ainda nao autenticado.'));
    if (this.closed) return Promise.reject(Error('Canal encerrado.'));
    const commandId = this.nextCommandId;
    this.nextCommandId = (this.nextCommandId + 1) >>> 0 || 1;
    let bytes;
    try { bytes = this.encodeCommand(commandId, name, parameter, options); }
    catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(commandId);
        reject(Error('ACK expirou para ' + name + '.'));
      }, this.options.commandTimeoutMs || 1500);
      this.pending.set(commandId, { resolve, reject, timer });
      try { this.socket.write(this.frame(KIND.manual, bytes)); }
      catch (error) { clearTimeout(timer); this.pending.delete(commandId); reject(error); }
    });
  }

  close() { try { this.socket.destroy(); } catch { /* ignore */ } }
}

function install(overrides = {}) {
  if (global.__pkaController) return global.__pkaController;

  const options = {
    pid: null,
    maxAgeMs: 1500,
    commandTimeoutMs: 1500,
    ...overrides,
  };

  const channels = [];
  const listeners = [];
  const originalConnect = net.connect;
  const originalCreateConnection = net.createConnection;

  function maybeAttach(socket, target) {
    if (!String(target || '').includes(RUNTIME_PIPE_MARKER)) return socket;
    const channel = new CapturedChannel(socket, {
      ...options,
      pid: options.pid || Number(String(target).split(RUNTIME_PIPE_MARKER)[1]) || null,
      frame: overrides.frame || loadRepoModule('reconstruction/framing.cjs').frame,
      encodeCommand: overrides.encodeCommand || loadRepoModule('reconstruction/protocol.cjs').encodeCommand,
      decodeState: overrides.decodeState || loadRepoModule('reconstruction/protocol.cjs').decodeState,
      decodeTelemetry: overrides.decodeTelemetry || loadRepoModule('reconstruction/telemetry.cjs').decodeTelemetry,
      onAuthenticated: channel => {
        for (const listener of listeners) {
          try { listener(channel); } catch (error) { log('listener falhou: ' + error.message); }
        }
      },
    });
    channels.push(channel);
    log('canal capturado: ' + target);
    return socket;
  }

  net.connect = function patchedConnect(...args) {
    const target = typeof args[0] === 'string' ? args[0]
      : (args[0] && (args[0].path || args[0].host)) || '';
    return maybeAttach(originalConnect.apply(this, args), target);
  };
  net.createConnection = function patchedCreateConnection(...args) {
    const target = typeof args[0] === 'string' ? args[0]
      : (args[0] && (args[0].path || args[0].host)) || '';
    return maybeAttach(originalCreateConnection.apply(this, args), target);
  };

  const controller = {
    get channels() { return channels; },
    get authenticated() { return channels.filter(row => row.authenticated); },
    onAuthenticated(listener) {
      listeners.push(listener);
      for (const channel of channels.filter(row => row.authenticated)) {
        try { listener(channel); } catch { /* ignore */ }
      }
      return controller;
    },
    /** Inicia o runtime do botfinal no primeiro canal autenticado. */
    startBot(loadBot) {
      return controller.onAuthenticated(channel => {
        if (controller.bot) return;
        try {
          controller.bot = loadBot(channel);
          log('runtime do botfinal iniciado');
        } catch (error) {
          log('falha ao iniciar botfinal: ' + error.message);
        }
      });
    },
    restore() {
      net.connect = originalConnect;
      net.createConnection = originalCreateConnection;
      global.__pkaController = null;
    },
  };

  global.__pkaController = controller;
  log('hook de net.connect instalado');
  return controller;
}

module.exports = { install, CapturedChannel, createParser, KIND, RUNTIME_PIPE_MARKER };
