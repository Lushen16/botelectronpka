'use strict';

/**
 * Templates do kind 11 por modulo, gerados do payload real.
 *
 *   node tools/kind11_templates.cjs
 *
 * Gera em captures/kind11/:
 *   start-target.json   op=start, module=target
 *   start-walker.json   op=start, module=walker
 *   start-healer.json   op=start, module=healer     (module nao observado)
 *   start-looting.json  op=start, module=looting    (module nao observado)
 *   stop-<module>.json  op=stop                     (op nao observado)
 *
 * ATENCAO: os arquivos marcados "nao observado" usam a mesma config e so'
 * trocam o campo. O valor de `module` para healer/looting e `stop` para op NAO
 * foi medido na captura - esta declarado no proprio arquivo via `_note`.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'captures', 'kind11');
const BASE = path.join(DIR, 'target-start.json');

const OBSERVED = { op: ['start'], module: ['target', 'walker'] };

function main() {
  if (!fs.existsSync(BASE)) {
    console.log('falta ' + BASE + ' — rode tools/kind11_schema.cjs antes');
    return;
  }
  const base = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  const config = base.config;

  const emit = (name, patch, note) => {
    const payload = {
      protocol: base.protocol,
      boot: base.boot,
      client: base.client,
      seq: base.seq,
      op: patch.op ?? base.op,
      module: patch.module ?? base.module,
      config,
    };
    if (note) payload._note = note;
    const file = path.join(DIR, name);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
    const flag = note ? '  (NAO OBSERVADO)' : '';
    console.log('  ' + name + flag);
  };

  console.log('gerando templates:');
  /* observados */
  emit('start-target.json', { op: 'start', module: 'target' });
  emit('start-walker.json', { op: 'start', module: 'walker' });

  /* presumidos: module existe na config mas o valor de `module` nao foi visto */
  for (const module of ['healer', 'looting', 'hoenn', 'alerts', 'scripts', 'tools']) {
    emit('start-' + module + '.json', { op: 'start', module },
      'module="' + module + '" nao observado em captura; presumido pelo nome da secao de config');
  }

  /* presumidos: op stop nao foi capturado */
  for (const module of OBSERVED.module) {
    emit('stop-' + module + '.json', { op: 'stop', module },
      'op="stop" nao observado em captura; presumido');
  }

  console.log('\nobservado na captura:');
  console.log('  op     : ' + OBSERVED.op.join(', '));
  console.log('  module : ' + OBSERVED.module.join(', '));
  console.log('\npara capturar os ausentes: com o tap ligado, pausar/retomar o bot');
  console.log('e mudar uma config com ele rodando — cada acao deve gerar um kind 11.');
}

main();

