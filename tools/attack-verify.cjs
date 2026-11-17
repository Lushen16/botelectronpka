#!/usr/bin/env node
'use strict';

/**
 * Verifica se o attack teve EFEITO: mede o HP do alvo antes, dispara, e
 * acompanha o HP depois.
 *
 * Sem isso `--fire` so' prova que a chamada executou — nao que o jogo reagiu.
 *
 * Uso:
 *   node tools/attack-verify.cjs --pid 20752
 *   node tools/attack-verify.cjs --pid 20752 --target 1073776360
 *   node tools/attack-verify.cjs --pid 20752 --watch 12
 *
 * Criterio de sucesso: o HP do alvo cai, OU o alvo some da lista (morreu).
 * Se o HP nao mudar em --watch segundos, o hander foi chamado mas o jogo
 * recusou — e o problema esta' no slot/argumento, nao na chamada.
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
const wantTarget = Number(arg('--target', 0)) || 0;
const watchSec = Number(arg('--watch', 10));

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
if (!fs.existsSync(keyFile)) { console.error('sem chave em ' + keyFile); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')).key;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const t = new NativeTransport({ pid, key });
  const frames = [];
  t.on('telemetry', v => frames.push(v));
  await t.connect();

  // primeira telemetria
  let deadline = Date.now() + 10000;
  while (Date.now() < deadline && !frames.length) await sleep(25);
  if (!frames.length) { console.error('sem telemetria'); t.close(); process.exit(1); }

  const before = frames[frames.length - 1];
  const valid = (before.creatures || []).filter(c => c.canAttack && c.healthPercent > 0);
  if (!valid.length) { console.error('nenhum alvo atacavel'); t.close(); process.exit(1); }

  const target = wantTarget
    ? valid.find(c => c.id === wantTarget)
    : valid[0];
  if (!target) { console.error('alvo ' + wantTarget + ' nao esta atacavel'); t.close(); process.exit(1); }

  console.log(`alvo: id=${target.id} ${target.name} hp=${target.healthPercent} ` +
              `pos=(${target.pos.x},${target.pos.y},${target.pos.z})`);
  const hpBefore = target.healthPercent;

  const fireFile = path.join(ROOT, 'native', 'pka_attack_fire.txt');
  const fireState = fs.existsSync(fireFile) ? fs.readFileSync(fireFile, 'utf8').trim() : '(ausente)';
  console.log(`fire flag: ${fireState}`);
  if (fireState !== '1') {
    console.log('\nATENCAO: fire desligado. O handler NAO sera chamado.');
    console.log('Para disparar: echo 1 > native\\pka_attack_fire.txt');
  }

  console.log('\nenviando attack...');
  let ack = null;
  try {
    ack = await t.sendCommand('attack', target.id);
    console.log('ACK: ' + JSON.stringify(ack));
  } catch (e) {
    // timeout no ACK pode significar que o handler esta' executando (bloqueou
    // a thread da sessao). Nao aborta: o efeito e' o que importa.
    console.log('ACK nao voltou: ' + e.message);
    console.log('(isso pode ser o handler executando e segurando a thread — sigo medindo)');
  }

  console.log(`\nacompanhando HP por ${watchSec}s...`);
  const t0 = Date.now();
  let lastSeen = hpBefore;
  let vanished = false;
  while (Date.now() - t0 < watchSec * 1000) {
    await sleep(700);
    const cur = frames[frames.length - 1];
    if (!cur) continue;
    const row = (cur.creatures || []).find(c => c.id === target.id);
    if (!row) {
      vanished = true;
      console.log(`  t=${((Date.now() - t0) / 1000).toFixed(1)}s  alvo SUMIU da lista`);
      break;
    }
    if (row.healthPercent !== lastSeen) {
      console.log(`  t=${((Date.now() - t0) / 1000).toFixed(1)}s  hp ${lastSeen} -> ${row.healthPercent}`);
      lastSeen = row.healthPercent;
    }
  }

  console.log('\n=== VEREDITO ===');
  if (vanished) {
    console.log('SUCESSO: o alvo desapareceu (morto ou saiu de vista). O attack teve efeito.');
  } else if (lastSeen < hpBefore) {
    console.log(`SUCESSO: HP caiu de ${hpBefore} para ${lastSeen}. O attack teve efeito.`);
  } else {
    console.log(`SEM EFEITO: HP continua ${hpBefore}.`);
    console.log('A chamada executou mas o jogo nao reagiu. Investigar:');
    console.log('  - o handler exige [runtime+0x2568] (self) valido?');
    console.log('  - o guard cmp sp.obj,[runtime+0x2528] barrou?');
    console.log('  - o control block emprestado do shared_ptr<Tile> e compatibel?');
    console.log('log: %TEMP%\\pka_native.log');
  }
  t.close();
}

main().catch(e => { console.error(e); process.exit(1); });
