'use strict';

/**
 * Mede a cadencia de caminhada OBSERVAVEL numa captura do tap, offline.
 *
 *   node tools/tap_walk_cadence.cjs <arquivo.jsonl> [--from <t ms>] [--to <t ms>]
 *
 * Por que offline e nao pelo canal: enquanto o Shiba esta' injetado ele e' dono
 * do pipe. O tap ja' grava a telemetria dele (kind 5, `position`), entao a
 * medida sai da captura sem abrir canal nenhum.
 *
 * O que conta, por transicao de tile:
 *   - intervalo entre mudancas (a cadencia);
 *   - tamanho do salto em tiles (1 = passo normal; 2+ = passo perdido);
 *   - retorno ao tile anterior (indecisao/contorno);
 *   - amostras repetidas com o MESMO tick (leitura duplicada, nao passo novo);
 *   - tick andando para tras.
 *
 * Separa o resultado em janelas de MOVIMENTO e de PARADO: a mediana global
 * mistura as duas e vira ficcao.
 */

const fs = require('node:fs');
const readline = require('node:readline');

const file = process.argv[2];
if (!file) {
  console.error('uso: node tools/tap_walk_cadence.cjs <arquivo.jsonl> [--from ms] [--to ms]');
  process.exit(1);
}
const argNumber = name => {
  const index = process.argv.indexOf('--' + name);
  const value = index > 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) ? value : null;
};
const fromT = argNumber('from');
const toT = argNumber('to');

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};
const tileKey = position => `${position.x},${position.y},${position.z}`;

const steps = [];
const frames = { total: 0, used: 0, outside: 0, unparsed: 0, withoutPosition: 0 };
let tickBackwards = 0;
let sameTickRepeats = 0;
let previous = null;
const creatureTypes = new Map();
let framesWithWild = 0;
let framesWithCreatures = 0;

const stream = fs.createReadStream(file, { encoding: 'utf8' });
const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

lines.on('line', line => {
  frames.total += 1;
  let record;
  try { record = JSON.parse(line); } catch { frames.unparsed += 1; return; }
  if (record.kind !== 5) return;
  if (fromT !== null && record.t < fromT) { frames.outside += 1; return; }
  if (toT !== null && record.t > toT) { frames.outside += 1; return; }
  let telemetry;
  try { telemetry = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8')); } catch { frames.unparsed += 1; return; }
  const position = telemetry.position;
  if (!position || !Number.isInteger(position.x)) { frames.withoutPosition += 1; return; }
  frames.used += 1;

  if (Array.isArray(telemetry.creatures) && telemetry.creatures.length) {
    framesWithCreatures += 1;
    let wild = false;
    for (const creature of telemetry.creatures) {
      /* campo e' `type` (3 = Pokémon próprio, 1 = selvagem), confirmado no
       * frame real: {"id":..,"name":"Diglett","type":3,...,"pos":{..}} */
      const type = creature.type;
      creatureTypes.set(type, (creatureTypes.get(type) || 0) + 1);
      if (type === 1) wild = true;
    }
    if (wild) framesWithWild += 1;
  }

  const at = record.t;
  const key = tileKey(position);
  if (previous) {
    if (Number.isInteger(telemetry.tick) && Number.isInteger(previous.tick)) {
      if (telemetry.tick < previous.tick) tickBackwards += 1;
      if (telemetry.tick === previous.tick) sameTickRepeats += 1;
    }
    if (key !== previous.key) {
      const jump = Math.abs(position.x - previous.position.x)
        + Math.abs(position.y - previous.position.y);
      steps.push({ at, gapMs: at - previous.changedAt, jump,
        zChanged: position.z !== previous.position.z,
        back: key === previous.keyBefore,
        from: previous.key, to: key });
      previous.keyBefore = previous.key;
      previous.changedAt = at;
    }
  }
  previous = { ...(previous || {}), key, position: { ...position },
    changedAt: previous?.changedAt ?? at, tick: telemetry.tick };
});

lines.on('close', () => {
  const gaps = steps.map(step => step.gapMs);
  /* Janela de movimento: passos encadeados com menos de 1 s entre si. O que
   * sobra e' parada (waypoint, combate, lure parada). */
  const moving = gaps.filter(gap => gap <= 1000);
  const jumpHistogram = steps.reduce((histogram, step) => {
    histogram[step.jump] = (histogram[step.jump] || 0) + 1;
    return histogram;
  }, {});

  const report = {
    arquivo: file,
    janela: { from: fromT, to: toT },
    frames,
    amostras: {
      mudancasDeTile: steps.length,
      passosPorSegundo: frames.used ? null : 0,
      retornosAoTileAnterior: steps.filter(step => step.back).length,
      trocasDeAndar: steps.filter(step => step.zChanged).length,
      tickParaTras: tickBackwards,
      leiturasComMesmoTick: sameTickRepeats,
      histogramaDeSalto: jumpHistogram,
    },
    intervalosMs: {
      todos: { n: gaps.length, min: gaps.length ? Math.min(...gaps) : null,
        mediana: median(gaps), p90: percentile(gaps, 0.9),
        max: gaps.length ? Math.max(...gaps) : null },
      emMovimento: { n: moving.length, min: moving.length ? Math.min(...moving) : null,
        mediana: median(moving), p90: percentile(moving, 0.9),
        max: moving.length ? Math.max(...moving) : null },
    },
    criaturas: {
      framesComCriatura: framesWithCreatures,
      framesComSelvagem: framesWithWild,
      tipos: Object.fromEntries([...creatureTypes.entries()].sort((a, b) => b[1] - a[1])),
    },
  };
  if (frames.used) {
    const span = (steps.at(-1)?.at ?? 0) - (steps[0]?.at ?? 0);
    report.amostras.passosPorSegundo = span > 0 ? Number((steps.length / (span / 1000)).toFixed(2)) : 0;
  }
  console.log(JSON.stringify(report, null, 2));
});
