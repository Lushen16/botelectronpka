#!/usr/bin/env node
'use strict';

/**
 * Espera uma criatura atacavel aparecer, dispara attack nela, e mede o HP
 * antes/depois. E' o teste que prova se o handler nativo funciona.
 *
 * Uso:
 *   node tools/attack-hunt.cjs --pid 21804
 *   node tools/attack-hunt.cjs --pid 21804 --fire
 *   node tools/attack-hunt.cjs --pid 21804 --max-wait 600 --attempts 5
 *
 * Sem --fire ele so' observa: registra o que acharia, nao chama o handler.
 * Com --fire: liga a flag em native/pka_attack_fire.txt, ataca, mede, e
 * restaura a flag como estava.
 *
 * Por que existe: o cliente passa minutos sem criatura visivel (mapa limpo,
 * transicao). Esperar de olho na tela e' desperdicio. Este script faz o poll
 * e so' age quando ha alvo real.
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
const maxWait = Number(arg('--max-wait', 300));
const attempts = Number(arg('--attempts', 3));

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
if (!fs.existsSync(keyFile)) { console.error('sem chave em ' + keyFile); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')).key;

const fireFile = path.join(ROOT, 'native', 'pka_attack_fire.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setFire(on) {
  fs.writeFileSync(fireFile, on ? '1' : '0', 'ascii');
}

async function main() {
  const originalFire = fs.existsSync(fireFile) ? fs.readFileSync(fireFile, 'utf8').trim() : '0';

  const t = new NativeTransport({ pid, key });
  let latest = null;
  t.on('telemetry', v => { latest = v; });
  await t.connect();

  console.log(`aguardando criatura atacavel (max ${maxWait}s, fire=${wantFire})...`);
  const deadline = Date.now() + maxWait * 1000;
  let target = null;
  let polls = 0;
  while (Date.now() < deadline) {
    await sleep(700);
    polls++;
    const all = (latest && latest.creatures) || [];
    const valid = all.filter(c => c.canAttack && c.healthPercent > 0);
    if (polls % 20 === 0) {
      process.stdout.write(`  [${Math.round((Date.now() - (deadline - maxWait * 1000)) / 1000)}s] ` +
        `${all.length} criaturas, ${valid.length} atacaveis\n`);
    }
    if (valid.length) { target = valid[0]; break; }
  }

  if (!target) {
    console.log(`\nnada apareceu em ${maxWait}s. Nada foi disparado.`);
    t.close();
    return 3;
  }

  console.log(`\nalvo: id=${target.id} ${target.name} hp=${target.healthPercent} ` +
              `pos=(${target.pos.x},${target.pos.y},${target.pos.z})`);
  console.log(`aliado: ${latest.ownSummonId !== undefined ? latest.pokemonName : '(nenhum)'}`);

  if (!wantFire) {
    console.log('\n--fire nao pedido: nao vou chamar o handler. Repetindo com --fire para testar.');
    t.close();
    return 0;
  }

  const result = { attempts: [] };
  for (let n = 1; n <= attempts; n++) {
    const cur = (latest && latest.creatures || []).find(c => c.id === target.id);
    if (!cur) {
      console.log(`\ntentativa ${n}: alvo sumiu antes de atacar`);
      break;
    }
    const hpBefore = cur.healthPercent;
    console.log(`\n--- tentativa ${n}: hp=${hpBefore}`);

    setFire(true);
    let ack = null;
    try {
      ack = await t.sendCommand('attack', target.id);
      console.log('  ACK: ' + JSON.stringify(ack));
    } catch (e) {
      console.log('  ACK nao voltou: ' + e.message);
    }
    setFire(false);

    // mede por ate 5 s
    let hpAfter = hpBefore;
    let vanished = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      await sleep(500);
      const now = (latest && latest.creatures || []).find(c => c.id === target.id);
      if (!now) { vanished = true; break; }
      hpAfter = now.healthPercent;
      if (hpAfter !== hpBefore) break;
    }
    result.attempts.push({ hpBefore, hpAfter, vanished });
    console.log(`  resultado: hp ${hpBefore} -> ${hpAfter}${vanished ? ' (sumiu)' : ''}`);

    if (vanished || hpAfter < hpBefore) {
      console.log('\n=== SUCESSO: o attack teve efeito ===');
      setFire(originalFire === '1');
      t.close();
      return 0;
    }
    await sleep(1200);
  }

  console.log('\n=== SEM EFEITO em ' + result.attempts.length + ' tentativas ===');
  console.log('A chamada executou (ver log) mas o HP nao caiu.');
  console.log('Proximo alvo de investigacao: a funcao 0x10c9a0 chamada no +0x74 do');
  console.log('handler (valida o self). Log: %TEMP%\\pka_native.log');
  setFire(originalFire === '1');
  t.close();
  return 1;
}

main().catch(e => { console.error(e); process.exit(1); });
