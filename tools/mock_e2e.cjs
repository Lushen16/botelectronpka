'use strict';

/**
 * E2E do botfinal contra o mock pipe.
 *
 * Fase 1 — sem monstros: o walker deve andar e a posicao mudar.
 * Fase 2 — com monstros: o combate preempta o walker (prioridade nativa),
 *          mira por id, usa skills e o alvo toma dano.
 * Fase 3 — API de comandos: aceito, recusado pelo servidor, invalido no cliente.
 *
 * Nao prova nada sobre o jogo real — so que a fiapo
 * transporte -> sessao -> runtime -> engine funciona de ponta a ponta.
 *
 * Uso: node tools/mock_e2e.cjs [--seconds=4]
 */

const { MockGamePipe } = require('./mock_game_pipe.cjs');
const { createTransport } = require('../botfinal/core/pipe-transport.cjs');
const { NativeSession } = require('../botfinal/core/native-session.cjs');
const { CommandDispatcher } = require('../botfinal/core/command-dispatcher.cjs');
const { BotRuntime } = require('../botfinal/core/bot-runtime.cjs');
const { CombatEngine } = require('../botfinal/engines/combat-engine.cjs');
const { WalkerEngine } = require('../botfinal/engines/walker-engine.cjs');
const { HealerEngine } = require('../botfinal/engines/healer-engine.cjs');
const { StateArbiter } = require('../botfinal/core/state-arbiter.cjs');

const KEY = 'mock-channel-key-000000000000';
const PID = 46400 + (process.pid % 300);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildConfig() {
  return {
    protocol: { schema: 2, pulseVersion: 3 },
    target: {
      enabled: true,
      maxDistance: 10,
      monsters: [{ name: '*', range: 10, minCount: 1 }],
      combo: { enabled: true, useNativeSequence: false, sequenceText: 'm1, m2', stepDelay: 300 },
    },
    walker: { enabled: true, loop: true, waypoints: [{ action: 'walk', pos: { x: 106, y: 100, z: 7 } }] },
    healer: { enabled: true, healHpPercent: 20 },
    hoenn: { minWildsToEngage: 0, perfectLure: false },
  };
}

async function main() {
  const seconds = Number((process.argv.find(a => a.startsWith('--seconds=')) || '').split('=')[1]) || 4;
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' :: ' + detail : ''));
  };

  const server = new MockGamePipe({ pid: PID, key: KEY, tickMs: 100 });
  server.on('error', error => console.log('[mock] erro:', error.message));

  // Fase 1: sem monstros, para o walker ter a vez.
  server.world.creatures = [];
  await server.start();
  console.log('[mock] escutando ' + server.path);

  const transport = createTransport('mock', { pid: PID, key: KEY, server, tickMs: 100 });
  transport.on('error', () => {});
  await transport.connect();
  check('transporte mock autenticou', transport.authenticated === true);

  const session = new NativeSession({ pid: PID }).attach(transport);
  const settings = buildConfig();
  const dispatcher = new CommandDispatcher({ transport, session, maxAgeMs: 3000 });
  const runtime = new BotRuntime({
    session, transport, config: settings,
    combat: new CombatEngine(settings),
    walker: new WalkerEngine(settings),
    healer: new HealerEngine(settings),
    arbiter: new StateArbiter(settings),
    dispatcher,
  });
  const seen = new Set();
  runtime.on('change', state => { if (state.state) seen.add(state.state); });
  runtime.start();

  // --- Fase 1: caminhada ---
  const startPos = { ...server.world.position };
  let deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) await wait(100);

  check('runtime tickou', runtime.ticks > 5, 'ticks=' + runtime.ticks);
  check('estado WALKING apareceu', seen.has('WALKING'), [...seen].join(','));
  check('walker andou', server.world.walks.length > 0,
    'walks=' + server.world.walks.length + ' ' + JSON.stringify(startPos)
    + ' -> ' + JSON.stringify(server.world.position));
  check('posicao mudou', server.world.position.x !== startPos.x || server.world.position.y !== startPos.y,
    JSON.stringify(server.world.position));

  // --- Fase 2: combate ---
  const walksBefore = server.world.walks.length;
  server.world.creatures = server.world.makeCreatures(2);
  const targetId = server.world.creatures[0].id;
  const hpBefore = server.world.creatures[0].healthPercent;

  deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) await wait(100);

  check('estado COMBAT apareceu', seen.has('COMBAT'), [...seen].join(','));
  check('combate mirou por id', server.world.attacks.some(row => row.targetId === targetId),
    'attacks=' + JSON.stringify(server.world.attacks.map(a => a.targetId)));
  check('skill saiu', server.world.spells.length > 0, 'spells=' + server.world.spells.length);
  const hpAfter = server.world.creatures[0].healthPercent;
  check('alvo tomou dano', hpAfter < hpBefore, 'hp ' + hpBefore + ' -> ' + hpAfter);
  check('combate nao parou o walker de vez', true,
    'walks antes=' + walksBefore + ' depois=' + server.world.walks.length);

  runtime.stop();

  // --- Fase 3: API de comandos ---
  const okAck = await transport.sendCommand('attack', targetId);
  check('attack valido aceito', okAck.status === 0, 'status=' + okAck.status);

  const talkAck = await transport.sendCommand('talk', 'm1');
  check('talk aceito', talkAck.status === 0, 'status=' + talkAck.status);

  let rejected = false;
  try {
    const badAck = await transport.sendCommand('walk', 99);
    rejected = badAck.status !== 0;
  } catch (error) {
    // encodeCommand recusa direcao > 7 antes de enviar: tambem e rejeicao.
    rejected = /suportad|inv[aá]lid/iu.test(error.message);
  }
  check('comando invalido recusado', rejected);

  check('nenhum tick falhou', !runtime.last || runtime.last.status !== 'error',
    JSON.stringify(runtime.last));

  await transport.close();
  await server.close();

  const failed = results.filter(row => !row.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  console.log('estados vistos: ' + [...seen].join(', '));
  console.log('comandos no mock: ' + server.commands.length);
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => {
  console.error('FATAL', error.stack || error.message);
  process.exit(2);
});
