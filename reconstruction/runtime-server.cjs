'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { frame } = require('./framing.cjs');
const { decodeAck, COMMANDS } = require('./protocol.cjs');
const { KIND, MAX_FRAME, pipePath, proof, CLIENT_DOMAIN, SERVER_DOMAIN, parseFrames } = require('./transport.cjs');

const fail = message => { throw new Error(message); };
const pidBuffer = pid => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(pid, 0); return bytes; };

class RuntimeServer extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!Number.isInteger(options.pid) || options.pid <= 0) fail('PID invalido.');
    if (typeof options.key !== 'string' || !options.key) fail('Chave do canal ausente.');
    this.pid = options.pid;
    this.key = options.key;
    this.nonce = options.nonce ? Buffer.from(options.nonce) : crypto.randomBytes(32);
    this.path = options.path || pipePath(options.pid);
    this.server = null;
    this.socket = null;
    this.parser = { buffer: Buffer.alloc(0) };
    this.authenticated = false;
    this.commands = [];
    /* kind 11 e kind 12 guardados separadamente: nao tem ACK e o efeito so'
     * aparece no kind 6/telemetria. Inicializados aqui para quem inspeciona o
     * servidor (testes) nao receber undefined quando nada foi enviado. */
    this.controls = [];
    this.lease = null;
    this.autoAck = options.autoAck !== false;
    this.commandStatus = options.commandStatus ?? 0;
    /* Fixture de TRANSPORTE (padrao): responde ACK generico com status fixo,
     * sem alegar implementacao. Serve para framing/autenticacao.
     *
     * `strict: true` e' o modo que representa o NOSSO contrato nativo: aceita
     * somente os comandos de `declaration.commands` e responde status 4
     * (UNSUPPORTED) para o resto. Uso em testes de compatibilidade. */
    this.strict = options.strict === true;
    this.declaration = options.declaration ?? null;
    this.unsupportedStatus = Number.isInteger(options.unsupportedStatus) ? options.unsupportedStatus : 4;
  }

  start() {
    if (this.server) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      this.server = net.createServer(socket => this.attach(socket));
      this.server.once('error', reject);
      this.server.listen(this.path, () => {
        this.server.removeListener('error', reject);
        this.server.on('error', error => this.emit('error', error));
        resolve(this);
      });
    });
  }

  attach(socket) {
    if (this.socket) { socket.destroy(); return; }
    this.socket = socket;
    this.authenticated = false;
    this.parser = { buffer: Buffer.alloc(0) };
    socket.on('error', error => this.emit('error', error));
    socket.on('close', () => { if (this.socket === socket) { this.socket = null; this.authenticated = false; } this.emit('disconnect'); });
    socket.on('data', chunk => {
      let frames;
      try { frames = parseFrames(this.parser, chunk); }
      catch (error) { this.emit('error', error); socket.destroy(); return; }
      for (const item of frames) {
        try { this.dispatch(item); } catch (error) { this.emit('error', error); socket.destroy(); return; }
      }
    });
    this.write(KIND.challenge, this.nonce);
    this.emit('connection', socket);
  }

  dispatch(item) {
    if (!this.authenticated && item.kind === KIND.authenticate) {
      this.authenticatePayload = Buffer.from(item.payload);
      const expected = proof(CLIENT_DOMAIN, this.key, this.nonce, this.pid);
      if (item.payload.length !== expected.length || !crypto.timingSafeEqual(expected, item.payload)) fail('Prova do cliente invalida.');
      this.authenticated = true;
      this.write(KIND.welcome, Buffer.concat([pidBuffer(this.pid), proof(SERVER_DOMAIN, this.key, this.nonce, this.pid)]));
      this.emit('authenticated');
      /* O servidor nativo publica o kind 6 logo apos o handshake. Repetir aqui
       * garante que a declaracao chegue no MESMO chunk do welcome — que e' o
       * caso que `transport.connect()` despacha antes de resolver. */
      if (this.declaration) this.publishAutomation({ capabilities: this.declaration });
      return;
    }
    if (!this.authenticated) fail('Canal nao autenticado.');
    if (item.kind === KIND.manual || item.kind === KIND.automation) {
      const record = { kind: item.kind, payload: Buffer.from(item.payload), commandId: item.payload.length >= 8 ? item.payload.readUInt32LE(0) : null };
      const type = item.payload.length >= 8 ? item.payload.readUInt32LE(4) : 0;
      record.type = type;
      this.commands.push(record);
      this.emit('command', record);
      if (this.autoAck && record.commandId !== null) {
        let status = this.commandStatus;
        if (this.strict && this.declaration) {
          const declared = Array.isArray(this.declaration.commands) ? this.declaration.commands : [];
          const implemented = new Set(declared.map(name => COMMANDS[name]).filter(value => Number.isInteger(value)));
          if (!implemented.has(type)) status = this.unsupportedStatus;
        }
        this.ack(record.commandId, type, status);
      }
      return;
    }
    /* kind 11 (automation_control): o canal de comando real do fornecedor.
     * Nao tem ACK no protocolo observado — o efeito se ve no kind 6 / telemetria.
     * Registra o payload decodificado para o teste poder afirmar o contrato. */
    if (item.kind === KIND.automation_control) {
      let body = null;
      try { body = JSON.parse(item.payload.toString('utf8')); } catch { body = null; }
      const record = { kind: item.kind, payload: Buffer.from(item.payload), body };
      this.controls = this.controls || [];
      this.controls.push(record);
      this.emit('control', record);
      return;
    }
    /* kind 12 (automation_lease): heartbeat de posse do cliente. */
    if (item.kind === KIND.automation_lease) {
      let body = null;
      try { body = JSON.parse(item.payload.toString('utf8')); } catch { body = null; }
      this.lease = body;
      this.emit('lease', body);
      return;
    }
    if (item.kind === KIND.startup) { this.emit('startup', item.payload.toString('utf8')); return; }
    this.emit('frame', item);
  }

  write(kind, payload) {
    if (!this.socket) fail('Sem cliente conectado.');
    this.socket.write(frame(kind, payload));
  }

  publishState(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== 48) fail('Estado deve ter 48 bytes.');
    this.write(KIND.state, bytes);
  }

  publishTelemetry(value) {
    this.write(KIND.telemetry, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  /* kind 6 (s2c). O fornecedor usa modules/monitor; nos acrescentamos
   * `capabilities` como extensao explicita `pka-capabilities`. */
  publishAutomation(value) {
    this.write(KIND.automation, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  ack(commandId, type, status = 0) {
    const bytes = Buffer.alloc(12);
    bytes.writeUInt32LE(commandId, 0);
    bytes.writeUInt32LE(type, 4);
    bytes.writeUInt32LE(status, 8);
    this.write(KIND.ack, bytes);
    return decodeAck(bytes);
  }

  revoke(reason) {
    this.write(KIND.automation_revoked, Buffer.from(String(reason || ''), 'utf8'));
  }

  close() {
    try { this.socket?.destroy(); } catch { /* ignore */ }
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    return new Promise(resolve => server.close(() => resolve()));
  }
}

module.exports = { RuntimeServer, MAX_FRAME };
