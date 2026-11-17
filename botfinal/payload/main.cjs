'use strict';

/**
 * Ponto de entrada substituto do menu.
 *
 * Ordem:
 *   1. instala o hook de net.connect (captura o canal do menu original),
 *   2. carrega o main.jsc ORIGINAL — o menu funciona exatamente como sempre,
 *   3. quando o canal autentica, sobe o runtime do botfinal em cima dele.
 *
 * Se o hook ou o botfinal falharem, o menu original ainda sobe: um erro aqui
 * nunca pode impedir o usuario de abrir o menu.
 */

const path = require('node:path');
const fs = require('node:fs');

// Caminho padrao do repositorio. Pode ser sobrescrito por PKA_BOTFINAL_DIR.
// Fica embutido para o payload funcionar sem depender de variavel de ambiente,
// ja que o launcher nao a define.
const DEFAULT_ROOT = 'C:\\Users\\yago\\Documents\\Clone\\RECONSTRU\\u00c7AO OFIcial';
const BOTFINAL_ROOT = process.env.PKA_BOTFINAL_DIR || DEFAULT_ROOT;

function log(message) {
  try {
    const line = '[pka-entry] ' + message + '\n';
    process.stdout.write(line);
    if (process.env.PKA_CONTROLLER_LOG_DIR) {
      fs.appendFileSync(path.join(process.env.PKA_CONTROLLER_LOG_DIR, 'controller.log'), line);
    }
  } catch { /* ignore */ }
}

let controller = null;
try {
  // O controller mora no repositorio, fora do asar, para nao precisar
  // reempacotar bibliotecas. O asar so troca este pequeno arquivo.
  const controllerPath = path.join(BOTFINAL_ROOT, 'botfinal', 'payload', 'pka-controller.cjs');
  controller = require(controllerPath).install();
  log('hook instalado');
} catch (error) {
  log('hook indisponivel (menu segue normal): ' + error.message);
}

try {
  require('./bytecode-runtime.cjs');
  const original = require('./main.jsc');
  log('main.jsc original carregado');
  module.exports = original;
} catch (error) {
  log('main.jsc falhou: ' + error.message);
  throw error;
}

if (controller) {
  try {
    const { startBotOnChannel } = require(path.join(BOTFINAL_ROOT, 'botfinal', 'payload', 'bot-bootstrap.cjs'));
    controller.startBot(channel => startBotOnChannel(channel, {
      configFile: process.env.PKA_CONFIG_FILE
        || path.join(BOTFINAL_ROOT, 'botfinal', 'config', 'default-profile.json'),
      root: BOTFINAL_ROOT,
    }));
    log('botfinal armado para o primeiro canal autenticado');
  } catch (error) {
    log('botfinal nao armado: ' + error.message);
  }
}
