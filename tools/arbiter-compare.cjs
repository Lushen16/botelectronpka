#!/usr/bin/env node
'use strict';

/**
 * Compara a arbitragem do NOSSO bot com a do Shiba, usando kind6 reais.
 *
 *   node tools/arbiter-compare.cjs
 *   node tools/arbiter-compare.cjs --tap native/pka_tap_17748.jsonl
 *
 * Este script NAO tem logica propria de traducao: ele usa
 * `botfinal/core/shiba-state-adapter.cjs`, o mesmo modulo que a producao usa
 * e que tem testes. Se a traducao mudar, muda num lugar so'.
 *
 * FONTES DE VERDADE (corrigidas em 2026-11-11, checkpoint adendo 12):
 *   - `phases.target` + `phases.walker`  (NAO `core.phase`, que fica velho)
 *   - contagem real vem de `phases.target` quando `luring.mode=off`
 *   - Dynamic Lure (arc/stationary/wait) vence a fase do Target
 *
 * LIMITE HONESTO: o kind6 nao publica posicoes de monstro. O adaptador usa a
 * contagem declarada como proxy de `validTargets`. Com telemetria real
 * (kind 5) o runtime usa os alvos de verdade.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const { StateArbiter, BOT_STATES } = require(path.join(ROOT, 'botfinal', 'core', 'state-arbiter.cjs'));
const { adapt } = require(path.join(ROOT, 'botfinal', 'core', 'shiba-state-adapter.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const tap = String(arg('--tap', path.join(ROOT, 'native', 'pka_tap_17748.jsonl')));
const MIN_WILDS = 8; // hoenn_data.lua / kind11 start: minWildsToEngage=8

/** Estado nosso -> acao comparavel. LURING e WALKING ambos ANDAM no runtime. */
function ourAction(state) {
  if (state === BOT_STATES.WALKING || state === BOT_STATES.LURING) return 'MOVING';
  if (state === BOT_STATES.COMBAT) return 'COMBAT';
  if (state === BOT_STATES.REVIVING) return 'REVIVING';
  if (state === BOT_STATES.HEALING) return 'HEALING';
  return 'OTHER';
}

async function main() {
  if (!fs.existsSync(tap)) { console.error('tap ausente: ' + tap); process.exit(2); }
  const rl = readline.createInterface({ input: fs.createReadStream(tap), crlfDelay: Infinity });

  const arbiter = new StateArbiter({
    target: { lowHpComboPercent: 30 },
    healer: { enabled: true, healHpPercent: 15 },
    walker: { enabled: true },
  });

  const stats = {
    samples: 0, comparable: 0, skipped: 0,
    agree: 0, disagree: 0,
    shiba: {}, ours: {}, diffs: new Map(),
    groupingAsMoving: 0, // LURING do Shiba vs MOVING nosso: ambos andam
  };

  for await (const line of rl) {
    if (!line.includes('"kind":6')) continue;
    let outer; try { outer = JSON.parse(line); } catch { continue; }
    if (!outer.d) continue;
    let obj; try { obj = JSON.parse(Buffer.from(outer.d, 'hex').toString('utf8')); } catch { continue; }

    stats.samples++;
    const { inputs, observed, comparable } = adapt(obj, { defaultMinWilds: MIN_WILDS });
    stats.shiba[observed.action] = (stats.shiba[observed.action] || 0) + 1;
    if (!comparable) { stats.skipped++; continue; }

    const state = arbiter.evaluate(
      { healthPercent: 100, ownPokemon: { healthPercent: 100 } },
      inputs,
    );
    const mine = ourAction(state);
    stats.ours[mine] = (stats.ours[mine] || 0) + 1;
    stats.comparable++;

    // O Shiba usa GROUPING (parado agrupando) onde o nosso nao tem estado
    // proprio — o runtime trata LURING como "anda sem atacar". Comparar
    // GROUPING contra MOVING seria comparar vocabularios, nao decisoes.
    // Registramos separado para nao inflar a divergencia.
    if (observed.action === 'GROUPING' && mine === 'MOVING') {
      stats.groupingAsMoving++;
      continue;
    }

    if (observed.action === mine) stats.agree++;
    else {
      stats.disagree++;
      const key = `shiba=${observed.action} (${observed.count}/${observed.min}, ${observed.source}) vs nosso=${mine}`;
      stats.diffs.set(key, (stats.diffs.get(key) || 0) + 1);
    }
  }

  const verdictable = stats.agree + stats.disagree;
  console.log('=== COMPARACAO DE ARBITRAGEM (adaptador de producao) ===\n');
  console.log(`kind6 amostrados       : ${stats.samples}`);
  console.log(`nao comparaveis        : ${stats.skipped}  (pausado/offline/other)`);
  console.log(`comparaveis            : ${verdictable}`);
  console.log(`acordo                 : ${stats.agree}  (${(stats.agree / verdictable * 100).toFixed(1)}%)`);
  console.log(`divergencia            : ${stats.disagree}  (${(stats.disagree / verdictable * 100).toFixed(1)}%)`);
  console.log(`GROUPING->MOVING       : ${stats.groupingAsMoving}  (fora do veredito: vocabulario)`);

  console.log('\n--- o que o Shiba fez:');
  Object.entries(stats.shiba).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));
  console.log('--- o que nos fariamos:');
  Object.entries(stats.ours).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(6)}  ${k}`));

  if (stats.diffs.size) {
    console.log('\n--- divergencias:');
    [...stats.diffs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .forEach(([k, v]) => console.log(`   ${String(v).padStart(5)}  ${k}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
