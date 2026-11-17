'use strict';

/**
 * Testes do cliente do kind 11.
 *
 *   node --test research/shiba_tap/automation-client.test.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AutomationClient, KIND_AUTOMATION_CONTROL,
  OBSERVED_OP, OBSERVED_MODULE } = require('./automation-client.cjs');

const DIR = path.resolve(__dirname, '..', '..', 'captures', 'kind11');

function spyTransport() {
  const sent = [];
  return {
    sent,
    sendRaw: async (kind, buffer) => { sent.push({ kind, buffer }); },
  };
}

const identity = { boot: 'deadbeef', client: 'cafebabe' };

test('exige transport com sendRaw ou sendFrame', () => {
  assert.throws(() => new AutomationClient({}), /transport e obrigatorio/u);
  assert.throws(() => new AutomationClient({ transport: {} }),
    /sendRaw|sendFrame/u);
});

test('aceita sendFrame do Transport real', () => {
  const calls = [];
  const transport = { sendFrame: (kind, buf) => { calls.push({ kind, buf }); } };
  const client = new AutomationClient({ transport, identity });
  assert.ok(client);
});

test('templates existem no disco', { skip: !fs.existsSync(DIR) }, () => {
  for (const module of OBSERVED_MODULE) {
    const file = path.join(DIR, `start-${module}.json`);
    assert.ok(fs.existsSync(file), 'falta ' + file);
  }
});

test('start(target) monta envelope correto', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity });
  const result = await client.start('target');

  assert.equal(result.kind, 11);
  assert.equal(result.seq, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].kind, KIND_AUTOMATION_CONTROL);

  const payload = JSON.parse(transport.sent[0].buffer.toString('utf8'));
  assert.equal(payload.protocol, 1);
  assert.equal(payload.op, 'start');
  assert.equal(payload.module, 'target');
  assert.equal(payload.boot, 'deadbeef');
  assert.equal(payload.client, 'cafebabe');
  assert.equal(payload.seq, 1);
  /* a config inteira vai sempre: 8 secoes */
  assert.deepEqual(Object.keys(payload.config).sort(), [
    'alerts', 'healer', 'hoenn', 'looting', 'scripts', 'target', 'tools', 'walker',
  ]);
  assert.equal(payload.config.target.combo.sequenceText, 'm5');
  assert.equal(payload.config.target.monsters.length, 1);
});

test('seq incrementa a cada envio', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity });
  await client.start('target');
  await client.start('walker');
  await client.start('target');
  const seqs = transport.sent.map(entry =>
    JSON.parse(entry.buffer.toString('utf8')).seq);
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.equal(client.sent.length, 3);
});

test('module nao observado e recusado em strict', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity });
  await assert.rejects(client.start('healer'), /nao foi observado/u);
  await assert.rejects(client.start('looting'), /nao foi observado/u);
  /* hoenn passou a ser observado na captura limpa */
  await client.start('hoenn');
  assert.equal(transport.sent.length, 1);
});

test('stop e aceito (observado na captura limpa)', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity });
  const result = await client.stop('target');
  assert.equal(result.op, 'stop');
  assert.equal(result.module, 'target');
  const payload = JSON.parse(transport.sent[0].buffer.toString('utf8'));
  assert.equal(payload.op, 'stop');
  assert.equal(payload.module, 'target');
  /* stop NAO leva config (medido) */
  assert.equal(payload.config, undefined);
  assert.equal(payload.seq, 1);
});

test('togglePause tem pauseMonitor e key, sem module', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity });
  await client.togglePause(true);
  const payload = JSON.parse(transport.sent[0].buffer.toString('utf8'));
  assert.equal(payload.op, 'togglePause');
  assert.equal(payload.pauseMonitor, true);
  assert.equal(payload.key, 0);
  assert.equal(payload.module, undefined);
  assert.equal(payload.config, undefined);
});

test('monitor leva enabled e config opcional', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity });

  await client.monitor(true);
  const withConfig = JSON.parse(transport.sent[0].buffer.toString('utf8'));
  assert.equal(withConfig.op, 'monitor');
  assert.equal(withConfig.enabled, true);
  assert.ok(withConfig.config, 'monitor(true) manda config por padrao');
  assert.equal(withConfig.module, undefined);

  await client.monitor(false);
  const withoutConfig = JSON.parse(transport.sent[1].buffer.toString('utf8'));
  assert.equal(withoutConfig.enabled, false);
  assert.equal(withoutConfig.config, undefined, 'monitor(false) nao manda config');
});

test('op inventado de continuar recusado em strict', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity });
  await assert.rejects(client.send('target', 'restart'), /nao foi observado/u);
  assert.equal(transport.sent.length, 0);
});

test('strict:false permite enviar e remove a nota', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity, strict: false });
  const result = await client.stop('walker');
  assert.equal(result.op, 'stop');
  const payload = JSON.parse(transport.sent[0].buffer.toString('utf8'));
  assert.equal(payload._note, undefined, '_note nao deve ir pro jogo');
});

test('sem identidade falha em strict e passa fora', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const strictClient = new AutomationClient({ transport });
  await assert.rejects(strictClient.start('target'), /boot\/client desconhecidos/u);

  const looseClient = new AutomationClient({ transport, strict: false });
  await looseClient.start('target');
  assert.equal(transport.sent.length, 1);
});

test('identityFromTap le boot/client do kind 12', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kind11-'));
  try {
    const payload = { protocol: 1, boot: 'aaaabbbb', client: 'ccccdddd', counter: 7 };
    const record = { t: 1, dir: 's2c', kind: 12, n: 64, trunc: false,
      d: Buffer.from(JSON.stringify(payload)).toString('hex') };
    const file = path.join(dir, 'pka_tap_1.jsonl');
    fs.writeFileSync(file, JSON.stringify(record) + '\n');

    const client = new AutomationClient({
      transport: spyTransport(), templateDir: DIR,
    });
    const found = client.identityFromTap(file);
    assert.deepEqual(found, { boot: 'aaaabbbb', client: 'ccccdddd', from: 12 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overrides.config substitui a config inteira', { skip: !fs.existsSync(DIR) }, async () => {
  const transport = spyTransport();
  const client = new AutomationClient({ transport, identity });
  const custom = { target: { combo: { sequenceText: 'm3' } } };
  await client.start('target', { config: custom });
  const payload = JSON.parse(transport.sent[0].buffer.toString('utf8'));
  assert.deepEqual(payload.config, custom);
});
