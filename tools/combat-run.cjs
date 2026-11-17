#!/usr/bin/env node
'use strict';

/**
 * Roda o CombatEngine real contra o jogo, com ticks, e reporta o que acontece.
 *
 * Uso:
 *   node tools/combat-run.cjs --pid 9452                 dry-run (nao envia)
 *   node tools/combat-run.cjs --pid 9452 --fire          envia de verdade
 *   node tools/combat-run.cjs --pid 9452 --fire --ticks 20
 *
 * O que ele exercita de verdade:
 *   - NativeSession: normaliza telemetria (creatureType, ownPokemon)
 *   - CombatEngine.filterValidTargets / selectTarget / tick
 *   - CommandDispatcher.attack -> pipe -> handler nativo
 *   - mede o HP do alvo antes/depois
 *
 * Por que dry-run por padrao: o engine e' o mesmo que vai rodar no bot. Se
 * houver bug de alvo (atacar aliado, atacar player), quero ver no log antes
 * de mandar comando.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));
const { NativeSession } = require(path.join(ROOT, 'botfinal', 'core', 'native-session.cjs'));
const { CombatEngine } = require(path.join(ROOT, 'botfinal', 'engines', 'combat-engine.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }
const wantFire = arg('--fire', false) === true;
const ticks = Number(arg('--ticks', 10));
const tickMs = Number(arg('--interval', 1200));

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
if (!fs.existsSync(keyFile)) { console.error('sem chave'); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')).key;

const fireFile = path.join(ROOT, 'native', 'pka_attack_fire.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const t = new NativeTransport({ pid, key });
  const session = new NativeSession({ pid });
  session.attach(t);

  await t.connect();
  await sleep(2500);

  const engine = new CombatEngine({
    target: { maxDistance: 8, priorityMode: 'nearest' },
    hoenn: {},
  });

  console.log(`pid=${pid}  fire=${wantFire}  ticks=${ticks}`);
  const fireOrig = fs.existsSync(fireFile) ? fs.readFileSync(fireFile, 'utf8').trim() : '0';
  if (wantFire) fs.writeFileSync(fireFile, '1', 'ascii');

  const hpTrack = new Map();
  let sent = 0;
  try {
    for (let n = 1; n <= ticks; n++) {
      const snap = session.snapshot ? session.snapshot() : null;
      const tel = snap && snap.telemetry;
      if (!tel) { console.log(`  tick ${n}: sem telemetria`); await sleep(tickMs); continue; }

      const cands = engine.filterValidTargets(tel);
      const own = tel.ownPokemon;
      const target = engine.selectTarget(tel, cands);

      console.log(`  tick ${n}: pos=(${tel.position.x},${tel.position.y}) ` +
        `own=${own ? own.name : '?'} atacaveis=${cands.length} ` +
        `alvo=${target ? target.name + '@' + target.healthPercent : 'nenhum'}`);

      if (target) {
        if (!hpTrack.has(target.id)) hpTrack.set(target.id, target.healthPercent);
        if (wantFire) {
          try {
            const ack = await t.sendCommand('attack', target.id);
            sent++;
            console.log(`    attack -> ${JSON.stringify(ack)}`);
          } catch (e) {
            console.log(`    attack falhou: ${e.message}`);
          }
        }
      }
      await sleep(tickMs);
    }
  } finally {
    if (wantFire) fs.writeFileSync(fireFile, fireOrig, 'ascii');
  }

  // veredito: HP de cada alvo atacado
  const snap = session.snapshot ? session.snapshot() : null;
  const tel = snap && snap.telemetry;
  console.log();
  console.log('=== resultado ===');
  console.log(`  comandos enviados: ${sent}`);
  if (tel && tel.creatures) {
    for (const [id, hp0] of hpTrack) {
      const now = tel.creatures.find(c => c.id === id);
      if (!now) console.log(`  id=${id}: SUMIU (morreu ou saiu de vista)`);
      else console.log(`  id=${id}: hp ${hp0} -> ${now.healthPercent}${now.healthPercent < hp0 ? '   <<< dano' : ''}`);
    }
  }
  t.close();
}

main().catch(e => { console.error(e); process.exit(1); });
