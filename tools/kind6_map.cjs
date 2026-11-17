'use strict';

/**
 * Mapeia o frame kind 6 (automation) do canal do fornecedor a partir de uma
 * captura real do tap.
 *
 *   node tools/kind6_map.cjs [arquivo] [--out pasta]
 *
 * O que produz:
 *   - schema completo: todo caminho de campo, tipo, cardinalidade, exemplos
 *   - campos que mudam vs constantes (so os que mudam carregam informacao)
 *   - enums: todo valor distinto visto em cada campo escalar de baixa cardinalidade
 *   - sequencias: transicoes de phase/core.phase/luring.phase na ordem real
 *   - timeline: quantas amostras por segundo e como o estado evolui
 *
 * Nada aqui fala com o jogo. So le o jsonl.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = { input: null, out: path.join(ROOT, 'captures') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') options.out = argv[++i];
    else if (!argv[i].startsWith('--')) options.input = argv[i];
  }
  if (!options.input) {
    /* prefere a captura MAIOR: mais amostras = enums mais completos
     * (foi a sessao de 80 min que revelou o estado `observe`) */
    const dir = path.join(ROOT, 'captures');
    const candidates = [];
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!/^shiba-session.*\.jsonl$/.test(name)) continue;
        const file = path.join(dir, name);
        candidates.push({ file, size: fs.statSync(file).size });
      }
    }
    candidates.sort((a, b) => b.size - a.size);
    options.input = candidates[0]?.file
      || path.join(ROOT, 'native', 'pka_tap_10244.jsonl');
  }
  return options;
}

/** Achata o objeto em pares caminho -> valor. */
function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') {
    out[prefix || '$'] = value;
    return out;
  }
  if (Array.isArray(value)) {
    out[prefix + '.length'] = value.length;
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/** Tipo estavel de um valor, para o schema. */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.input)) {
    throw Error('captura nao encontrada: ' + options.input);
  }

  console.log('arquivo: ' + options.input);
  const sizeMb = (fs.statSync(options.input).size / 1048576).toFixed(1);
  console.log('tamanho: ' + sizeMb + ' MB');

  /* ---- 1. le so os frames kind 6 ---- */
  const samples = [];
  let lines = 0;
  let skipped = 0;
  const text = fs.readFileSync(options.input, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    lines++;
    let record;
    try { record = JSON.parse(line); } catch { skipped++; continue; }
    if (record.kind !== 6 || record.trunc || !record.d) continue;
    try {
      samples.push({
        t: record.t,
        data: JSON.parse(Buffer.from(record.d, 'hex').toString('utf8')),
      });
    } catch { skipped++; }
  }

  console.log('linhas        : ' + lines);
  console.log('kind6 validos : ' + samples.length);
  if (skipped) console.log('ignorados     : ' + skipped);
  if (!samples.length) throw Error('nenhuma amostra de kind 6 valida');

  const durationMs = samples[samples.length - 1].t - samples[0].t;
  console.log('duracao       : ' + (durationMs / 1000).toFixed(1) + ' s');
  console.log('taxa          : ' + (samples.length / (durationMs / 1000)).toFixed(1) + ' amostras/s');

  /* ---- 2. schema: caminho -> tipos, contagem, valores distintos ---- */
  const schema = new Map();
  const valueFreq = new Map();

  for (const sample of samples) {
    for (const [key, value] of Object.entries(flatten(sample.data))) {
      let entry = schema.get(key);
      if (!entry) {
        entry = { types: new Set(), count: 0, distinct: new Set(), changed: 0 };
        schema.set(key, entry);
      }
      entry.count++;
      entry.types.add(typeOf(value));
      if (value !== null && typeof value !== 'object' && entry.distinct.size < 40) {
        entry.distinct.add(JSON.stringify(value));
      }
      if (typeof value !== 'object' || value === null) {
        const freqKey = key + '=' + JSON.stringify(value);
        valueFreq.set(freqKey, (valueFreq.get(freqKey) || 0) + 1);
      }
    }
  }

  /* campos que mudam: comparar primeira e ultima ocorrencia */
  const first = flatten(samples[0].data);
  const last = flatten(samples[samples.length - 1].data);
  for (const key of new Set([...Object.keys(first), ...Object.keys(last)])) {
    const a = JSON.stringify(first[key]);
    const b = JSON.stringify(last[key]);
    if (a !== b) {
      const entry = schema.get(key);
      if (entry) entry.changed = 1;
    }
  }

  /* ---- 3. relatorio ---- */
  fs.mkdirSync(options.out, { recursive: true });
  const report = { input: options.input, samples: samples.length, durationMs, fields: {} };

  const catalog = [];
  for (const [key, entry] of [...schema.entries()].sort()) {
    catalog.push({
      field: key,
      types: [...entry.types].sort(),
      seenIn: entry.count,
      coverage: +(entry.count / samples.length).toFixed(3),
      varies: entry.changed === 1,
      values: [...entry.distinct].slice(0, 24),
    });
  }
  report.fields = catalog;

  fs.writeFileSync(path.join(options.out, 'kind6-schema.json'),
    JSON.stringify(report, null, 2) + '\n');

  /* ---- 4. sequencias de fase ---- */
  function sequence(pick) {
    const out = [];
    for (const sample of samples) {
      const value = pick(sample.data);
      if (value === undefined) continue;
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (text === 'null' || text === '"" ' || text === '') continue;
      if (!out.length || out[out.length - 1].value !== text) {
        out.push({ t: sample.t, value: text });
      }
    }
    return out;
  }

  const phases = sequence(d => d.phase);
  const corePhases = sequence(d => d.core?.phase);
  const lureModes = sequence(d => d.luring?.mode);
  const lurePhases = sequence(d => d.luring?.phase);
  const modulesChanges = sequence(d => JSON.stringify(d.modules));

  console.log('\n-- transicoes --');
  console.log('phase         : ' + phases.length);
  console.log('core.phase    : ' + corePhases.length);
  console.log('luring.mode   : ' + lureModes.length);
  console.log('luring.phase  : ' + lurePhases.length);
  console.log('modules       : ' + modulesChanges.length);

  const transitions = { phases, corePhases, lureModes, lurePhases, modulesChanges };
  fs.writeFileSync(path.join(options.out, 'kind6-transitions.json'),
    JSON.stringify(transitions, null, 2) + '\n');

  /* ---- 5. sumario no terminal ---- */
  console.log('\n-- campos (' + catalog.length + ') --');
  const varies = catalog.filter(f => f.varies);
  const constant = catalog.filter(f => !f.varies);
  console.log('variam  : ' + varies.length);
  console.log('constante: ' + constant.length);

  console.log('\n-- campos que VARIAM (carregam informacao) --');
  for (const field of varies) {
    const sample = field.values.slice(0, 6).join(', ');
    console.log('  ' + field.field.padEnd(34) +
      (field.values.length > 6 ? field.values.length + '+' : '') +
      '  ' + sample.slice(0, 96));
  }

  console.log('\n-- primeiras 24 transicoes de phase --');
  phases.slice(0, 24).forEach((item, index) => {
    console.log('  ' + String(index).padStart(2) + '  ' + item.value);
  });

  console.log('\nsalvo:');
  console.log('  ' + path.join(options.out, 'kind6-schema.json'));
  console.log('  ' + path.join(options.out, 'kind6-transitions.json'));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
