'use strict';

/**
 * Espera uma criatura atacável na telemetria e alimenta o pka_attack_loop.
 *
 *   node tools/attack_feed.cjs [--once] [--dry]
 *
 * Le o tap do jogo (jsonl grande, lido pelo fim), pega uma criatura com
 * `canAttack: true` e `type: 1` (hostil), e escreve o arquivo que o loop
 * consome:
 *
 *   native/pka_attack_target.txt  ->  <id>,0,<counter>
 *
 * O contador é incrementado a cada alvo novo para o loop saber que deve chamar.
 *
 * --dry   mostra o que faria, não escreve
 * --once  escreve uma vez e sai (para teste manual)
 */

const fs = require('node:fs');
const path = require('node:path');
const { tailLines } = require('./tail_jsonl.cjs');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const TARGET_FILE = path.join(NATIVE, 'pka_attack_target.txt');

function args(argv) {
  const options = { once: false, dry: false, tap: null, seconds: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') options.once = true;
    else if (argv[i] === '--dry') options.dry = true;
    else if (argv[i] === '--tap') options.tap = argv[++i];
    else if (argv[i] === '--seconds') options.seconds = Number(argv[++i]);
  }
  return options;
}

function latestTap() {
  if (!fs.existsSync(NATIVE)) return null;
  const files = fs.readdirSync(NATIVE)
    .filter(name => /^pka_tap_\d+\.jsonl$/.test(name))
    .map(name => path.join(NATIVE, name))
    .filter(file => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

/** Pega a telemetria mais recente e devolve as criaturas hostis. */
function newestCreatures(tapFile) {
  const lines = tailLines(tapFile, 1200);
  for (let i = lines.length - 1; i >= 0; i--) {
    let record;
    try { record = JSON.parse(lines[i]); } catch { continue; }
    if (record.kind !== 5 || record.trunc || !record.d) continue;
    try {
      const data = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8'));
      if (!Array.isArray(data.creatures)) continue;
      return {
        t: record.t,
        player: data.playerName,
        position: data.position,
        creatures: data.creatures,
      };
    } catch { /* segue */ }
  }
  return null;
}

function pickTarget(snapshot) {
  if (!snapshot) return null;
  /* hostil = type 1, vivo, atacável. Ignora o próprio pokémon (type 3) e player (type 0). */
  const hostiles = snapshot.creatures.filter(c => c
    && c.type === 1
    && c.canAttack === true
    && Number.isFinite(c.healthPercent) && c.healthPercent > 0
    && Number.isFinite(c.id) && c.id > 0);
  if (!hostiles.length) return null;
  /* o mais próximo do player, se tiver posição */
  const player = snapshot.position;
  if (player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
    hostiles.sort((a, b) => {
      const da = Math.abs((a.pos?.x ?? 1e9) - player.x) + Math.abs((a.pos?.y ?? 1e9) - player.y);
      const db = Math.abs((b.pos?.x ?? 1e9) - player.x) + Math.abs((b.pos?.y ?? 1e9) - player.y);
      return da - db;
    });
  }
  return hostiles[0];
}

function main() {
  const options = args(process.argv.slice(2));
  const tapFile = options.tap || latestTap();
  if (!tapFile) {
    console.log('nenhuma captura do tap');
    return;
  }
  console.log('tap     : ' + tapFile);
  console.log('destino : ' + TARGET_FILE);
  if (options.dry) console.log('modo    : DRY (nao escreve)');

  /* mantém o contador entre execuções para o loop detectar mudança */
  let counter = 0;
  if (fs.existsSync(TARGET_FILE)) {
    const current = fs.readFileSync(TARGET_FILE, 'utf8').trim();
    const parts = current.split(',');
    if (parts.length >= 3) counter = Number(parts[2]) || 0;
  }

  let lastId = null;
  const deadline = options.seconds ? Date.now() + options.seconds * 1000 : Infinity;

  const tick = () => {
    const snapshot = newestCreatures(tapFile);
    const hunter = pickTarget(snapshot);
    const count = snapshot ? snapshot.creatures.length : 0;

    if (!hunter) {
      if (options.once) {
        console.log(`sem alvo (creatures=${count}, player=${snapshot?.player || '?'})`);
        return false;
      }
      process.stdout.write(`\raguardando alvo... creatures=${count}            `);
      return true;
    }

    if (hunter.id !== lastId) {
      lastId = hunter.id;
      counter++;
      const line = `${hunter.id},0,${counter}`;
      console.log(`\nalvo: id=${hunter.id} ${hunter.name} hp=${hunter.healthPercent}% `
        + `pos=${JSON.stringify(hunter.pos)}`);
      if (!options.dry) fs.writeFileSync(TARGET_FILE, line, 'ascii');
      console.log('escrito: ' + line);
      if (options.once) return false;
    }
    return true;
  };

  if (options.once) {
    tick();
    return;
  }

  const timer = setInterval(() => {
    if (!tick() || Date.now() > deadline) {
      clearInterval(timer);
      console.log('\nfim');
    }
  }, 300);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
