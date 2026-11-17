'use strict';

/**
 * Servidor mock do canal do jogo.
 *
 * Fala o MESMO protocolo do runtime nativo:
 *   - pipe `\\.\pipe\pka-runtime-2-<pid>`, maxInstances=1
 *   - challenge (kind 1) -> authenticate (kind 2) HMAC-SHA256
 *   - welcome (kind 3) com prova do servidor
 *   - state (kind 4) a cada N ms, 48 bytes
 *   - telemetry (kind 5) JSON com o schema que decodeTelemetry aceita
 *   - comando em `manual` (kind 9) -> ack (kind 10)
 *
 * O "jogo" simulado anda, seleciona alvo, usa skill e toma dano, para os
 * motores exercitarem o ciclo real sem depender do cliente.
 *
 * Uso (CLI):
 *   node tools/mock_game_pipe.cjs --pid 45000 --key <chave> --seconds 60
 *   node tools/mock_game_pipe.cjs --pid 45000 --key <chave> --json-events
 */

const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const { frame } = require('../reconstruction/framing.cjs');
const { encodeCommand, decodeAck, COMMANDS } = require('../reconstruction/protocol.cjs');
const { KIND, MAX_FRAME, proof, CLIENT_DOMAIN, SERVER_DOMAIN } = require('../reconstruction/transport.cjs');

const STATE_SIZE = 48;
const CLIENT_TICK_MS = 100;

function pipePath(pid) {
  return '\\\\' + '.' + '\\' + 'pipe' + '\\' + 'pka-runtime-2-' + pid;
}

function parseFrames(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  const frames = [];
  for (;;) {
    if (state.buffer.length < 8) break;
    const length = state.buffer.readUInt32LE(0);
    if (length > MAX_FRAME) { state.buffer = Buffer.alloc(0); break; }
    if (state.buffer.length < 8 + length) break;
    frames.push({ kind: state.buffer.readUInt32LE(4), payload: state.buffer.subarray(8, 8 + length) });
    state.buffer = state.buffer.subarray(8 + length);
  }
  return frames;
}

const DIRECTIONS = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0] };

/** Mundo simulado: o "jogo" que responde aos comandos. */
class MockWorld {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.playerName = options.playerName || 'MockTrainer';
    this.clientPid = options.clientPid ?? 0;
    this.position = { x: 100, y: 100, z: 7 };
    this.health = options.health ?? 100;
    this.mana = 100;
    this.capacity = 500;
    this.targetId = 0;
    this.attackSeq = 0;
    this.tick = 0;
    this.clockMs = 0;
    this.activeSlot = 1;
    this.pokemonName = 'Charizard';
    this.events = [];
    this.spells = [];
    this.walks = [];
    this.attacks = [];
    this.creatures = this.makeCreatures(options.creatures);
    this.pet = { id: 0x50000001, name: 'Charizard', healthPercent: 100 };
    this.roster = [{ slot: 1, uuid: 'mock-uuid-1', name: 'Charizard', healthPercent: 100,
      moves: [{ spellword: 'm1', remainingMs: 0, totalMs: 1000 },
              { spellword: 'm2', remainingMs: 0, totalMs: 1000 }] }];
  }

  makeCreatures(count = 3) {
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      rows.push({
        id: 900001 + index,
        name: index === 0 ? 'Geodude' : index === 1 ? 'Magnemite' : 'Sandshrew',
        pos: { x: 100 + (index % 3) + 1, y: 100 + Math.floor(index / 3), z: 7 },
        healthPercent: 100,
        type: 1,
        canAttack: true,
      });
    }
    return rows;
  }

  /** Aplica um comando decodificado e devolve o status do ACK. */
  apply(opcode, bytes) {
    const id = bytes.readUInt32LE(0);
    const type = bytes.readUInt32LE(4);
    const param = bytes.length >= 12 ? bytes.readUInt32LE(8) : 0;
    const record = { at: this.now(), opcode, type, param, id };
    this.events.push(record);
    switch (type) {
      case COMMANDS.walk: {
        if (param > 7) return 1;
        const delta = DIRECTIONS[param & 3] || [0, 0];
        this.position = {
          x: Math.max(0, Math.min(65534, this.position.x + delta[0])),
          y: Math.max(0, Math.min(65534, this.position.y + delta[1])),
          z: this.position.z,
        };
        this.walks.push({ direction: param, to: { ...this.position }, at: record.at });
        return 0;
      }
      case COMMANDS.attack: {
        if (!Number.isInteger(param) || param <= 0) return 1;
        this.targetId = param;
        this.attackSeq += 1;
        this.attacks.push({ targetId: param, at: record.at });
        return 0;
      }
      case COMMANDS.talk:
      case COMMANDS.combo: {
        this.spells.push({ command: Object.keys(COMMANDS).find(k => COMMANDS[k] === type), at: record.at });
        // Skill usada: o alvo toma dano.
        if (this.targetId) {
          const target = this.creatures.find(row => row.id === this.targetId);
          if (target) target.healthPercent = Math.max(0, target.healthPercent - 10);
        }
        return 0;
      }
      case COMMANDS.stop:
        this.walks.push({ direction: null, to: { ...this.position }, at: record.at });
        return 0;
      case COMMANDS.potion:
        this.health = Math.min(100, this.health + 20);
        return 0;
      default:
        return 0;
    }
  }

  /** Avança o relógio simulado: dano no player, morte de monstro, respawn. */
  advance(ms) {
    this.tick += 1;
    this.clockMs += ms;
    if (this.tick % 20 === 0 && this.targetId) this.health = Math.max(1, this.health - 5);
    for (const row of this.creatures) {
      if (row.healthPercent <= 0) {
        row.healthPercent = 100;
        row.pos = { x: 100 + (Math.random() * 4 | 0) + 1, y: 100 + (Math.random() * 3 | 0), z: 7 };
      }
    }
  }

  stateBytes() {
    const bytes = Buffer.alloc(STATE_SIZE);
    bytes.writeUInt32LE(1, 0);
    bytes.writeUInt32LE(1, 4);
    bytes.writeUInt32LE(Math.round(this.health), 8);
    bytes.writeDoubleLE(this.health * 10, 12);
    bytes.writeDoubleLE(this.mana, 20);
    bytes.writeDoubleLE(this.capacity, 28);
    bytes.writeUInt32LE(this.targetId, 36);
    bytes.writeUInt32LE(this.attackSeq, 40);
    bytes.writeUInt32LE(1, 44);
    return bytes;
  }

  telemetry() {
    const creatures = this.creatures.map((row, index) => ({
      ...row,
      struct_va: '0x' + (0x1000 + index * 0x40).toString(16),
    }));
    const pet = {
      id: this.pet.id, name: this.pet.name, pos: { x: this.position.x, y: this.position.y + 1, z: 7 },
      healthPercent: this.pet.healthPercent, type: 3, canAttack: false,
    };
    return {
      schema: 2,
      nativeVerified: true,
      pulseVersion: 3,
      tick: this.tick,
      playerId: 0x40000001,
      fightMode: 0,
      chaseMode: 0,
      clockMs: this.clockMs,
      direction: 1,
      position: { ...this.position },
      activeSlot: this.activeSlot,
      moves: [{ spellword: 'm1', remainingMs: 0, totalMs: 1000 }],
      nativeSequence: ['m1', 'm2'],
      pokemonName: this.pokemonName,
      comboPokemonName: this.pokemonName,
      conditionEvents: true,
      conditionsKnown: true,
      conditions: [],
      roster: this.roster,
      creatures: [...creatures, pet],
      items: [],
      tiles: [{ pos: { x: this.position.x, y: this.position.y, z: this.position.z }, walkable: true }],
      playerName: this.playerName,
      ownSummonId: this.pet.id,
      // decodeTelemetry exige clientPid em uint32 quando presente; null e
      // rejeitado ("clientPid: inteiro de 32 bits invalido"). O runtime real
      // publica o PID do jogo aqui.
      clientPid: this.clientPid ?? 0,
    };
  }
}

/** Servidor do pipe: ciclo de vida igual ao runtime real. */
class MockGamePipe extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!Number.isInteger(options.pid) || options.pid <= 0) throw Error('PID invalido.');
    if (typeof options.key !== 'string' || !options.key) throw Error('Chave ausente.');
    this.pid = options.pid;
    this.key = options.key;
    this.nonce = options.nonce ? Buffer.from(options.nonce) : crypto.randomBytes(32);
    this.path = options.path || pipePath(options.pid);
    this.tickMs = options.tickMs ?? CLIENT_TICK_MS;
    this.world = options.world || new MockWorld({
      now: options.now,
      clientPid: options.pid,
      playerName: options.playerName,
      health: options.health,
    });
    this.now = options.now || Date.now;
    this.server = null;
    this.socket = null;
    this.parser = { buffer: Buffer.alloc(0) };
    this.authenticated = false;
    this.commands = [];
    this.timer = null;
    this.connections = 0;
    this.rejections = [];
  }

  start() {
    if (this.server) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      const server = net.createServer(socket => this.attach(socket));
      this.server = server;
      server.once('error', reject);
      server.listen(this.path, () => {
        server.removeListener('error', reject);
        server.on('error', error => this.emit('error', error));
        resolve(this);
      });
    });
  }

  attach(socket) {
    this.connections += 1;
    if (this.socket) {
      // maxInstances=1 no runtime real: segunda conexao nao e aceita.
      this.rejections.push({ at: this.now(), reason: 'instancia ocupada' });
      socket.destroy();
      return;
    }
    this.socket = socket;
    this.authenticated = false;
    this.parser = { buffer: Buffer.alloc(0) };
    socket.on('error', error => this.emit('error', error));
    socket.on('close', () => {
      if (this.socket === socket) { this.socket = null; this.authenticated = false; }
      this.emit('disconnect');
    });
    socket.on('data', chunk => {
      let frames;
      try { frames = parseFrames(this.parser, chunk); }
      catch (error) { this.emit('error', error); socket.destroy(); return; }
      for (const item of frames) {
        try { this.dispatch(item); }
        catch (error) { this.emit('error', error); socket.destroy(); return; }
      }
    });
    this.write(KIND.challenge, this.nonce);
    this.emit('connection', socket);
  }

  dispatch(item) {
    if (!this.authenticated && item.kind === KIND.authenticate) {
      const expected = proof(CLIENT_DOMAIN, this.key, this.nonce, this.pid);
      if (item.payload.length !== expected.length
          || !crypto.timingSafeEqual(expected, item.payload)) {
        this.emit('error', Error('Prova do cliente invalida.'));
        this.socket.destroy();
        return;
      }
      this.authenticated = true;
      this.write(KIND.welcome, Buffer.concat([
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(this.pid, 0); return b; })(),
        proof(SERVER_DOMAIN, this.key, this.nonce, this.pid),
      ]));
      this.emit('authenticated');
      this.startTicking();
      return;
    }
    if (!this.authenticated) {
      this.emit('error', Error('Canal nao autenticado.'));
      this.socket.destroy();
      return;
    }
    if (item.kind === KIND.manual || item.kind === KIND.automation) {
      const commandId = item.payload.length >= 8 ? item.payload.readUInt32LE(0) : null;
      const type = item.payload.length >= 8 ? item.payload.readUInt32LE(4) : 0;
      let status;
      try { status = this.world.apply(item.payload, item.payload); }
      catch { status = 1; }
      const record = { kind: item.kind, commandId, type, status, payload: Buffer.from(item.payload) };
      this.commands.push(record);
      this.emit('command', record);
      if (commandId !== null) this.ack(commandId, type, status);
      return;
    }
    this.emit('frame', item);
  }

  startTicking() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.socket || !this.authenticated) return;
      try {
        this.world.advance(this.tickMs);
        this.publishState();
        this.publishTelemetry();
      } catch (error) { this.emit('error', error); }
    }, this.tickMs);
    this.timer.unref?.();
  }

  write(kind, payload) {
    if (!this.socket) return false;
    this.socket.write(frame(kind, payload));
    return true;
  }

  publishState() { return this.write(KIND.state, this.world.stateBytes()); }

  publishTelemetry() {
    return this.write(KIND.telemetry, Buffer.from(JSON.stringify(this.world.telemetry()), 'utf8'));
  }

  ack(commandId, type, status = 0) {
    const bytes = Buffer.alloc(12);
    bytes.writeUInt32LE(commandId, 0);
    bytes.writeUInt32LE(type, 4);
    bytes.writeUInt32LE(status, 8);
    this.write(KIND.ack, bytes);
    return decodeAck(bytes);
  }

  async close() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.socket = null;
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise(resolve => server.close(resolve));
  }
}

function main(argv) {
  const args = { pid: null, key: null, seconds: 60, jsonEvents: false, tickMs: CLIENT_TICK_MS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pid') args.pid = Number(argv[++i]);
    else if (argv[i] === '--key') args.key = argv[++i];
    else if (argv[i] === '--seconds') args.seconds = Number(argv[++i]);
    else if (argv[i] === '--tick-ms') args.tickMs = Number(argv[++i]);
    else if (argv[i] === '--json-events') args.jsonEvents = true;
  }
  if (!args.pid || !args.key) {
    console.error('uso: node tools/mock_game_pipe.cjs --pid <n> --key <chave> [--seconds 60]');
    return 2;
  }

  const server = new MockGamePipe({ pid: args.pid, key: args.key, tickMs: args.tickMs });
  server.on('error', error => console.error('[mock] erro:', error.message));
  server.on('authenticated', () => console.log('[mock] cliente autenticado'));
  server.on('disconnect', () => console.log('[mock] cliente desconectou'));
  server.on('connection', () => console.log('[mock] conexao recebida'));
  server.on('command', record => {
    const name = Object.keys(COMMANDS).find(key => COMMANDS[key] === record.type) || ('op-' + record.type);
    if (args.jsonEvents) {
      console.log(JSON.stringify({ event: 'command', name, type: record.type, status: record.status }));
    } else {
      console.log('[mock] comando ' + name + ' (op ' + record.type + ') status=' + record.status);
    }
  });

  server.start().then(() => {
    console.log('[mock] escutando em ' + server.path);
    console.log('[mock] pid=' + args.pid + ' tick=' + args.tickMs + 'ms segundos=' + args.seconds);
    setTimeout(async () => {
      const world = server.world;
      console.log('[mock] resumo: comandos=' + server.commands.length
        + ' conexoes=' + server.connections
        + ' rejeitadas=' + server.rejections.length
        + ' andadas=' + world.walks.length
        + ' ataques=' + world.attacks.length
        + ' skills=' + world.spells.length
        + ' pos=' + JSON.stringify(world.position));
      await server.close();
      process.exit(0);
    }, args.seconds * 1000);
  }).catch(error => {
    console.error('[mock] falha ao iniciar:', error.message);
    process.exit(1);
  });
  return null;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { MockGamePipe, MockWorld, pipePath };
