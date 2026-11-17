'use strict';

/**
 * Shiba Tap & Sniffer — ponto de entrada do módulo.
 *
 *   node research/shiba_tap/index.cjs build
 *   node research/shiba_tap/index.cjs test
 *   node research/shiba_tap/index.cjs inject [--wait 300]
 *   node research/shiba_tap/index.cjs watch [--seconds 120]
 *   node research/shiba_tap/index.cjs report
 *   node research/shiba_tap/index.cjs compare <captura-do-shiba.jsonl>
 *   node research/shiba_tap/index.cjs client --pid N --key <hex>
 *
 * Nada aqui importa botfinal/ nem reconstruction/: o módulo é autocontido para
 * não quebrar quando o agente do bot refatorar o lado dele.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'tools');

const COMMANDS = {
  build: { script: 'build_native.cjs', args: ['--only', 'tap'] },
  test: { script: 'tap_test.cjs', args: [] },
  inject: { script: 'tap_session.cjs', args: ['--inject'] },
  watch: { script: 'tap_session.cjs', args: ['--watch'] },
  report: { script: 'tap_session.cjs', args: ['--report'] },
  compare: { script: 'tap_session.cjs', args: ['--compare'] },
  client: { script: 'tap_client.cjs', args: [] },
  decode: { script: 'tap_decode.cjs', args: [] },
  kind6: { script: 'kind6_map.cjs', args: [] },
};

function usage() {
  console.log('uso: node research/shiba_tap/index.cjs <comando> [args...]');
  console.log('');
  console.log('  build      compila pka_tap.dll (nao toca pka_native.dll)');
  console.log('  test       prova o espiao contra um servidor de teste local');
  console.log('  inject     injeta o tap no jogo (e no menu, se estiver aberto)');
  console.log('  watch      acompanha os arquivos de captura crescendo');
  console.log('  report     decodifica todas as capturas da sessao');
  console.log('  compare    diff de vocabulario contra uma captura do Shiba');
  console.log('  client     cliente minimo do canal (para gerar trafego de teste)');
  console.log('  decode     decodifica um arquivo especifico (--in <arq>)');
  console.log('  kind6      mapeia o frame kind 6 (automation) da captura');
}

function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === 'help' || name === '--help') {
    usage();
    return;
  }
  const entry = COMMANDS[name];
  if (!entry) {
    console.error('comando desconhecido: ' + name);
    usage();
    process.exitCode = 2;
    return;
  }
  const script = path.join(TOOLS, entry.script);
  try {
    execFileSync(process.execPath, [script, ...entry.args, ...rest], { stdio: 'inherit' });
  } catch (error) {
    process.exitCode = error.status ?? 1;
  }
}

if (require.main === module) main();

module.exports = { COMMANDS, ROOT, TOOLS };

