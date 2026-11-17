'use strict';

/**
 * Prova o controlador: um "menu falso" abre o pipe com net.connect normal, faz
 * o handshake, e o controlador (injetado antes) precisa capturar o MESMO socket
 * ja autenticado e conseguir enviar comando por ele.
 *
 * Nada aqui toca o jogo: o servidor e o RuntimeServer reconstruido.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const net = require('node:net');
const { RuntimeServer } = require('../../reconstruction/runtime-server.cjs');
const { install } = require('../payload/pka-controller.cjs');
const { proof, CLIENT_DOMAIN, CLIENT_DOMAIN: _c, KIND } = require('../../reconstruction/transport.cjs');
const { encodeCommand } = require('../../reconstruction/protocol.cjs');
const { decodeState } = require('../../reconstruction/protocol.cjs');
const { decodeTelemetry } = require('../../reconstruction/telemetry.cjs');
const { frame } = require('../../reconstruction/framing.cjs');

const KEY = '9b2ff0b49a2d2d3004dba9f8e7b4c69f';
const NONCE = Buffer.alloc(32, 4);
let nextPid = 65200 + (process.pid % 200);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function stateBytes(health = 100) {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32LE(1, 0);
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt32LE(health, 8);
  bytes.writeDoubleLE(500, 12);
  bytes.writeDoubleLE(100, 20);
  bytes.writeDoubleLE(600, 28);
  return bytes;
}

const telemetryDoc = () => ({
  schema: 2, nativeVerified: true, pulseVersion: 3, tick: 1, playerId: 1,
  fightMode: 0, chaseMode: 0, clockMs: 0, position: { x: 100, y: 100, z: 7 },
  activeSlot: 1, moves: [], nativeSequence: [], pokemonName: 'Charizard',
  comboPokemonName: 'Charizard', conditionEvents: true, conditionsKnown: true,
  conditions: [], roster: [], creatures: [], items: [], tiles: [],
});

/** Simula o menu: connecta no pipe e faz o handshake como o original. */
function fakeMenu(pid) {
  const socket = net.connect('\\\\.\\pipe\\pka-runtime-2-' + pid);
  let buffer = Buffer.alloc(0);
  let authenticated = false;
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 8) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 8 + length) return;
      const kind = buffer.readUInt32LE(4);
      const payload = buffer.subarray(8, 8 + length);
      buffer = buffer.subarray(8 + length);
      if (kind === KIND.challenge) {
        socket.write(frame(KIND.authenticate, proof(CLIENT_DOMAIN, KEY, payload, pid)));
      } else if (kind === KIND.welcome) {
        authenticated = true;
      }
    }
  });
  return { socket, get authenticated() { return authenticated; } };
}

test('controller captures the menu socket and can send on it', async t => {
  const pid = nextPid++;
  const server = new RuntimeServer({ pid, key: KEY, nonce: NONCE });
  server.on('error', () => {});
  await server.start();
  t.after(async () => { await server.close(); });

  const controller = install({ pid });
  t.after(() => controller.restore());

  const menu = fakeMenu(pid);
  for (let i = 0; i < 100 && !menu.authenticated; i += 1) await wait(20);
  assert.equal(menu.authenticated, true, 'o menu falso precisa autenticar');

  // O controlador deve ter visto o MESMO socket.
  for (let i = 0; i < 100 && controller.channels.length === 0; i += 1) await wait(20);
  assert.equal(controller.channels.length, 1, 'controlador deve capturar 1 canal');
  const channel = controller.channels[0];
  assert.equal(channel.socket, menu.socket, 'deve ser o mesmo socket do menu');
  assert.equal(channel.authenticated, true, 'captura deve herdar a autenticacao');

  // Publica estado/telemetria e confirma o snapshot.
  server.publishState(stateBytes());
  server.publishTelemetry(telemetryDoc());
  for (let i = 0; i < 100 && !channel.snapshot(); i += 1) await wait(20);
  const snapshot = channel.snapshot();
  assert.ok(snapshot, 'snapshot deve existir');
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.healthPercent, 100);
  assert.equal(channel.socket, menu.socket);

  // Envia comando no mesmo socket e confirma que o servidor recebeu.
  const ack = await channel.sendCommand('attack', 4242);
  assert.equal(ack.status, 0);
  const frames = server.commands.filter(row => row.kind === KIND.manual);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.readUInt32LE(4), 2);
  assert.equal(frames[0].payload.readUInt32LE(8), 4242);

  channel.close();
  menu.socket.destroy();
});

test('controller ignores unrelated pipes', async t => {
  const controller = install({ pid: 1 });
  t.after(() => controller.restore());
  const socket = net.connect('\\\\.\\pipe\\\\some-other-pipe');
  socket.on('error', () => {});
  await wait(50);
  assert.equal(controller.channels.length, 0);
  socket.destroy();
});

test('install is idempotent and restore clears it', () => {
  const first = install({});
  const second = install({});
  assert.equal(first, second, 'install deve ser idempotente');
  first.restore();
  assert.equal(global.__pkaController, null);
});
