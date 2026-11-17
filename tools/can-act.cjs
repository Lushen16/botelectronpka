#!/usr/bin/env node
'use strict';

/**
 * Diagnostico unico do ciclo: "o bot consegue agir AGORA?"
 *
 *   node tools/can-act.cjs --pid 16048
 *
 * Responde, sem enviar comando nenhum, as perguntas que ja' custaram rodadas
 * inteiras de teste:
 *
 *   1. o canal responde?           (pipe + handshake)
 *   2. o personagem esta' no mundo? (runtimeReady / gate)
 *   3. ha' Pokemon ativo?           ([rt+0x2568] != 0)  <- sem ele, ataque nao faz nada
 *   4. ha' alvo adjacente?          (dist<=2, dz==0)
 *
 * Cada item com o campo que sustenta a conclusao. Se algum falhar, diz o que
 * fazer — nao inventa verde.
 *
 * READ-ONLY: conecta, escuta e le' 16 bytes do runtime. Nao despacha kind 9.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));

function arg(flag, def = null) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return def;
  const value = process.argv[index + 1];
  return (value === undefined || value.startsWith('--')) ? true : value;
}

const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
const fallback = path.join(ROOT, 'native', 'pka_channel_key.txt');
const key = fs.existsSync(keyFile)
  ? JSON.parse(fs.readFileSync(keyFile, 'utf8')).key
  : (fs.existsSync(fallback) ? fs.readFileSync(fallback, 'utf8').trim() : null);
if (!key) { console.error('sem chave: ' + keyFile); process.exit(2); }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* Chebyshev + z, igual aos motores. */
function canReach(me, creature) {
  if (!me || !creature?.pos) return null;
  const dz = Math.abs(creature.pos.z - me.z);
  const dist = Math.max(Math.abs(creature.pos.x - me.x), Math.abs(creature.pos.y - me.y));
  return { dist, dz, reachable: dz === 0 && dist <= 2 };
}

async function main() {
  const transport = new NativeTransport({ pid, key });
  let snapshot = null;
  let frames = 0;
  transport.on('telemetry', value => { snapshot = value; frames += 1; });
  transport.on('error', () => {});

  console.log(`pid ${pid}`);
  try {
    await transport.connect();
  } catch (error) {
    console.log('canal     : FALHOU (' + error.message + ')');
    console.log('acao      : verifique se a DLL esta injetada:');
    console.log(`            native/pka_inject.exe --pid ${pid} --dll native/pka_native.dll`);
    process.exit(1);
  }

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !snapshot) await sleep(100);

  if (!snapshot) {
    console.log('canal     : autenticou, mas nao veio telemetria em 6 s');
    transport.close();
    process.exit(1);
  }

  const gate = snapshot.runtimeReady;
  const pos = snapshot.position;
  const name = snapshot.playerName;
  const creatures = Array.isArray(snapshot.creatures) ? snapshot.creatures : [];
  const wilds = creatures.filter(row => row.type === 1 && row.healthPercent > 0);
  const own = creatures.filter(row => row.type === 3);

  const reach = wilds
    .map(row => ({ row, ...canReach(pos, row) }))
    .filter(entry => entry.reachable);

  console.log('canal     : OK (' + frames + ' frames)');
  console.log('mundo     : ' + (gate === true ? 'SIM (runtimeReady=true)'
    : gate === false ? 'NAO (runtimeReady=false)'
      : 'DESCONHECIDO (DLL nao publica runtimeReady)'));
  console.log('posicao   : ' + (pos ? `(${pos.x},${pos.y},${pos.z})` : 'ausente'));
  console.log('nome      : ' + (name ? JSON.stringify(name) : 'vazio'));
  console.log('selvagens : ' + wilds.length);
  console.log('proprio   : ' + (own.length ? own.map(row => row.name).join(', ') : 'NENHUM'));

  /* O ponto que a medicao de 2026-11-12 expos: o handler de attack executa a
   * acao NO POKEMON ATIVO ([rt+0x2568]). Sem ele, `devolveu N` nao e' dano. */
  const hasPet = own.length > 0 || Boolean(snapshot.ownPokemon);
  console.log('pokemon   : ' + (hasPet ? 'presente'
    : 'AUSENTE  <- o handler de attack nao tem quem execute a move'));

  if (reach.length) {
    const sample = reach.slice(0, 3)
      .map(entry => `${entry.row.name} id=${entry.row.id} dist=${entry.dist}`).join(' | ');
    console.log('alvos ok  : ' + reach.length + '  (' + sample + ')');
  } else {
    const nearest = wilds
      .map(row => ({ row, ...canReach(pos, row) }))
      .sort((a, b) => (a.dz - b.dz) || (a.dist - b.dist))[0];
    console.log('alvos ok  : 0' + (nearest
      ? `  (mais proximo: ${nearest.row.name} dist=${nearest.dist} dz=${nearest.dz})` : ''));
  }

  const blockers = [];
  if (gate === false) blockers.push('entrar no mundo (o personagem esta no menu)');
  if (!hasPet) blockers.push('invocar o Pokemon (sem ele, attack nao aplica dano)');
  if (!reach.length) blockers.push('aproximar de um selvagem no MESMO z, dist<=2');

  /* Cura — medido em 2026-11-12:
   *
   *   - a potion/hotkey do Shiba cura o HP do PLAYER, nao do pet;
   *   - o pet so' se cura por MOVE de cura (`talk mN`);
   *   - nem todo Pokemon tem move de cura. Dugtrio (DPS) nao tem: os 6 slots
   *     foram testados e nenhum subiu o HP.
   *
   * Entao "pet ferido" nao e' um bloqueio que o bot resolve: depende de o
   * Pokemon ativo ter move de cura. Reportar isso evita a leitura errada de
   * "o healer esta quebrado" quando o problema e' a composicao do time. */
  const playerHp = Number.isFinite(snapshot.healthPercent) ? snapshot.healthPercent : null;
  const petHp = Number.isFinite(snapshot.ownPokemon?.healthPercent)
    ? snapshot.ownPokemon.healthPercent : null;
  console.log('hp player : ' + (playerHp === null ? 'ausente' : playerHp + '%'));
  console.log('hp pet    : ' + (petHp === null ? 'ausente' : petHp + '%'));
  if (petHp !== null && petHp < 50 && hasPet) {
    console.log('aviso     : pet ferido — potion cura o PLAYER; pet depende de move de cura (talk mN)');
  }

  console.log('');
  if (blockers.length === 0) {
    console.log('PODE AGIR: walk e attack tem pre-requisitos atendidos.');
  } else {
    console.log('BLOQUEADO:');
    for (const item of blockers) console.log('  - ' + item);
  }
  transport.close();
  process.exit(blockers.length === 0 ? 0 : 3);
}

main().catch(error => { console.error('erro: ' + error.message); process.exit(1); });
