'use strict';

/**
 * Espera o Shiba COMECAR A ANDAR na captura do tap e mede a janela de
 * movimento, sem abrir canal nenhum.
 *
 *   node tools/tap_wait_movement.cjs <arquivo.jsonl> [--passos 25] [--timeout 300]
 *
 * Marca o `t` atual do fim do arquivo e analisa so' o que entrar depois disso.
 * Sai quando juntar `--passos` mudancas de tile (ou no timeout, com o que
 * tiver). Imprime o relatorio de tools/tap_walk_cadence.cjs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const file = process.argv[2];
if (!file) { console.error('uso: node tools/tap_wait_movement.cjs <arquivo.jsonl>'); process.exit(1); }
const argNumber = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  const value = index > 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const wanted = argNumber('passos', 25);
const timeoutMs = argNumber('timeout', 300) * 1000;
const analyzer = path.join(__dirname, 'tap_walk_cadence.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Ultimo `t` do arquivo (le' so' a cauda: o arquivo passa de 20 MB rapido). */
function lastT() {
  const size = fs.statSync(file).size;
  const window = Math.min(size, 256 * 1024);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(window);
  fs.readSync(fd, buffer, 0, window, size - window);
  fs.closeSync(fd);
  const text = buffer.toString('utf8');
  const matches = [...text.matchAll(/"t":(\d+)/g)];
  return matches.length ? Number(matches.at(-1)[1]) : 0;
}

function analyze(from) {
  const output = execFileSync(process.execPath,
    [analyzer, file, '--from', String(from)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output);
}

(async () => {
  const marker = lastT();
  console.log(`marcador t=${marker}; esperando ${wanted} mudancas de tile em ${timeoutMs / 1000}s`);
  const deadline = Date.now() + timeoutMs;
  let report = null;
  while (Date.now() < deadline) {
    await sleep(8000);
    if (fs.statSync(file).size === 0) continue;
    try { report = analyze(marker); } catch (error) {
      console.log('analise falhou: ' + error.message);
      continue;
    }
    const changes = report.amostras.mudancasDeTile;
    console.log(`  ${new Date().toISOString().slice(11, 19)} mudancas=${changes} selvagens=${report.criaturas.framesComSelvagem}`);
    if (changes >= wanted) break;
  }
  if (!report) report = analyze(marker);
  const outFile = path.join(path.dirname(file), path.basename(file).replace('.jsonl', '') + '-cadencia.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('salvo em ' + outFile);
  process.exitCode = report.amostras.mudancasDeTile >= wanted ? 0 : 2;
})();
