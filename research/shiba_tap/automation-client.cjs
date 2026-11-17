'use strict';

/**
 * Cliente do kind 11 (automation_control) — o canal de comando real.
 *
 * O projeto procurou um `kind 9` de ataque. Nao existe. O menu manda a config
 * INTEIRA pelo kind 11 com `op: "start"`, e a DLL em C++ executa.
 * Ver research/shiba_tap/KIND11_SCHEMA.md.
 *
 *   const { AutomationClient } = require('./automation-client.cjs');
 *   const client = new AutomationClient({ pid, transport });
 *   await client.start('target');
 *
 * `transport` precisa expor `sendRaw(kind, Buffer)` — o botfinal ja tem
 * `write(kind, payload)` no transporte base. Adapte com uma linha:
 *
 *   const transport = { sendRaw: (kind, buf) => pipe.write(kind, buf) };
 *
 * O modulo NAO inventa op nem module: so' aceita o que foi medido
 * (`start` + `target`/`walker`), e recusa o resto com erro explicito.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_DIR = path.join(ROOT, 'captures', 'kind11');

const KIND_AUTOMATION_CONTROL = 11;
const KIND_AUTOMATION_LEASE = 12;

/* Só isto foi observado em captura. O resto falha com mensagem clara em vez de
 * mandar um payload que o fornecedor talvez ignore. */
const OBSERVED_OP = new Set(['start', 'stop', 'monitor', 'togglePause']);
const OBSERVED_MODULE = new Set(['target', 'walker', 'hoenn']);

class AutomationClient {
  constructor(options = {}) {
    /* Aceita os dois nomes de transporte do repo:
     *   - sendRaw(kind, Buffer)      adaptador simples (testes)
     *   - sendFrame(kind, Buffer)    Transport real de reconstruction/transport.cjs
     * Sem isso o cliente nao pluga no transporte que o botfinal ja usa. */
    const transport = options.transport;
    if (!transport) throw Error('transport e obrigatorio');
    if (typeof transport.sendRaw === 'function') {
      this._send = (kind, buffer) => transport.sendRaw(kind, buffer);
    } else if (typeof transport.sendFrame === 'function') {
      this._send = async (kind, buffer) => {
        transport.sendFrame(kind, buffer);
        return { kind, bytes: buffer.length };
      };
    } else if (typeof transport.write === 'function' && typeof transport.sendFrame === 'function') {
      throw Error('transporte ambiguo');
    } else {
      throw Error('transport precisa de sendRaw(kind, Buffer) ou sendFrame(kind, Buffer)');
    }
    this.transport = transport;
    this.templateDir = options.templateDir || TEMPLATE_DIR;
    this.seq = Number.isInteger(options.seq) ? options.seq : 0;
    /* kind 12 usa `counter`, nao `seq`, e comeca em 1 na captura limpa.
     * Medido: kind 12 sai c2s no mesmo t de cada kind 11. */
    this.counter = Number.isInteger(options.counter) ? options.counter : 0;
    this.strict = options.strict !== false;
    this.sent = [];
    this.leases = [];
    this.identity = options.identity || null;
  }

  /** Carrega o template do disco. */
  template(module, op = 'start') {
    const file = path.join(this.templateDir, `${op}-${module}.json`);
    if (!fs.existsSync(file)) {
      throw Error(`template ausente: ${file}\nrode: node tools/kind11_templates.cjs`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** Extrai boot/client do kind 6 ou 12 mais recente de um tap. */
  identityFromTap(tapFile) {
    if (!tapFile || !fs.existsSync(tapFile)) return null;
    const text = fs.readFileSync(tapFile, { encoding: 'utf8', flag: 'r' });
    /* le so' o fim: arquivos passam de 500 MB */
    const tail = text.slice(Math.max(0, text.length - 256 * 1024));
    for (const line of tail.split(/\r?\n/).reverse()) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.kind !== 12 && record.kind !== 6) continue;
      if (!record.d) continue;
      try {
        const payload = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8'));
        if (payload.boot && payload.client) {
          return { boot: payload.boot, client: payload.client, from: record.kind };
        }
      } catch { /* truncado */ }
    }
    return null;
  }

  /**
   * Envia um comando do kind 11.
   *
   * Cada `op` tem um envelope diferente (medido em captura limpa):
   *
   *   start       : { op, module, config }        module obrigatorio
   *   stop        : { op, module }                module obrigatorio
   *   monitor     : { op, enabled, config? }      config opcional
   *   togglePause : { op, pauseMonitor, key }     sem module
   */
  async send(module, op = 'start', overrides = {}) {
    if (this.strict && !OBSERVED_OP.has(op)) {
      throw Error(`op "${op}" nao foi observado em captura (so: ${[...OBSERVED_OP].join(', ')}).\n`
        + 'Para enviar mesmo assim: new AutomationClient({ strict: false })');
    }
    /* togglePause e monitor nao levam module */
    const needsModule = op === 'start' || op === 'stop';
    if (this.strict && needsModule && !OBSERVED_MODULE.has(module)) {
      throw Error(`module "${module}" nao foi observado em captura `
        + `(so: ${[...OBSERVED_MODULE].join(', ')}).\n`
        + 'Para enviar mesmo assim: new AutomationClient({ strict: false })');
    }

    const identity = this.identity || this.identityFromTap(overrides.tapFile);
    if (!identity && this.strict) {
      throw Error('boot/client desconhecidos: passe identity { boot, client } '
        + 'ou tapFile com kind 12/6');
    }

    const payload = { protocol: 1 };
    payload.boot = identity ? identity.boot : 'FILL';
    payload.client = identity ? identity.client : 'FILL';
    this.seq += 1;
    payload.seq = this.seq;
    payload.op = op;

    if (op === 'togglePause') {
      payload.pauseMonitor = overrides.pauseMonitor === true;
      payload.key = Number.isInteger(overrides.key) ? overrides.key : 0;
    } else if (op === 'monitor') {
      payload.enabled = overrides.enabled !== false;
      /* Medido: monitor(true) leva a config; monitor(false) vai so' com
       * { op, enabled } (seq=8 na captura limpa). Manda config apenas quando
       * habilitando, ou quando o chamador pedir explicitamente. */
      const config = overrides.config
        || (payload.enabled ? this.defaultConfig() : null);
      if (config) payload.config = config;
    } else {
      payload.module = module;
      if (op === 'start') {
        payload.config = overrides.config || this.defaultConfig();
      }
    }

    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    await this._send(KIND_AUTOMATION_CONTROL, bytes);
    const result = { kind: KIND_AUTOMATION_CONTROL, op, seq: payload.seq,
      bytes: bytes.length, boot: payload.boot, client: payload.client };
    if (needsModule) result.module = module;
    this.sent.push(result);
    return result;
  }

  /** Config padrao: do template `start-target.json`. */
  defaultConfig() {
    try { return this.template('target', 'start').config; }
    catch { return null; }
  }

  /**
   * Envia o lease (kind 12) — heartbeat de posse do menu.
   *
   * Medido em pka_tap_8036.jsonl: cada kind 11 c2s vem acompanhado de um
   * kind 12 no MESMO timestamp, com `counter` 1,2,3,... nao `seq`.
   * O payload e' { protocol, boot, client, counter }.
   *
   * Nao foi provado que o runtime do fornecedor EXIJA o lease antes do
   * kind 11 (o menu manda porque e' o menu). Mantenha opcional.
   */
  async lease() {
    const identity = this.identity;
    if (!identity) throw Error('identity obrigatoria para o lease (kind 12)');
    this.counter += 1;
    const payload = {
      protocol: 1,
      boot: identity.boot,
      client: identity.client,
      counter: this.counter,
    };
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    await this._send(KIND_AUTOMATION_LEASE, bytes);
    const result = { kind: KIND_AUTOMATION_LEASE, counter: payload.counter,
      bytes: bytes.length, boot: payload.boot, client: payload.client };
    this.leases.push(result);
    return result;
  }

  /** Liga um modulo. */
  start(module, overrides) { return this.send(module, 'start', overrides); }

  /** Desliga um modulo. */
  stop(module, overrides) { return this.send(module, 'stop', overrides); }

  /** Liga/desliga o monitor (com config opcional). */
  monitor(enabled = true, overrides = {}) {
    return this.send(null, 'monitor', { ...overrides, enabled });
  }

  /** Pausa/retoma tudo. `pauseMonitor` controla o monitor junto. */
  togglePause(pauseMonitor = false, overrides = {}) {
    return this.send(null, 'togglePause', { ...overrides, pauseMonitor });
  }
}

module.exports = { AutomationClient, KIND_AUTOMATION_CONTROL, KIND_AUTOMATION_LEASE,
  OBSERVED_OP, OBSERVED_MODULE };


