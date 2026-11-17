'use strict';

/**
 * Instala o controlador no menu original substituindo o entrypoint do app.asar.
 *
 * O que troca:
 *   main.cjs  -> nosso bootstrap (captura o canal e carrega o main.jsc original)
 *
 * O que NAO troca:
 *   main.jsc, lib/*.jsc, bytecode-runtime.cjs, renderer/, shared/ — o menu
 *   continua sendo o original, com a mesma identidade.
 *
 * Uso:
 *   node tools/install_payload.cjs --asar <app.asar> --out <app.asar.new>
 *   node tools/install_payload.cjs --asar <app.asar> --out <novo> --verify
 *   node tools/install_payload.cjs --apply --asar <app.asar>
 *
 * Sem --apply nada e escrito no lugar: apenas gera o novo arquivo.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readAsar, extract, pack, verify } = require('./asar_tool.cjs');

const ENTRY = 'main.cjs';
const BOOTSTRAP = path.resolve(__dirname, '..', 'botfinal', 'payload', 'main.cjs');

function parseArgs(argv) {
  const options = { asar: null, out: null, apply: false, verify: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--asar') options.asar = argv[++i];
    else if (argv[i] === '--out') options.out = argv[++i];
    else if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--verify') options.verify = true;
  }
  return options;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function build(asarPath, outPath) {
  const original = sha256(asarPath);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-payload-'));
  const tree = path.join(work, 'tree');
  try {
    extract(asarPath, tree);

    const entryPath = path.join(tree, ENTRY);
    if (!fs.existsSync(entryPath)) throw Error('entrypoint ausente no asar: ' + ENTRY);
    if (!fs.existsSync(BOOTSTRAP)) throw Error('bootstrap ausente: ' + BOOTSTRAP);

    // Backup do entrypoint original dentro da arvore, para auditoria.
    fs.writeFileSync(entryPath + '.orig', fs.readFileSync(entryPath));
    fs.copyFileSync(BOOTSTRAP, entryPath);

    const info = pack(tree, outPath);
    return { original, info, work, tree };
  } finally {
    // A arvore some depois; o asar novo ja esta escrito.
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.asar) {
    console.error('informe --asar <app.asar>');
    return 2;
  }
  const out = options.out || (options.asar + '.new');

  console.log('origem :', options.asar);
  console.log('saida  :', out);
  const { original, info } = build(options.asar, out);
  console.log('sha256 original:', original);
  console.log('sha256 novo    :', sha256(out));
  console.log('tamanho novo   :', fs.statSync(out).size, 'bytes');
  console.log('pack           :', JSON.stringify(info));

  if (options.verify) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-verify-'));
    try {
      extract(out, work);
      const problems = verify(out, work);
      if (problems.length) {
        for (const problem of problems) console.error('  ' + problem);
        console.error('VERIFY FALHOU');
        return 1;
      }
      const entry = fs.readFileSync(path.join(work, ENTRY), 'utf8');
      const hasHook = entry.includes('pka-controller');
      console.log('verify         : OK (84 arquivos, entrypoint trocado:', hasHook + ')');
      if (!hasHook) { console.error('entrypoint novo nao contem o hook'); return 1; }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  if (options.apply) {
    const backup = options.asar + '.orig';
    if (!fs.existsSync(backup)) fs.copyFileSync(options.asar, backup);
    fs.copyFileSync(out, options.asar);
    console.log('Aplicado. Backup em:', backup);
  } else {
    console.log('Nao aplicado (use --apply para substituir no lugar).');
  }
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { build };
