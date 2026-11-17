'use strict';

/**
 * Testes do canal de comando (kind 11) no botfinal.
 *
 *   node --test botfinal/tests/automation_control.test.cjs
 *
 * Dois niveis, separados de proposito:
 *   - unitario : transporte falso, valida estados e contratos
 *   - integracao: nosso RuntimeServer real, pipe e handshake reais
 *
 * Nenhum testa o jogo. Efeito no jogo exige sessao real e nao e' alegado aqui.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');


const ROOT = path.resolve(__dirname, '..', '..');
const { Transport } = require(path.join(ROOT, 'reconstruction', 'transport.cjs'));
const { RuntimeServer } = require(path.join(ROOT, 'reconstruction', 'runtime-server.cjs'));
const { AutomationControl, STATE, classifyFailure, freshIdentity } =
  require(path.join(__dirname, '..', 'core', 'automation-control.cjs'));

const KEY = 'control-key-0123456789abcdef0123';
let nextPid = 48200 + (process.pid % 150);
const allocPid = () => nextPid++;

/** Transporte falso: registra envios, sem rede. EventEmitter para kind 6/12. */
function fakeTransport() {
  const sent = [];
  const emitter = new EventEmitter();
  return {
    sent,
    authenticated: true,
    sendFrame(kind, payload) { sent.push({ kind, payload }); },
    connect: async () => {},
    close: async () => {},
    on(...args) { emitter.on(...args); return this; },
    emit(...args) { return emitter.emit(...args); },
    removeListener(...args) { emitter.removeListener(...args); return this; },
  };
}


async function withServer(fn) {
  const pid = allocPid();
  const server = new RuntimeServer({ pid, key: KEY });
  server.on('error', () => {});
  await server.start();
  try { await fn({ server, pid }); }
  finally { try { await server.close(); } catch { /* ignore */ } }
}

test('freshIdentity gera ids distintos e de 32 hex', () => {
  const a = freshIdentity(1);
  const b = freshIdentity(1);
  assert.match(a.boot, /^[0-9a-f]{32}$/u);
  assert.match(a.client, /^[0-9a-f]{32}$/u);
  assert.notEqual(a.boot, b.boot, 'nao reutiliza id de sessao');
  assert.equal(a.pid, 1);
});

test('classifyFailure separa busy de orphaned', () => {
  assert.equal(classifyFailure(Object.assign(Error('x'), { code: 'EBUSY' })), 'busy');
  assert.equal(classifyFailure(Error('Handshake expirou.')), 'busy');
  assert.equal(classifyFailure(Object.assign(Error('x'), { code: 'EPIPE' })), 'orphaned');
  assert.equal(classifyFailure(Error('ERROR_PIPE_NOT_CONNECTED 233')), 'orphaned');
  assert.equal(classifyFailure(Object.assign(Error('x'), { code: 'ENOENT' })), 'missing');
  assert.equal(classifyFailure(Error('prova do servidor invalida')), 'bad-key');
});

test('operacao sem canal pronto devolve falha, nao lanca', async () => {
  const control = new AutomationControl({ transport: fakeTransport(), pid: 1 });
  const result = await control.start('target');
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'disconnected');
});

test('start envia kind 11 e reporta enviado sem alegar efeito', async () => {
  const transport = fakeTransport();
  const control = new AutomationControl({ transport, pid: 1 });
  control.state = STATE.READY;
  const result = await control.start('target');

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.effect, 'unverified', 'kind 11 nao tem ACK');
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].kind, 11);
  const body = JSON.parse(transport.sent[0].payload.toString('utf8'));
  assert.equal(body.op, 'start');
  assert.equal(body.module, 'target');
  assert.ok(body.config);
});

test('stop aceito, monitor e togglePause com formatos proprios', async () => {
  const transport = fakeTransport();
  const control = new AutomationControl({ transport, pid: 1 });
  control.state = STATE.READY;

  await control.stop('hoenn');
  await control.monitor(true);
  await control.monitor(false);
  await control.togglePause(true);

  const bodies = transport.sent.map(s => JSON.parse(s.payload.toString('utf8')));
  assert.equal(bodies[0].op, 'stop');
  assert.equal(bodies[0].module, 'hoenn');
  assert.equal(bodies[0].config, undefined);

  assert.equal(bodies[1].enabled, true);
  assert.ok(bodies[1].config);

  assert.equal(bodies[2].enabled, false);
  assert.equal(bodies[2].config, undefined);

  assert.equal(bodies[3].op, 'togglePause');
  assert.equal(bodies[3].pauseMonitor, true);
  assert.equal(bodies[3].module, undefined);

  /* seq compartilhado e crescente */
  assert.deepEqual(bodies.map(b => b.seq), [1, 2, 3, 4]);
});

test('busy vira estado BUSY e nao faz retry infinito', async () => {
  const transport = {
    connect: async () => { throw Object.assign(Error('EBUSY'), { code: 'EBUSY' }); },
    sendFrame() {}, close: async () => {},
  };
  const control = new AutomationControl({ transport, pid: 1 });
  const result = await control.connect({ timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'busy');
  assert.equal(control.state, STATE.BUSY);
});

test('connect timeout respeita o limite', async () => {
  /* connect que nunca resolve: o race com timer tem que cortar. O timer e'
   * limpo no finally do connect, senao segura o event loop. */
  const transport = {
    connect: () => new Promise(() => {}),
    sendFrame() {}, close: async () => {},
  };
  const control = new AutomationControl({ transport, pid: 1 });
  const started = Date.now();
  const result = await control.connect({ timeoutMs: 200 });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'timeout');
  assert.ok(elapsed < 1500, 'nao passa do limite: ' + elapsed + 'ms');
});

test('integracao: connect real e start chegam ao servidor', async () => {
  await withServer(async ({ server, pid }) => {
    const transport = new Transport({ pid, key: KEY, startupTimeoutMs: 3000 });
    transport.on('error', () => {});
    const control = new AutomationControl({ transport, pid });

    const connected = await control.connect({ timeoutMs: 3000 });
    assert.equal(connected.ok, true, connected.message);
    assert.equal(control.state, STATE.READY);

    const result = await control.start('target');
    assert.equal(result.ok, true, result.message);
    await new Promise(r => setTimeout(r, 120));

    assert.equal(server.controls.length, 1);
    const body = server.controls[0].body;
    assert.equal(body.op, 'start');
    assert.equal(body.module, 'target');
    assert.equal(body.boot, connected.identity.boot);
    assert.equal(body.client, connected.identity.client);

    await control.close();
    assert.equal(control.state, STATE.DISCONNECTED);
  });
});

test('integracao: chave errada nao vira READY nem envia', async () => {
  await withServer(async ({ server, pid }) => {
    const transport = new Transport({ pid, key: 'errada-000000000000000000000000',
      startupTimeoutMs: 1200 });
    transport.on('error', () => {});
    const control = new AutomationControl({ transport, pid });
    const result = await control.connect({ timeoutMs: 1500 });
    assert.equal(result.ok, false);
    assert.notEqual(control.state, STATE.READY);
    assert.equal(server.controls.length, 0);
  });
});

/* ------------------------------------------------------------------ */
/* Identidade: boot vem do servidor (kind 6), client e' nosso           */
/* ------------------------------------------------------------------ */

test('boot e aprendido do kind 6 da sessao, nao inventado', async () => {
  const transport = fakeTransport();
  const control = new AutomationControl({ transport, pid: 1 });
  const localBoot = control.identity.boot;

  /* kind 6: o runtime publica boot; client pode vir vazio. */
  transport.emit('frame', { kind: 6, payload: Buffer.from(JSON.stringify({
    protocol: 1, boot: 'f9eb201d542ab313cc3db6b38a880cb4', client: '',
  }), 'utf8') });

  assert.equal(control.identity.bootSource, 'session');
  assert.equal(control.identity.boot, 'f9eb201d542ab313cc3db6b38a880cb4');
  assert.notEqual(control.identity.boot, localBoot);
  assert.equal(control.identity.bootFrom, 'automation');
  assert.equal(control.identity.client.length, 32, 'client continua local');
});

test('boot tambem e aprendido do lease (kind 12)', async () => {
  const transport = fakeTransport();
  const control = new AutomationControl({ transport, pid: 1 });
  transport.emit('frame', { kind: 12, payload: Buffer.from(JSON.stringify({
    protocol: 1, boot: 'a'.repeat(32), client: 'b'.repeat(32), counter: 1,
  }), 'utf8') });
  assert.equal(control.identity.boot, 'a'.repeat(32));
  assert.equal(control.identity.bootSource, 'session');
  assert.equal(control.identity.sessionClient, 'b'.repeat(32),
    'client de outro menu e observado, nao adotado');
  assert.notEqual(control.identity.client, 'b'.repeat(32));
});

test('requireSessionBoot recusa conexao sem kind 6/12', async () => {
  const transport = fakeTransport();
  const control = new AutomationControl({ transport, pid: 1,
    requireSessionBoot: true, bootWaitMs: 120 });
  const result = await control.connect({ timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'no-boot');
  assert.notEqual(control.state, STATE.READY);
});

test('requireSessionBoot aceita quando o boot chega durante a espera', async () => {
  const transport = fakeTransport();
  const control = new AutomationControl({ transport, pid: 1,
    requireSessionBoot: true, bootWaitMs: 500 });
  setTimeout(() => transport.emit('frame', { kind: 6, payload: Buffer.from(
    JSON.stringify({ boot: 'c'.repeat(32), client: '' }), 'utf8') }), 40);
  const result = await control.connect({ timeoutMs: 500 });
  assert.equal(result.ok, true, result.message);
  assert.equal(control.identity.bootSource, 'session');
  assert.equal(control.identity.boot, 'c'.repeat(32));
});

/* ------------------------------------------------------------------ */
/* Lease (kind 12)                                                     */
/* ------------------------------------------------------------------ */

test('withLease manda kind 12 antes de cada kind 11, counter crescente', async () => {
  const transport = fakeTransport();
  const control = new AutomationControl({ transport, pid: 1, withLease: true });
  control.state = STATE.READY;
  await control.start('target');
  await control.togglePause(false);

  assert.deepEqual(transport.sent.map(s => s.kind), [12, 11, 12, 11]);
  const leases = transport.sent.filter(s => s.kind === 12)
    .map(s => JSON.parse(s.payload.toString('utf8')));
  assert.deepEqual(leases.map(l => l.counter), [1, 2]);
  assert.equal(leases[0].boot, control.identity.boot);
  assert.equal(leases[0].client, control.identity.client);
  assert.equal(leases[0].seq, undefined, 'lease usa counter, nao seq');
});

test('sem withLease nao manda kind 12 (padrao nao assertado no fornecedor)', async () => {
  const transport = fakeTransport();
  const control = new AutomationControl({ transport, pid: 1 });
  control.state = STATE.READY;
  await control.start('target');
  assert.deepEqual(transport.sent.map(s => s.kind), [11]);
});

/* ------------------------------------------------------------------ */
/* Ciclo de vida do connect                                            */
/* ------------------------------------------------------------------ */

test('timeout fecha o transporte e nao emite READY depois', async () => {
  let closed = 0;
  let resolveConnect = null;
  const transport = {
    authenticated: false,
    connect: () => new Promise(resolve => { resolveConnect = resolve; }),
    sendFrame() {},
    close: async () => { closed += 1; },
    destroy() {},
  };
  const control = new AutomationControl({ transport, pid: 1 });
  const result = await control.connect({ timeoutMs: 80 });
  assert.equal(result.failure, 'timeout');
  assert.ok(closed >= 1, 'transporte foi fechado no timeout');

  /* O connect de verdade resolve DEPOIS do timeout: nao pode virar READY. */
  resolveConnect();
  await new Promise(r => setTimeout(r, 40));
  assert.notEqual(control.state, STATE.READY);
});

test('rejeicao tardia depois do timeout nao vira unhandledRejection', async () => {
  let rejectConnect = null;
  const transport = {
    authenticated: false,
    connect: () => new Promise((_resolve, reject) => { rejectConnect = reject; }),
    sendFrame() {}, close: async () => {}, destroy() {},
  };
  const control = new AutomationControl({ transport, pid: 1 });
  const result = await control.connect({ timeoutMs: 80 });
  assert.equal(result.failure, 'timeout');

  let unhandled = 0;
  const onUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', onUnhandled);
  rejectConnect(Object.assign(Error('EPIPE tardio'), { code: 'EPIPE' }));
  await new Promise(r => setTimeout(r, 80));
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled, 0);
  assert.notEqual(control.state, STATE.READY);
});

test('envio sem ACK drena a fila antes de sair (close nao descarta frame)', async () => {
  /* Regressao real: no caminho --auto o close() acontecia antes do flush e o
   * kind 11 nunca chegava ao servidor. O frame "saia" e o log do servidor
   * ficava vazio. Sem flush, este teste falha. */
  const order = [];
  const transport = {
    authenticated: true,
    sendFrame(kind) { order.push('send:' + kind); },
    flush() { order.push('flush'); return Promise.resolve(true); },
    connect: async () => {},
    close: async () => { order.push('close'); },
  };
  const control = new AutomationControl({ transport, pid: 1 });
  control.state = STATE.READY;
  const result = await control.start('target');
  assert.equal(result.ok, true, result.message);
  await control.close();

  assert.deepEqual(order, ['send:11', 'flush', 'close'],
    'flush precisa acontecer entre o frame e o close');
});



