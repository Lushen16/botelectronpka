'use strict';

/**
 * Cliente mínimo do canal PKA2 — vive só na área do tap.
 *
 * Serve para provar o tap sem importar nada de botfinal/ nem reconstruction/,
 * que pertencem ao agente do bot. Se ele refatorar o transporte dele, o teste
 * do tap continua verde.
 *
 * Implementa só o necessário para gerar tráfego observável:
 *   challenge -> authenticate(HMAC) -> welcome -> state/telemetry -> manual/ack
 *
 *   node tools/tap_client.cjs --pid 49123 --key <hex> --commands walk,hotkey
 */

const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');

const MAX_FRAME = 2105344;
const KIND = Object.freeze({
  challenge: 1, authenticate: 2, welcome: 3, state: 4, telemetry: 5,
  automation_revoked: 8, manual: 9, ack: 10,
});

/* Mesmo vocabulário do reconstruction/protocol.cjs, copiado aqui de propósito:
 * é contrato de fio, não código compartilhado. */
const COMMANDS = Object.freeze({
  walk: 1, attack: 2, follow: 3, stop: 4, focus: 5, talk: 6, combo: 7,
  switchPokemon: 8, action: 9, fight: 11, potion: 12, revive: 13, useWith: 14,
  recallPokemon: 15, order: 16, turn: 17, refreshCombo: 18, chase: 19,
  hotkey: 20, orderGround: 21, guildDaily: 25,
});

const CLIENT_DOMAIN = 'PKA2/client\0';
const SERVER_DOMAIN = 'PKA2/server\0';

const pipePath = pid => `\\\\.\\pipe\\pka-runtime-2-${pid}`;

function proof(domain, key, nonce, pid) {
  const pidBytes = Buffer.alloc(4);
  pidBytes.writeUInt32LE(pid, 0);
  return crypto
    .createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(domain, 'utf8'), nonce, pidBytes]))
    .digest();
}

function frame(kind, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(payload.length, 0);
  header.writeUInt32LE(kind, 4);
  return Buffer.concat([header, payload]);
}

/** Payload de 24 bytes fixos + texto em 24, igual ao encodeCommand do protocolo. */
function encodeCommand(commandId, name, parameter) {
  const type = COMMANDS[name];
  if (!type) throw Error('comando desconhecido: ' + name);
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32LE(commandId >>> 0, 0);
  bytes.writeUInt32LE(type, 4);
  if (typeof parameter === 'string') {
    const text = Buffer.from(parameter, 'utf8');
    bytes.writeUInt32LE(text.length, 8);
    return Buffer.concat([bytes, text]);
  }
  bytes.writeUInt32LE(Number(parameter) >>> 0, 8);
  return bytes;
}

/**
 * Conecta, autentica e devolve o transporte.
 * Emite: state, telemetry, ack, error.
 */
function connect({ pid, key, path, timeoutMs = 4000 }) {
  const emitter = new EventEmitter();
  emitter.pending = new Map();
  emitter.nextCommandId = 1;
  emitter.authenticated = false;

  const target = path || pipePath(pid);
  const socket = net.createConnection(target);
  emitter.socket = socket;

  let buffer = Buffer.alloc(0);
  let nonce = null;

  const timer = setTimeout(() => {
    if (!emitter.authenticated) {
      socket.destroy();
      emitter.emit('error', Error('handshake expirou'));
    }
  }, timeoutMs);

  socket.on('connect', () => {
    emitter.emit('connected');
  });

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 8) break;
      const len = buffer.readUInt32LE(0);
      const kind = buffer.readUInt32LE(4);
      if (len > MAX_FRAME) { socket.destroy(); return; }
      if (buffer.length < 8 + len) break;
      const payload = buffer.subarray(8, 8 + len);
      buffer = buffer.subarray(8 + len);

      if (kind === KIND.challenge) {
        nonce = Buffer.from(payload);
        const response = proof(CLIENT_DOMAIN, key, nonce, pid);
        socket.write(frame(KIND.authenticate, response));
      } else if (kind === KIND.welcome) {
        const serverPid = payload.readUInt32LE(0);
        const expected = proof(SERVER_DOMAIN, key, nonce, pid);
        const got = payload.subarray(4, 36);
        if (serverPid !== pid || !got.equals(expected)) {
          emitter.emit('error', Error('prova do servidor invalida'));
          socket.destroy();
          return;
        }
        emitter.authenticated = true;
        clearTimeout(timer);
        emitter.emit('authenticated');
      } else if (kind === KIND.ack) {
        const commandId = payload.readUInt32LE(0);
        const type = payload.readUInt32LE(4);
        const status = payload.readUInt32LE(8);
        const entry = emitter.pending.get(commandId);
        if (entry) {
          emitter.pending.delete(commandId);
          entry.resolve({ commandId, type, status });
        }
        emitter.emit('ack', { commandId, type, status });
      } else if (kind === KIND.state) {
        emitter.emit('state', decodeState(payload));
      } else if (kind === KIND.telemetry) {
        try {
          emitter.emit('telemetry', JSON.parse(payload.toString('utf8').replace(/^\uFEFF/, '')));
        } catch {
          emitter.emit('telemetry', { error: 'json invalido' });
        }
      }
    }
  });

  socket.on('error', error => emitter.emit('error', error));
  socket.on('close', () => {
    clearTimeout(timer);
    for (const [, entry] of emitter.pending) entry.reject(Error('canal encerrado'));
    emitter.pending.clear();
    emitter.emit('close');
  });

  emitter.send = (name, parameter) => {
    if (!emitter.authenticated) return Promise.reject(Error('nao autenticado'));
    const commandId = emitter.nextCommandId++;
    const payload = encodeCommand(commandId, name, parameter);
    return new Promise((resolve, reject) => {
      const handle = setTimeout(() => {
        emitter.pending.delete(commandId);
        reject(Error('ack expirou'));
      }, 3000);
      emitter.pending.set(commandId, {
        resolve: value => { clearTimeout(handle); resolve(value); },
        reject: error => { clearTimeout(handle); reject(error); },
      });
      socket.write(frame(KIND.manual, payload));
    });
  };

  emitter.close = () => socket.destroy();
  return emitter;
}

function decodeState(bytes) {
  if (bytes.length !== 48) return { error: 'state com ' + bytes.length + ' bytes' };
  return {
    version: bytes.readUInt32LE(0),
    online: bytes.readUInt32LE(4),
    healthPercent: bytes.readUInt32LE(8),
    hp: bytes.readDoubleLE(12),
    mana: bytes.readDoubleLE(20),
    cap: bytes.readDoubleLE(28),
    targetId: bytes.readUInt32LE(36),
    attackSeqNum: bytes.readUInt32LE(40),
    protoVersion: bytes.readUInt32LE(44),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { pid: null, key: null, commands: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pid') options.pid = Number(argv[++i]);
    else if (argv[i] === '--key') options.key = argv[++i];
    else if (argv[i] === '--commands') options.commands = argv[++i];
  }
  if (!options.pid || !options.key) {
    console.log('uso: node tools/tap_client.cjs --pid <pid> --key <hex> [--commands walk,hotkey]');
    process.exitCode = 1;
    return;
  }

  const client = connect({ pid: options.pid, key: options.key });
  client.on('error', error => console.log('erro:', error.message));
  client.on('state', state => console.log('state:', JSON.stringify(state)));
  client.on('telemetry', telemetry => console.log('telemetry:', JSON.stringify(telemetry).slice(0, 160)));

  await new Promise((resolve, reject) => {
    client.on('authenticated', resolve);
    client.on('error', reject);
  });
  console.log('autenticado');

  for (const name of (options.commands || 'walk,hotkey').split(',')) {
    const parameter = name === 'hotkey' ? 'F2' : 3;
    try {
      const ack = await client.send(name.trim(), parameter);
      console.log(`ack ${name}: status=${ack.status}`);
    } catch (error) {
      console.log(`ack ${name}: falhou (${error.message})`);
    }
  }

  await new Promise(resolve => setTimeout(resolve, 500));
  client.close();
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { connect, encodeCommand, proof, frame, decodeState, KIND, COMMANDS, pipePath };
