'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { Transport } = require('./transport.cjs');
const { COMMANDS } = require('./protocol.cjs');
const capabilities = require('./capabilities.cjs');

function channelKey(pid, environment = process.env) {
  if (environment.PKA_CHANNEL_KEY) return environment.PKA_CHANNEL_KEY;
  const filename = environment.PKA_CHANNEL_KEY_FILE;
  if (!filename) throw Error('Configure PKA_CHANNEL_KEY ou PKA_CHANNEL_KEY_FILE para conectar o motor.');
  const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (record.pid !== pid || typeof record.key !== 'string' || !record.key) {
    throw Error('Arquivo da chave ausente, invalido ou de outro PID.');
  }
  return record.key;
}

async function open({ pid, signal }, dependencies = {}) {
  if (signal?.aborted) throw Error('Conexao cancelada.');
  const now = dependencies.now || Date.now;
  const transport = dependencies.transport || new Transport({ pid, key: channelKey(pid), commandTimeoutMs: 1000 });
  const capabilityTimeoutMs = dependencies.capabilityTimeoutMs ?? (dependencies.transport ? 0 : 1500);
  const adapter = new EventEmitter();
  let state = null;
  let telemetry = null;
  let closed = false;
  let failure = null;
  /* Sem declaracao recebida, NENHUM comando e' habilitado. `null` aqui e'
   * "ainda nao sabemos"; `declaration` preenchido e' "ja sabemos". */
  let declaration = null;
  const abort = () => transport.close();
  transport.on('state', value => { state = { value: structuredClone(value), at: now() }; });
  transport.on('telemetry', value => { telemetry = { value: structuredClone(value), at: now() }; });
  const fault = error => {
    failure = error.message;
    adapter.emit('fault', error);
  };
  transport.on('error', fault);
  transport.on('automation-revoked', () => fault(Error('Automacao revogada pelo runtime.')));
  transport.on('close', () => { if (!closed) fault(Error('Canal do runtime encerrado.')); });
  /* Lista de comandos suportados pelo SERVIDOR conectado. Vazia ate' haver
   * declaracao reconhecida: `Object.keys(COMMANDS)` descreve o encoder, nao o
   * servidor, e foi o que mascarou `chase` (status 4) ate' derrubar a sessao. */
  adapter.supportedCommands = [];
  const declaredCommands = () => (declaration && declaration.state === 'valid' ? declaration.commands : []);
  transport.on('declaration', value => {
    declaration = capabilities.parseDeclaration(value);
    /* Muta no lugar: `engine-runtime` guarda a referencia do array. */
    adapter.supportedCommands.length = 0;
    adapter.supportedCommands.push(...declaredCommands());
  });
  /* `capabilities()` sempre devolve uma declaracao interpretada — nunca null —
   * porque `engine-runtime` a usa para decidir a partida. */
  adapter.capabilities = () => declaration || capabilities.parseDeclaration(undefined);
  adapter.getSnapshot = () => {
    if (!state || !telemetry) return null;
    const timestamp = now();
    const ageMs = Math.max(timestamp - state.at, timestamp - telemetry.at);
    const health = state.value.healthPercent;
    return {
      generatedAt: new Date(timestamp).toISOString(), pid,
      online: !closed && !failure && state.value.online === true,
      stale: ageMs < 0 || ageMs > 1000, ageMs, error: failure,
      authExpired: state.value.authExpired === true,
      healthPercent: Number.isFinite(health) && health >= 0 && health <= 100 ? health : undefined,
      targetId: state.value.targetId,
      telemetry: { ...structuredClone(telemetry.value),
        healthPercent: Number.isFinite(health) && health >= 0 && health <= 100 ? health : undefined },
    };
  };
  adapter.command = async (name, parameter, context = {}) => {
    if (closed || failure || context.signal?.aborted || (context.pid !== undefined && context.pid !== pid)) {
      throw Error('Canal fechado, cancelado ou PID divergente.');
    }
    if (!adapter.supportedCommands.includes(name)) throw Error('Comando sem suporte: ' + name);
    const ack = await transport.sendCommand(name, parameter, context.extra);
    if (ack.status !== 0) {
      /* O codigo numerico nunca e' descartado; a interpretacao vem do NOSSO
       * contrato quando ele foi reconhecido. `protocol.cjs:STATUS` e' do
       * fornecedor e diz que 4 = "identidade do Pokemon mudou", enquanto a
       * DLL usa 4 = UNSUPPORTED (pka_native.c:2304). */
      const diagnostic = capabilities.statusMessage(declaration, ack.status);
      const error = Error('Comando rejeitado pelo runtime: ' + name
        + ' (status ' + diagnostic.code + ': ' + diagnostic.text + ')');
      error.code = 'ACK_REJECTED';
      error.command = name;
      error.statusCode = diagnostic.code;
      error.statusInterpreted = diagnostic.interpreted;
      throw error;
    }
    if (ack.type !== COMMANDS[name]) throw Error('ACK de outro tipo de comando: ' + name);
    return true;
  };
  adapter.pauseWalker = async (paused, context) => paused ? adapter.command('stop', 0, context) : true;
  adapter.close = async () => {
    closed = true;
    /* Descarta as capacidades desta sessao: a proxima conexao comeca sem
     * autoridade nenhuma ate o servidor declarar de novo. */
    declaration = null;
    adapter.supportedCommands.length = 0;
    signal?.removeEventListener('abort', abort);
    transport.close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  /* Espera limitada pela declaracao. O kind 6 sai a cada ~500 ms no servidor
   * nativo, entao ela normalmente chega junto do `welcome` no mesmo chunk
   * (transport.connect() despacha os frames ANTES de resolver). Se chegar
   * depois, aguardamos um pouco; se nao chegar, seguimos com lista vazia e
   * diagnostico — nunca travamos e nunca presumimos comandos. */
  const awaitDeclaration = () => new Promise(resolve => {
    if (declaration || capabilityTimeoutMs === 0) { resolve(); return; }
    let timer = null;
    const done = () => { if (timer) clearTimeout(timer); transport.off('declaration', onDeclared); resolve(); };
    const onDeclared = () => done();
    transport.once('declaration', onDeclared);
    timer = setTimeout(done, capabilityTimeoutMs);
    timer.unref?.();
  });
  try {
    await transport.connect();
    if (signal?.aborted || failure) throw Error('Conexao cancelada ou encerrada.');
    await awaitDeclaration();
    if (signal?.aborted || failure) throw Error('Conexao cancelada ou encerrada.');
    if (!declaration) {
      declaration = capabilities.parseDeclaration(undefined);
      adapter.lastCapabilityIssue = declaration.reason;
    }
    return adapter;
  } catch (error) {
    await adapter.close();
    throw error;
  }
}

module.exports = { open, channelKey };
