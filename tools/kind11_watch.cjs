'use strict';

/**
 * Vigia o kind 11 em tempo real, sem carregar o arquivo inteiro.
 *
 *   node tools/kind11_watch.cjs [segundos] [--both]
 *
 * Mantem a posicao de leitura de cada tap e so' processa linhas novas.
 * Mostra envelope resumido + diff da config contra o ultimo payload visto,
 * para revelar o que cada op/update altera.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');

function args(argv) {
  const options = { seconds: 120, both: false };
  for (const arg of argv) {
    if (/^\d+$/.test(arg)) options.seconds = Number(arg);
    else if (arg === '--both') options.both = true;
  }
  return options;
}

/** taps recentes */
function taps() {
  if (!fs.existsSync(NATIVE)) return [];
  return fs.readdirSync(NATIVE)
    .filter(name => /^pka_tap_\d+\.jsonl$/.test(name))
    .map(name => path.join(NATIVE, name))
    .filter(file => {
      const st = fs.statSync(file);
      return st.size > 0 && Date.now() - st.mtimeMs < 10 * 60 * 1000;
    })
    .map(file => ({
      file,
      label: path.basename(file, '.jsonl').replace('pka_tap_', 'pid '),
      offset: Math.max(0, fs.statSync(file).size - 256 * 1024),
    }));
}

function diffConfig(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    const at = prefix ? prefix + '.' + key : key;
    const left = a?.[key];
    const right = b?.[key];
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        out.push(`${at}: ${JSON.stringify(left)} -> ${JSON.stringify(right)}`);
      }
      continue;
    }
    if (Array.isArray(left) !== Array.isArray(right)) {
      out.push(`${at}: tipo mudou`);
      continue;
    }
    out.push(...diffConfig(left, right, at));
  }
  return out;
}

async function main() {
  const options = args(process.argv.slice(2));
  let watch = taps();
  if (!options.both && watch.length) {
    /* por padrao: o tap do MENU e' quem manda comando (c2s) */
    const menu = watch.find(w => w.file.includes('12576'));
    watch = menu ? [menu] : watch.slice(0, 1);
  }
  if (!watch.length) { console.log('nenhum tap ativo'); return; }

  console.log('vigiando kind 11 por ' + options.seconds + 's:');
  for (const item of watch) {
    console.log(`  ${item.label}  ${item.file}`);
  }
  console.log('\naguardando... (pause/resume e altere config no menu do Shiba)\n');

  let lastPayload = null;
  let seen = 0;
  const deadline = Date.now() + options.seconds * 1000;

  while (Date.now() < deadline) {
    for (const item of watch) {
      let stat;
      try { stat = fs.statSync(item.file); } catch { continue; }
      if (stat.size <= item.offset) continue;

      const length = stat.size - item.offset;
      const buf = Buffer.alloc(length);
      let fd;
      try {
        fd = fs.openSync(item.file, 'r');
        fs.readSync(fd, buf, 0, length, item.offset);
      } catch { continue; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
      item.offset = stat.size;

      const text = buf.toString('utf8');
      const lines = text.split(/\r?\n/);
      /* a ultima linha pode estar incompleta: recua o offset */
      if (lines.length && !text.endsWith('\n')) {
        item.offset -= Buffer.byteLength(lines[lines.length - 1], 'utf8');
        lines.pop();
      }

      for (const line of lines) {
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record.kind !== 11 || !record.d) continue;
        let payload;
        try { payload = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8')); }
        catch { console.log('  [kind11 nao parseavel]'); continue; }

        seen++;
        console.log(`\n[${new Date().toLocaleTimeString()}] KIND 11 #${seen}  ${item.label}`);
        console.log(`  dir=${record.dir}  n=${record.n}  bytes=${record.d.length / 2}`);
        console.log(`  op="${payload.op}"  module="${payload.module}"  seq=${payload.seq}`);
        console.log(`  boot=${String(payload.boot).slice(0, 10)}...  client=${String(payload.client).slice(0, 10)}...`);
        console.log(`  secoes: ${Object.keys(payload.config || {}).join(', ')}`);

        if (lastPayload) {
          const changes = diffConfig(lastPayload.config, payload.config);
          if (changes.length) {
            console.log(`  CONFIG MUDOU EM ${changes.length} CAMPO(S):`);
            for (const change of changes.slice(0, 20)) console.log('    ' + change);
            if (changes.length > 20) console.log(`    ... mais ${changes.length - 20}`);
          } else {
            console.log('  config igual ao payload anterior');
          }
          if (lastPayload.module !== payload.module) {
            console.log(`  module mudou: "${lastPayload.module}" -> "${payload.module}"`);
          }
          if (lastPayload.op !== payload.op) {
            console.log(`  op mudou: "${lastPayload.op}" -> "${payload.op}"`);
          }
        }
        lastPayload = payload;
      }
    }
    await sleep(300);
  }

  console.log(`\n\nfim: ${seen} kind 11 capturado(s)`);
  if (!seen) {
    console.log('nenhum kind 11 novo. Verifique se o tap do MENU esta ativo');
    console.log('(o menu manda c2s; o tap do jogo ve s2c).');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

main().catch(error => { console.error(error.message); process.exitCode = 1; });
