'use strict';

/**
 * Integracao real: AutomationClient <-> RuntimeServer (nosso), pelo pipe.
 *
 *   node --test research/shiba_tap/automation-integration.test.cjs
 *
 * Diferente do automation-client.test.cjs (que usa transport espião), aqui o
 * cliente fala com o nosso servidor de verdade: pipe real, handshake HMAC real,
 * frames reais. Prova os 4 contratos do kind 11 sem depender do jogo nem do tap.
 *
 * O que NAO prova: que o runtime do FORNECEDOR aceita. Isso exige o jogo.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const { Transport } = require(path.join(ROOT, 'reconstruction', 'transport.cjs'));
const { RuntimeServer } = require(path.join(ROOT, 'reconstruction', 'runtime-server.cjs'));
const { AutomationClient } = require('./automation-client.cjs');

const KEY = 'integration-key-0123456789abcdef';
const IDENTITY = { boot: 'boot1122334455', client: 'client99887766' };

let nextPid = 47100 + (process.pid % 200);
const allocPid = () => nextPid++;

async function withServer(fn) {
  const pid = allocPid();
  const server = new RuntimeServer({ pid, key: KEY });
  /* EventEmitter sem listener de 'error' lanca. O servidor emite 'error' numa
   * prova invalida e derruba o processo de teste — nao e' falha do contrato,
   * e' falta de listener. */
  server.on('error', () => {});
  await server.start();
  try { await fn({ server, pid }); }
  finally { try { await server.close(); } catch { /* ignore */ } }
}

function attachClient(pid) {
  const transport = new Transport({ pid, key: KEY, startupTimeoutMs: 3000 });
  transport.on('error', () => {});
  const client = new AutomationClient({ transport, identity: IDENTITY });
  return { transport, client };
}

test('start(target): module + config chegam ao servidor', async () => {
  await withServer(async ({ server, pid }) => {
    const { transport, client } = attachClient(pid);
    await transport.connect();
    assert.equal(transport.authenticated, true);

    const result = await client.start('target');
    await new Promise(r => setTimeout(r, 120));

    assert.equal(result.kind, 11);
    assert.equal(server.controls.length, 1);
    const body = server.controls[0].body;
    assert.equal(body.protocol, 1);
    assert.equal(body.op, 'start');
    assert.equal(body.module, 'target');
    assert.equal(body.boot, IDENTITY.boot);
    assert.equal(body.client, IDENTITY.client);
    assert.equal(body.seq, 1);
    assert.ok(body.config, 'start leva config');
    assert.equal(body.config.target.combo.sequenceText, 'm5');
    transport.close();
  });
});

test('stop(hoenn): module, SEM config', async () => {
  await withServer(async ({ server, pid }) => {
    const { transport, client } = attachClient(pid);
    await transport.connect();
    await client.stop('hoenn');
    await new Promise(r => setTimeout(r, 120));

    const body = server.controls[0].body;
    assert.equal(body.op, 'stop');
    assert.equal(body.module, 'hoenn');
    assert.equal(body.config, undefined, 'stop nao leva config');
    transport.close();
  });
});

test('monitor(true) leva config; monitor(false) nao', async () => {
  await withServer(async ({ server, pid }) => {
    const { transport, client } = attachClient(pid);
    await transport.connect();

    await client.monitor(true);
    await client.monitor(false);
    await new Promise(r => setTimeout(r, 150));

    assert.equal(server.controls.length, 2);
    const [on, off] = server.controls.map(c => c.body);
    assert.equal(on.op, 'monitor');
    assert.equal(on.enabled, true);
    assert.ok(on.config, 'monitor(true) leva config');
    assert.equal(on.module, undefined, 'monitor nao leva module');

    assert.equal(off.enabled, false);
    assert.equal(off.config, undefined, 'monitor(false) vai seco');
    transport.close();
  });
});

test('togglePause: pauseMonitor + key, sem module/config', async () => {
  await withServer(async ({ server, pid }) => {
    const { transport, client } = attachClient(pid);
    await transport.connect();
    await client.togglePause(true);
    await new Promise(r => setTimeout(r, 120));

    const body = server.controls[0].body;
    assert.equal(body.op, 'togglePause');
    assert.equal(body.pauseMonitor, true);
    assert.equal(body.key, 0);
    assert.equal(body.module, undefined);
    assert.equal(body.config, undefined);
    transport.close();
  });
});

test('seq e compartilhado e monotonomico entre ops', async () => {
  await withServer(async ({ server, pid }) => {
    const { transport, client } = attachClient(pid);
    await transport.connect();

    await client.togglePause(false);
    await client.stop('walker');
    await client.start('target');
    await client.monitor(false);
    await new Promise(r => setTimeout(r, 200));

    const seqs = server.controls.map(c => c.body.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4]);
    const ops = server.controls.map(c => c.body.op);
    assert.deepEqual(ops, ['togglePause', 'stop', 'start', 'monitor']);
    transport.close();
  });
});

test('frames consecutivos nao corrompem o framing', async () => {
  await withServer(async ({ server, pid }) => {
    const { transport, client } = attachClient(pid);
    await transport.connect();
    /* dispara em rajada, sem esperar entre eles */
    await Promise.all([
      client.togglePause(false),
      client.stop('target'),
      client.togglePause(true),
    ]);
    await new Promise(r => setTimeout(r, 250));
    assert.equal(server.controls.length, 3, 'tres frames separados');
    const ops = server.controls.map(c => c.body.op).sort();
    assert.deepEqual(ops, ['stop', 'togglePause', 'togglePause']);
    transport.close();
  });
});

test('kind 12 (lease) e aceito pelo servidor', async () => {
  await withServer(async ({ server, pid }) => {
    const { transport } = attachClient(pid);
    await transport.connect();
    const lease = Buffer.from(JSON.stringify({
      protocol: 1, boot: IDENTITY.boot, client: IDENTITY.client, counter: 1,
    }), 'utf8');
    transport.sendFrame(12, lease);
    await new Promise(r => setTimeout(r, 120));
    assert.ok(server.lease, 'servidor guardou o lease');
    assert.equal(server.lease.boot, IDENTITY.boot);
    transport.close();
  });
});

test('cliente nao autenticado nao consegue enviar kind 11', async () => {
  await withServer(async ({ pid }) => {
    const transport = new Transport({ pid, key: KEY });
    /* sem connect(), sendFrame lanca */
    assert.throws(() => transport.sendFrame(11, Buffer.from('{}')), /nao autenticado/u);
  });
});

test('chave errada falha no handshake e nao envia nada', async () => {
  await withServer(async ({ server, pid }) => {
    const transport = new Transport({ pid, key: 'chave-errada-0000000000000000',
      startupTimeoutMs: 1500 });
    transport.on('error', () => {});
    await assert.rejects(transport.connect());
    assert.equal(server.controls.length, 0);
    try { transport.close(); } catch { /* ignore */ }
  });
});

