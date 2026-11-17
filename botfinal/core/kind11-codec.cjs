'use strict';

/**
 * Codec do kind 11 (automation_control) — independente do tap.
 *
 * O fornecedor nao tem comando avulso por criatura: o menu manda a CONFIG
 * INTEIRA uma vez com op:"start" e o runtime em C++ executa com a arvore dele.
 * Ver research/shiba_tap/KIND11_SCHEMA.md (medicao, nao suposicao).
 *
 * Envelopes medidos na captura limpa (PID 8036, 20 frames c2s):
 *
 *   start       { protocol, boot, client, seq, op, module, config }
 *   stop        { protocol, boot, client, seq, op, module }
 *   monitor     { protocol, boot, client, seq, op, enabled[, config] }  config so' com enabled:true
 *   togglePause { protocol, boot, client, seq, op, pauseMonitor, key }
 *
 * Este arquivo NAO depende de research/. Ele le a config de
 * botfinal/config/kind11/target-config.json, extraida do template capturado
 * (byte a byte o mesmo payload de 10.158 B, sequenceText "m5").
 */

const fs = require('node:fs');
const path = require('node:path');

const KIND_AUTOMATION_CONTROL = 11;
const KIND_AUTOMATION_LEASE = 12;

const CONFIG_DIR = path.resolve(__dirname, '..', 'config', 'kind11');
const DEFAULT_CONFIG_FILE = path.join(CONFIG_DIR, 'target-config.json');

/* So' isto foi observado em captura. O resto falha com mensagem clara em vez
 * de mandar um payload que o fornecedor talvez ignore. */
const OBSERVED_OP = Object.freeze(['start', 'stop', 'monitor', 'togglePause']);

/* MEDIDO (captura limpa PID 8036, 20 frames kind11 c2s, ordem preservada):
 *
 *     1. togglePause                    5. stop /hoenn    9. start/walker
 *     2. togglePause                    6. stop /walker  10. stop /walker
 *     3. stop /hoenn                    7. monitor [cfg] 17. start/walker
 *     4. stop /walker                   8. monitor       18. start/target
 *                                                         19. stop /target
 *                                                         20. start/target
 *
 * `hoenn` aparece SOMENTE em `stop` — nunca em `start`. O menu manda
 * `stop/hoenn` + `stop/walker` como panic-stop antes de qualquer start, o que
 * faz sentido: "pare tudo que estiver rodando" antes de ligar o modulo novo.
 *
 * Antes eu listava `hoenn` em OBSERVED_MODULE, o que permitia
 * `buildPayload('start', { module: 'hoenn' })` — uma forma que o fornecedor
 * nunca emitiu e que nao tem evidencia de funcionar. Assercao sem medicao. */
const OBSERVED_START_MODULE = Object.freeze(['target', 'walker']);
const OBSERVED_STOP_MODULE = Object.freeze(['target', 'walker', 'hoenn']);

const OBSERVED_MODULE = Object.freeze([...new Set([
  ...OBSERVED_START_MODULE, ...OBSERVED_STOP_MODULE,
])]);

/* Envelope de cada op. Medido, nao inferido. */
const ENVELOPE = Object.freeze({
  start: Object.freeze({ module: true, config: 'always' }),
  stop: Object.freeze({ module: true, config: 'never' }),
  monitor: Object.freeze({ module: false, config: 'when-enabled' }),
  togglePause: Object.freeze({ module: false, config: 'never' }),
});

const HEX32 = /^[0-9a-f]{32}$/u;

let cachedConfig = null;

/** Config base (as 8 secoes) do template capturado. */
function baseConfig() {
  if (cachedConfig) return JSON.parse(JSON.stringify(cachedConfig));
  if (!fs.existsSync(DEFAULT_CONFIG_FILE)) {
    throw Error('config base ausente: ' + DEFAULT_CONFIG_FILE
      + '\nregenerar: node tools/kind11_schema.cjs');
  }
  cachedConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_FILE, 'utf8').replace(/^\uFEFF/u, ''));
  return JSON.parse(JSON.stringify(cachedConfig));
}

/**
 * Monta o payload de um op. `identity` precisa ter boot e client de 32 hex:
 * inventar id aqui so' faz o runtime recusar silenciosamente.
 */
function buildPayload(op, options = {}) {
  const spec = ENVELOPE[op];
  if (!spec) {
    throw Error(`op "${op}" nao foi observado em captura (so: ${OBSERVED_OP.join(', ')}).`);
  }
  const identity = options.identity;
  if (!identity || !HEX32.test(String(identity.boot)) || !HEX32.test(String(identity.client))) {
    throw Error('identity { boot, client } com 32 hex cada e obrigatoria para o kind 11.');
  }
  const module = options.module ?? null;
  if (spec.module) {
    if (!module) throw Error(`op "${op}" exige module.`);
    /* Cada op tem seu proprio vocabulario de module — `hoenn` so' existe em
     * stop. Validar contra a lista certa impede emitir uma combinacao que
     * nunca foi medida (ver comentario em OBSERVED_START_MODULE). */
    const allowed = op === 'start' ? OBSERVED_START_MODULE : OBSERVED_STOP_MODULE;
    if (options.strict !== false && !allowed.includes(module)) {
      throw Error(`module "${module}" nao foi observado em "${op}" `
        + `(so: ${allowed.join(', ')}). Use { strict: false } para forcar.`);
    }
  }

  const payload = {
    protocol: 1,
    boot: identity.boot,
    client: identity.client,
    seq: options.seq,
    op,
  };

  if (op === 'togglePause') {
    payload.pauseMonitor = options.pauseMonitor === true;
    payload.key = Number.isInteger(options.key) ? options.key : 0;
    return payload;
  }
  if (op === 'monitor') {
    payload.enabled = options.enabled !== false;
    if (payload.enabled || options.forceConfig === true) {
      payload.config = options.config || baseConfig();
    }
    return payload;
  }
  payload.module = module;
  if (spec.config === 'always') payload.config = options.config || baseConfig();
  return payload;
}

/** kind 12 (lease). Medido: counter crescente, mesmo envelope sempre. */
function buildLeasePayload(identity, counter) {
  if (!identity || !HEX32.test(String(identity.boot)) || !HEX32.test(String(identity.client))) {
    throw Error('identity { boot, client } com 32 hex cada e obrigatoria para o lease.');
  }
  return { protocol: 1, boot: identity.boot, client: identity.client, counter };
}

module.exports = {
  KIND_AUTOMATION_CONTROL, KIND_AUTOMATION_LEASE,
  OBSERVED_OP, OBSERVED_MODULE, OBSERVED_START_MODULE, OBSERVED_STOP_MODULE, ENVELOPE,
  CONFIG_DIR, DEFAULT_CONFIG_FILE,
  baseConfig, buildPayload, buildLeasePayload, HEX32,
};
