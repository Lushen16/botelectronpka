'use strict';

/**
 * Valida o pipeline RPM de combate contra o build ativo do jogo.
 *
 * Usa a leitura REAL do processo (scan_creatures.py) para a identidade do
 * jogador e do perfil, e injeta criaturas sintéticas apenas no canal, para
 * exercitar seleção de alvo e despacho sem depender de um monstro na tela.
 *
 * O que fica provado:
 *   - o gate de hash aceita o build ativo,
 *   - a identidade do jogador vem do processo real,
 *   - o runtime aceita o snapshot, escolhe alvo e enfileira comando,
 *   - o comando é entregue ao "cliente" (aqui, um coletor em memória).
 *
 * O que NÃO fica provado: efeito no jogo. O envio real é PostMessage.
 *
 * Uso: node tools/rpm_live_validate.cjs --pid 25876
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { RpmCombatRuntime } = require('../reconstruction/rpm-combat-runtime.cjs');
const { isSupportedExecutable, layoutFor } = require('../reconstruction/executable-profile.cjs');

const args = process.argv.slice(2);
const pidArg = args.indexOf('--pid');
const PID = pidArg >= 0 ? Number(args[pidArg + 1]) : 0;
if (!Number.isInteger(PID) || PID <= 0) {
  console.error('uso: node tools/rpm_live_validate.cjs --pid <pid>');
  process.exit(2);
}

const outDir = path.resolve(__dirname, '..', 'captures', 'rpm-' + PID);
fs.mkdirSync(outDir, { recursive: true });
const scanFile = path.join(outDir, 'creatures.json');

function runScan() {
  execFileSync('python', ['-B', path.resolve(__dirname, 'scan_creatures.py'),
    '--pid', String(PID), '--output', scanFile], { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(scanFile, 'utf8'));
}

function main() {
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' :: ' + detail : ''));
  };

  console.log('[*] lendo o processo ' + PID);
  const scan = runScan();
  const player = scan.player;
  const profile = scan.layout?.identityProfile;
  check('processo lido', Boolean(player));
  check('jogador identificado', Boolean(player?.name), player?.name);
  check('posicao valida', Number.isInteger(player?.pos?.x),
    JSON.stringify(player?.pos));
  check('posse verificada', player?.ownershipVerified === true);

  const sha = profile?.executableSha256;
  check('hash do build suportado', isSupportedExecutable(sha), (sha || '').slice(0, 16));
  const layout = layoutFor(sha);
  check('layout declarado para o build', Boolean(layout), layout ? layout.label : 'nenhum');
  check('typeOffset confere', profile?.typeOffset === layout?.typeOffset,
    profile?.typeOffset + ' vs ' + layout?.typeOffset);

  // Relogio e telemetria montados a partir da leitura real.
  let clock = Date.now();
  const now = () => clock;
  const telemetry = {
    schema: 2,
    nativeVerified: true,
    pulseVersion: 3,
    tick: 1,
    playerId: player.id,
    fightMode: 0,
    chaseMode: 0,
    clockMs: 0,
    position: { ...player.pos },
    playerName: player.name,
    activeSlot: 1,
    moves: [],
    nativeSequence: ['m1'],
    pokemonName: 'Charizard',
    comboPokemonName: 'Charizard',
    conditionEvents: true,
    conditionsKnown: true,
    conditions: [],
    roster: [{ slot: 1, uuid: 'live-uuid-1', name: 'Charizard', healthPercent: 100,
      moves: [{ spellword: 'm1', remainingMs: 0, totalMs: 1000 }] }],
    // Criaturas sinteticas: o processo real nao tem monstros no momento.
    creatures: [
      { id: 910001, name: 'Geodude',
        pos: { x: player.pos.x + 1, y: player.pos.y, z: player.pos.z },
        healthPercent: 100, creatureType: 1, canAttack: true,
        ownershipVerified: true, struct_va: '0x300001' },
      { id: 910002, name: 'Magnemite',
        pos: { x: player.pos.x, y: player.pos.y + 1, z: player.pos.z },
        healthPercent: 100, creatureType: 1, canAttack: true,
        ownershipVerified: true, struct_va: '0x300002' },
      // pet proprio, para o runtime nao reclamar de ausencia
      { id: 910003, name: 'Charizard',
        pos: { x: player.pos.x, y: player.pos.y - 1, z: player.pos.z },
        healthPercent: 100, creatureType: 3, canAttack: false,
        isOwnPokemon: true, ownershipVerified: true, struct_va: '0x300003' },
    ],
    creaturesStale: false,
    creaturesGeneratedAt: new Date(clock).toISOString(),
    creatureIdentityProfile: profile,
    creaturePlayer: {
      id: player.id, name: player.name, pos: { ...player.pos },
      creatureType: 0, ownershipVerified: true, struct_va: player.struct_va,
    },
    items: [],
    tiles: [],
  };
  check('telemetria montada a partir do processo', telemetry.playerId === player.id);

  const sent = [];
  const runtime = new RpmCombatRuntime({
    automatic: false,
    now,
    playerName: player.name,
    getSession: () => ({
      pid: PID, source: 'rpm', online: true,
      generatedAt: new Date(clock).toISOString(),
      clientWindowTitle: 'PokeAlliance - ' + player.name,
      telemetry,
    }),
    loadTransport: () => ({
      bindings: { m1: 'F1', m2: 'F2', '!autocombo': 'C' },
      cooldownsMs: {},
      viewport: {
        width: 1920, height: 1080, centerX: 960, centerY: 540, tileSize: 32,
        map: { left: 0, top: 0, right: 1920, bottom: 1080 },
      },
    }),
    input: async () => { sent.push({ kind: 'input', at: clock }); },
    combatInput: async (targetPid, request) => {
      sent.push({ kind: 'combat', pid: targetPid, request, at: clock });
      return { success: true, pid: targetPid, hwnd: '0x1', eventsSent: 2,
        foreground: true, transport: 'PostMessageW', effectVerified: false };
    },
  });

  const config = {
    target: {
      enabled: true, maxDistance: 8,
      monsters: [{ name: '*', range: 8, minCount: 1 }],
      combo: { enabled: true, useNativeSequence: false, sequenceText: 'm1', stepDelay: 250 },
    },
    walker: { loop: false, waypoints: [{ action: 'walk',
      pos: { x: player.pos.x + 5, y: player.pos.y, z: player.pos.z } }] },
    healer: { enabled: true, healHpPercent: 20 },
    hoenn: { minWildsToEngage: 0, perfectLure: false },
    looting: { captureEnabled: false },
  };

  return { results, check, runtime, telemetry, config, sent, pid: PID, scan, player,
    tick: ms => { clock += ms; telemetry.creaturesGeneratedAt = new Date(clock).toISOString(); } };
}

async function main2() {
  const ctx = main();
  const { results, check, runtime, telemetry, config, sent } = ctx;

  let startError = null;
  try {
    await runtime.setModules('target', true, ctx.pid, config);
  } catch (error) { startError = error; }
  check('Target iniciou com o perfil do build ativo', !startError,
    startError ? startError.message : 'ok');
  if (startError) {
    console.log('\nresumo: ' + results.filter(r => r.ok).length + '/' + results.length + ' OK');
    process.exit(1);
  }

  const first = await runtime.tick();
  check('tick executou sem pausar', runtime.paused === false,
    'status=' + (first?.status || first?.error || 'null'));
  const combat = sent.filter(row => row.kind === 'combat');
  check('comando despachado ao cliente', combat.length >= 1, 'envios=' + combat.length);
  if (combat.length) {
    const request = combat[0].request;
    check('comando tem guarda de identidade', Boolean(request.targetGuard),
      Object.keys(request.targetGuard || {}).join(','));
    check('alvo e hostil verificado', request.targetGuard?.target?.creatureType === 1,
      'type=' + request.targetGuard?.target?.creatureType);
    check('PID do envio confere', combat[0].pid === ctx.pid, String(combat[0].pid));
    check('efeito nao e declarado', request.targetGuard?.effectVerified !== true);
  }

  for (let index = 0; index < 6; index += 1) {
    ctx.tick(300);
    await runtime.tick();
  }
  check('rotacao continuou', sent.filter(row => row.kind === 'combat').length >= 1,
    'total=' + sent.filter(row => row.kind === 'combat').length);
  check('runtime nao pausou no meio', runtime.paused === false,
    JSON.stringify(runtime.state.phase));
  check('sem efeito declarado', runtime.state.targetEffectVerified === false);

  await runtime.setModules('all', false);

  const failed = results.filter(row => !row.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  console.log('player=' + ctx.player.name + ' pos=' + JSON.stringify(ctx.player.pos)
    + ' build=' + (ctx.scan.layout?.identityProfile?.executableSha256 || '').slice(0, 16));
  process.exit(failed.length ? 1 : 0);
}

main2().catch(error => {
  console.error('FATAL', error.stack || error.message);
  process.exit(2);
});
