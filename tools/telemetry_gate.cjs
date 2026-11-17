'use strict';

/**
 * Por que a telemetria do fornecedor para?
 *
 * Hipotese testada: o servidor so' publica telemetria quando o ESTADO MUDA.
 * Se o jogador fica parado e o inventario nao muda, ele para de mandar o JSON
 * de 40 KB (economia de banda). Quando algo muda, volta.
 *
 *   node tools/telemetry_gate.cjs [arquivo]
 *
 * Mede, entre publicacoes consecutivas:
 *   - posicao mudou?
 *   - contagem de criaturas mudou?
 *   - contagem de itens mudou?
 *   - tick/clock avancou?
 *
 * E conta quantas publicacoes acontecem com estado identico (deveria ser ~0 se
 * a hipotese estiver certa).
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');

function latestTap() {
  const dir = path.join(ROOT, 'native');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(name => /^pka_tap_\d+\.jsonl$/.test(name))
    .map(name => path.join(dir, name))
    .filter(file => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

const key = value => JSON.stringify(value);

async function main() {
  const file = process.argv[2] ? path.resolve(process.argv[2]) : latestTap();
  if (!file) { console.log('sem captura'); return; }
  console.log('arquivo: ' + file + '\n');

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity,
  });

  let previous = null;
  let same = 0;
  let changed = 0;
  const sameWindows = [];
  let sameStart = null;
  let total = 0;

  for await (const line of rl) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.kind !== 5 || record.trunc || !record.d) continue;
    let data;
    try { data = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8')); }
    catch { continue; }
    total++;

    const current = {
      t: record.t,
      pos: key(data.position),
      creatures: (data.creatures || []).length,
      items: (data.items || []).length,
      tiles: (data.tiles || []).length,
      moves: key((data.moves || []).map(m => m.spellword + ':' + m.remainingMs)),
      hp: data.healthPercent,
      pokemon: data.pokemonName,
      dir: data.direction,
    };

    if (previous) {
      const identical = current.pos === previous.pos
        && current.creatures === previous.creatures
        && current.items === previous.items
        && current.tiles === previous.tiles
        && current.moves === previous.moves
        && current.hp === previous.hp
        && current.pokemon === previous.pokemon
        && current.dir === previous.dir;

      if (identical) {
        same++;
        if (sameStart === null) sameStart = previous.t;
      } else {
        changed++;
        if (sameStart !== null) {
          sameWindows.push({ from: sameStart, to: previous.t,
            ms: previous.t - sameStart, frames: same });
          sameStart = null;
        }
      }
    }
    previous = current;
  }

  if (sameStart !== null && previous) {
    sameWindows.push({ from: sameStart, to: previous.t,
      ms: previous.t - sameStart, frames: same });
  }

  console.log('publicacoes de telemetria: ' + total);
  console.log('  com estado diferente: ' + changed);
  console.log('  com estado identico : ' + same
    + (total ? ' (' + ((same / total) * 100).toFixed(1) + '%)' : ''));

  sameWindows.sort((a, b) => b.ms - a.ms);
  console.log('\nmaiores janelas de estado identico:');
  if (!sameWindows.length) console.log('  nenhuma');
  for (const window of sameWindows.slice(0, 5)) {
    console.log(`  ${(window.ms / 1000).toFixed(1)}s  t=${window.from}..${window.to}`
      + `  frames=${window.frames}`);
  }

  console.log('\n=== veredito ===');
  if (!sameWindows.length) {
    console.log('o fornecedor publica SEMPRE, mesmo sem mudanca.');
    console.log('a pausa nao e\' economia de banda por estado identico.');
  } else if (sameWindows[0].ms > 1000) {
    console.log('ha janelas longas com estado identico: ele publica repetido as vezes.');
    console.log('isso enfraquece a hipotese de "so publica quando muda".');
  } else {
    console.log('publica uma vez por transicao: a pausa longa NAO e\' estado identico.');
    console.log('procure outro gatilho (carga, foco de janela, lease).');
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
