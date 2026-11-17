'use strict';

/**
 * Gera o schema completo do kind 11 (automation_control) a partir do payload
 * real capturado.
 *
 *   node tools/kind11_schema.cjs [arquivo-json]
 *
 * Saida:
 *   - arvore de caminhos com tipo, valor padrao e cardinalidade
 *   - templates prontos por modulo
 *   - lista de campos que o Shiba manda mas o bot pode omitir (defaults)
 *
 * Nao inventa: tudo vem de captures/kind11/*.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'captures', 'kind11');

function flatten(value, prefix = '', out = {}) {
  if (value === null || typeof value !== 'object') {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    out[prefix + '.__type'] = 'array';
    out[prefix + '.__length'] = value.length;
    if (value.length) flatten(value[0], prefix + '[0]', out);
    return out;
  }
  for (const [k, v] of Object.entries(value)) flatten(v, prefix ? prefix + '.' + k : k, out);
  return out;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function main() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('sem payload em ' + DIR); return; }

  const samples = files.map(f => ({
    file: f,
    data: JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')),
  }));

  /* usa o primeiro (sao identicos exceto seq/module) */
  const base = samples[0].data;
  console.log('fonte: ' + samples.map(s => s.file).join(', ') + '\n');
  console.log('envelope:');
  console.log('  protocol : ' + base.protocol);
  console.log('  boot     : ' + base.boot + '   (id da injecao; muda por sessao)');
  console.log('  client   : ' + base.client + '   (id do menu; muda por sessao)');
  console.log('  seq      : ' + base.seq + '   (incrementa a cada envio)');
  console.log('  op       : "' + base.op + '"');
  console.log('  module   : "' + base.module + '"');
  console.log('  config   : objeto com ' + Object.keys(base.config || {}).length + ' secoes');
  console.log('');

  const config = base.config || {};
  console.log('=== secoes da config (sempre TODAS, independente do module) ===');
  for (const [name, section] of Object.entries(config)) {
    const size = JSON.stringify(section).length;
    const fields = Object.keys(section || {}).length;
    console.log(`  ${name.padEnd(10)} ${String(fields).padStart(3)} campos  ${size} bytes`);
  }

  /* arvore completa */
  const flat = flatten(config);
  const report = {
    envelope: {
      protocol: base.protocol, boot: 'per-session', client: 'per-session',
      seq: 'incrementa', op: ['start'], module: 'target|walker|healer|looting|hoenn|alerts|scripts|tools',
    },
    sections: {},
    totalPaths: Object.keys(flat).length,
  };
  for (const [name, section] of Object.entries(config)) {
    report.sections[name] = flatten(section);
  }

  fs.mkdirSync(DIR, { recursive: true });
  const outFile = path.join(DIR, 'schema.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  console.log('\ncaminhos totais: ' + report.totalPaths);
  console.log('schema salvo: ' + outFile);

  /* template: config completa + envelope */
  const template = {
    protocol: base.protocol,
    boot: 'FILL: boot id da sessao (kind 6/12)',
    client: 'FILL: client id do menu (kind 12)',
    seq: 1,
    op: 'start',
    module: 'target',
    config: base.config,
  };
  const tplFile = path.join(DIR, 'template-start.json');
  fs.writeFileSync(tplFile, JSON.stringify(template, null, 2) + '\n');
  console.log('template salvo: ' + tplFile);

  /* catalogo de caminhos, agrupado por secao, para leitura humana */
  console.log('\n=== campos por secao (arquivo com todos) ===');
  for (const [name, paths] of Object.entries(report.sections)) {
    const keys = Object.keys(paths).filter(k => !k.endsWith('.__type'));
    console.log(`\n--- ${name} (${keys.length}) ---`);
    for (const k of keys.slice(0, 40)) {
      const v = paths[k];
      const shown = k.endsWith('.__length') ? v : JSON.stringify(v);
      console.log('  ' + k.padEnd(46) + typeOf(v).padEnd(8) + shown);
    }
    if (keys.length > 40) console.log(`  ... mais ${keys.length - 40} campos`);
  }
}

main();
