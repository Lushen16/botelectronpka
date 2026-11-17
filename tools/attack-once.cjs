#!/usr/bin/env node
'use strict';

/**
 * Envia UM comando de ataque pelo canal nativo e mostra o ACK.
 *
 *   node tools/attack-once.cjs --pid 7368 --first
 *   node tools/attack-once.cjs --pid 7368 --target <id>
 *   node tools/attack-once.cjs --pid 7368 --first --fire
 *
 * Sem --fire a DLL NAO chama o handler: responde status 4 e loga o dry-run
 * (RVA do handler, runtime, ponteiro da entidade, HP, pos). Com --fire chama
 * de verdade: 0 = despachado, 2 = recusado pelo jogo.
 *
 * O alvo vem da telemetria do proprio canal — nunca de captura antiga (id
 * obsoleto devolve 0, conforme research/shiba_tap/DISPATCH_LIVE.md).
 *
 * Usa o NativeTransport do botfinal: ele ja faz o handshake, decodifica
 * state/telemetry e emite 'state'/'telemetry' como objetos.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }
const wantFire = arg('--fire', false) === true;
const first = arg('--first', false) === true;
let targetId = Number(arg('--target', 0)) || 0;

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
if (!fs.existsSync(keyFile)) { console.error('sem chave em ' + keyFile); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')).key;

async function main() {
  const t = new NativeTransport({ pid, key });
  let telemetry = null;
  let state = null;
  t.on('telemetry', v => { telemetry = v; });
  t.on('state', v => { state = v; });

  await t.connect();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !(state && telemetry)) {
    await new Promise(r => setTimeout(r, 25));
  }
  if (!telemetry) { console.error('sem telemetria no prazo'); t.close(); process.exit(1); }

  const all = telemetry.creatures || [];
  const valid = all.filter(c => c.canAttack && c.healthPercent > 0);
  console.log(`state: online=${state && state.isOnline} hp=${state && state.healthPercent}`);
  console.log(`criaturas: ${all.length} (atacaveis: ${valid.length})`);
  for (const c of valid.slice(0, 10)) {
    console.log(`  id=${c.id} ${c.name} hp=${c.healthPercent} pos=(${c.pos.x},${c.pos.y},${c.pos.z})`);
  }
  if (telemetry.ownSummonId !== undefined) {
    console.log(`aliado: id=${telemetry.ownSummonId} ${telemetry.pokemonName || ''}`);
  }

  if (!targetId) {
    if (!first) { console.error('\nfaltou --target <id> ou --first'); t.close(); process.exit(2); }
    if (!valid.length) { console.error('\nnenhum alvo atacavel'); t.close(); process.exit(1); }
    targetId = valid[0].id;
  }
  console.log(`\nenviando attack id=${targetId} fire=${wantFire}`);

  let ack;
  try {
    ack = await t.sendCommand('attack', targetId);
  } catch (e) {
    console.error('falha no ACK: ' + e.message);
    t.close(); process.exit(1);
  }
  console.log('ACK: ' + JSON.stringify(ack));
  const st = ack.status;
  const meaning = st === 0 ? 'despachado (handler devolveu != 0)'
    : st === 2 ? 'recusado (alvo invalido / runtime recusou)'
    : st === 4 ? (wantFire ? 'handler nao resolvido' : 'dry-run: handler NAO chamado (use --fire)')
    : 'outro: ' + st;
  console.log(`status ${st} = ${meaning}`);
  t.close();
}

main().catch(e => { console.error(e); process.exit(1); });
