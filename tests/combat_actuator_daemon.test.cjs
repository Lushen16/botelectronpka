'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { createCombatInput } = require('../reconstruction/keyboard-combat.cjs');

const PYTHON = process.env.PKA_PYTHON || 'python';
const TOOLS = path.resolve(__dirname, '../tools');

// Stub actuator: same serve loop and result contract, without real Win32.
const STUB = String.raw`
import sys, time
sys.path.insert(0, ${JSON.stringify(TOOLS)})
import combat_actuator as combat

def bind(self, pid):
    return None, None, 77

def fake_dispatch(user, kernel, pid, hwnd, request, result):
    if request.get('hang'):
        time.sleep(30)
    if request.get('crash'):
        sys.exit(7)
    if request.get('reject'):
        result.update(success=False, error='alvo mudou', errorCode='COMBAT_TARGET_MOVED')
        raise ValueError('alvo mudou')
    kind = request.get('kind', 'key')
    result.update(success=True, kind=kind, transport='PostMessageW', effectVerified=False,
                  eventsSent=4 if kind == 'useWith' else 0 if kind == 'probe' else 2,
                  pointerEventsSent=0)
    return result

combat.Session._bind = bind
combat.dispatch = fake_dispatch
sys.argv = ['combat_actuator.py', '--serve']
raise SystemExit(combat.main())
`;

function daemonInput(overrides = {}) {
  return createCombatInput({ python: PYTHON, args: ['-B', '-c', STUB], timeoutMs: 3000, ...overrides });
}

test('resident channel reuses one interpreter for sequential commands', async () => {
  let spawns = 0;
  const input = daemonInput({
    spawn: (...args) => { spawns++; return spawn(...args); },
  });
  try {
    await input(42, { kind: 'key', key: 'F1' });
    assert.equal(spawns, 1);
    const started = process.hrtime.bigint();
    for (let index = 0; index < 40; index++) {
      assert.equal((await input(42, { kind: 'key', key: 'F1' })).eventsSent, 2);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(spawns, 1, 'nenhum interpretador novo por comando');
    assert.equal(input.mode(), 'daemon');
    assert.ok(elapsedMs / 40 < 20, `comandos residentes lentos: ${elapsedMs / 40}ms`);
    assert.equal((await input(42, { kind: 'attack', x: 10, y: 20 })).eventsSent, 2);
    assert.equal((await input(42, { kind: 'useWith', key: 'F1' })).eventsSent, 4);
    assert.equal((await input(42, { kind: 'probe' })).eventsSent, 0);
  } finally {
    input.close();
  }
});

test('prewarm pays the interpreter start before the first command', async () => {
  let spawns = 0;
  const input = daemonInput({ spawn: (...args) => { spawns++; return spawn(...args); } });
  try {
    assert.equal(await input.prewarm(), true);
    assert.equal(spawns, 1);
    const started = process.hrtime.bigint();
    await input(42, { kind: 'key', key: 'F1' });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(elapsedMs < 25, `primeiro comando apos prewarm lento: ${elapsedMs}ms`);
    assert.equal(spawns, 1);
    assert.equal(await input.prewarm(), true);
    assert.equal(spawns, 1, 'prewarm repetido nao duplica o worker');
  } finally {
    input.close();
  }
});

test('resident channel rejects invalid commands before touching the interpreter', async () => {
  let spawns = 0;
  const input = daemonInput({ spawn: (...args) => { spawns++; return spawn(...args); } });
  try {
    for (const request of [null, [], { kind: 'kick' }]) {
      await assert.rejects(input(42, request), /PID ou request de combate invalido/);
    }
    await assert.rejects(input(0, { kind: 'key', key: 'F1' }), /PID ou request de combate invalido/);
    assert.equal(spawns, 0);
  } finally {
    input.close();
  }
});

test('resident channel preserves rejection codes and never reports success early', async () => {
  const input = daemonInput();
  try {
    await assert.rejects(input(42, { kind: 'attack', x: 1, y: 1, reject: true }), error => {
      assert.equal(error.code, 'COMBAT_TARGET_MOVED');
      assert.equal(error.retrySafe, false);
      assert.equal(error.result.errorCode, 'COMBAT_TARGET_MOVED');
      return true;
    });
    assert.equal((await input(42, { kind: 'key', key: 'F1' })).success, true);
  } finally {
    input.close();
  }
});

test('crashed or stalled workers fail uncertain and recover on the next command', async () => {
  const input = daemonInput({ timeoutMs: 1000 });
  try {
    await input(42, { kind: 'key', key: 'F1' });
    await assert.rejects(input(42, { kind: 'key', key: 'F1', crash: true }), error => {
      assert.equal(error.retrySafe, false);
      assert.equal(error.uncertain, true);
      return true;
    });
    assert.equal((await input(42, { kind: 'key', key: 'F1' })).eventsSent, 2);

    const started = Date.now();
    await assert.rejects(input(42, { kind: 'key', key: 'F1', hang: true }), error => {
      assert.equal(error.retrySafe, false);
      assert.equal(error.uncertain, true);
      return true;
    });
    assert.ok(Date.now() - started < 3000, 'timeout do canal nao interrompeu o worker travado');
    assert.equal((await input(42, { kind: 'key', key: 'F1' })).eventsSent, 2);
  } finally {
    input.close();
  }
});

test('missing interpreter degrades transparently to the per-command actuator', async () => {
  const legacyCalls = [];
  const input = createCombatInput({
    daemon: true,
    python: 'definitely-not-a-python-interpreter',
    spawn: () => {
      const proc = new EventEmitter();
      proc.pid = undefined;
      setImmediate(() => proc.emit('error', Object.assign(Error('spawn ENOENT'), { code: 'ENOENT' })));
      return proc;
    },
    execFile: (_exe, args, _options, callback) => {
      legacyCalls.push(args);
      callback(null, JSON.stringify({ success: true, pid: 42, eventsSent: 2,
        transport: 'PostMessageW', effectVerified: false }));
    },
  });
  try {
    const result = await input(42, { kind: 'key', key: 'F1' });
    assert.equal(result.eventsSent, 2);
    assert.equal(legacyCalls.length, 1);
    assert.equal(input.mode(), 'process');
    await input(42, { kind: 'key', key: 'F1' });
    assert.equal(legacyCalls.length, 2, 'fallback permanece estavel apos a falha de spawn');
  } finally {
    input.close();
  }
});

test('legacy mode remains the default when execFile is injected', async () => {
  let calls = 0;
  const input = createCombatInput({ execFile: (_exe, _args, _options, callback) => {
    calls++;
    callback(Error('exit 1'), JSON.stringify({ success: false, pid: 42, eventsSent: 0,
      error: 'rejeitado', transport: 'PostMessageW', effectVerified: false }));
  } });
  await assert.rejects(input(42, { kind: 'key', key: 'F1' }), error => error.retrySafe === false);
  assert.equal(calls, 1);
  assert.equal(input.mode(), 'process');
});
