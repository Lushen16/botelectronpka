'use strict';

/**
 * Teste de ponta a ponta dentro de um Electron real:
 *   1. sobe o RuntimeServer reconstruido (o "runtime nativo"),
 *   2. instala o controller,
 *   3. um "menu" usa net.connect normal e faz o handshake,
 *   4. o controller captura o MESMO socket,
 *   5. o botfinal roda um tick e despacha um comando pelo socket capturado.
 *
 * Roda sob Electron (nao sob Node) para exercitar o mesmo runtime do menu.
 *
 * Uso:
 *   electron --no-sandbox e2e_controller.cjs
 */

const path = require('node:path');
const { RuntimeServer } = require('../reconstruction/runtime-server.cjs');
const { install } = require('../botfinal/payload/pka-controller.cjs');
const { proof, CLIENT_DOMAIN, KIND } = require('../reconstruction/transport.cjs');
const { frame } = require('../reconstruction/framing.cjs');
const { startBotOnChannel } = require('../botfinal/payload/bot-bootstrap.cjs');

const KEY = '9b2ff0b49a2d2d3004dba9f8e7b4c69f';
const NONCE = Buffer.alloc(32, 4);
const PID = 65500 + (process.pid % 200);
const net = require('node:net');

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
      } else if (kind === KIND.welcome) authenticated = true;
    }
  });
  return { socket, get authenticated() { return authenticated; } };
}

async function main() {
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok, detail });
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' :: ' + detail : ''));
  };

  const server = new RuntimeServer({ pid: PID, key: KEY, nonce: NONCE });
  server.on('error', () => {});
  await server.start();

  const controller = install({ pid: PID });
  const menu = fakeMenu(PID);
  for (let i = 0; i < 150 && !menu.authenticated; i += 1) await wait(20);
  check('menu autenticou', menu.authenticated);

  for (let i = 0; i < 150 && controller.channels.length === 0; i += 1) await wait(20);
  check('controller capturou 1 canal', controller.channels.length === 1,
    'channels=' + controller.channels.length);
  const channel = controller.channels[0];
  check('capturou o MESMO socket', channel && channel.socket === menu.socket);
  check('canal herdou autenticacao', Boolean(channel && channel.authenticated));

  server.publishState(stateBytes());
  server.publishTelemetry(telemetryDoc());
  for (let i = 0; i < 150 && !(channel && channel.snapshot()); i += 1) await wait(20);
  const snapshot = channel ? channel.snapshot() : null;
  check('snapshot montado', Boolean(snapshot));
  check('snapshot online', Boolean(snapshot && snapshot.online));
  check('hp do state', snapshot && snapshot.healthPercent === 100);

  // Botfinal completo: motores + tick + comando pelo socket do menu.
  const config = {
    target: { enabled: true, maxDistance: 8, monsters: [{ name: '*', range: 8, minCount: 1 }],
      combo: { enabled: true, useNativeSequence: false, sequenceText: 'm1', stepDelay: 250 } },
    walker: { enabled: true, waypoints: [{ action: 'walk', pos: { x: 103, y: 100, z: 7 } }] },
    healer: { enabled: true, healHpPercent: 20 },
    hoenn: { minWildsToEngage: 0, perfectLure: false },
  };
  const runtime = startBotOnChannel(channel, { root: path.resolve(__dirname, '..'), config });
  await runtime.tick();
  const frames = server.commands.filter(row => row.kind === KIND.manual);
  check('comando saiu pelo socket do menu', frames.length >= 1, 'frames=' + frames.length);
  if (frames.length) {
    check('primeiro comando e walk(op1)', frames[0].payload.readUInt32LE(4) === 1,
      'op=' + frames[0].payload.readUInt32LE(4));
  }
  runtime.stop();

  controller.restore();
  channel.close();
  menu.socket.destroy();
  await server.close();

  const failed = results.filter(row => !row.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => {
  console.error('FATAL', error.stack || error.message);
  process.exit(2);
});
