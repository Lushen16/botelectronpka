'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('Win32 discovery binds once and falls back without weakening PID identity', context => {
  if (process.platform !== 'win32') return context.skip('Win32 ctypes');
  const result = spawnSync(process.env.PKA_PYTHON || 'python', ['-B', 'tests/win32_discovery_checks.py'],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('real resident protocol survives malformed input and responds to multiple probes without input', context => {
  if (process.platform !== 'win32') return context.skip('Win32 ctypes');
  const commands = ['{', JSON.stringify({ id: 1, op: 'ping' }),
    JSON.stringify({ id: 2, pid: 0, request: { kind: 'probe' } }),
    JSON.stringify({ id: 3, op: 'ping' })].join('\n') + '\n';
  const result = spawnSync(process.env.PKA_PYTHON || 'python', ['-B', 'tools/combat_actuator.py', '--serve'],
    { cwd: root, input: commands, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(records.length, 4);
  assert.equal(records[0].success, false);
  assert.equal(records[1].success, true);
  assert.equal(records[2].success, false);
  assert.equal(records[3].success, true);
  assert.equal(records[3].commands, 1);
  for (const record of records) assert.equal(record.eventsSent, 0);
});

function providerContext() {
  const children = [];
  const context = { process: { env: {} }, path, root, CREATURES_FILE: 'fixture.json',
    creatureProvider: null, creatureProviderAttempt: null, console: { error() {} },
    setTimeout,
    spawn: (python, args) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      children.push({ child, python, args });
      return child;
    } };
  const source = fs.readFileSync(path.join(root, 'reconstruction/app/main.cjs'), 'utf8');
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function startCreatureProvider('), source.indexOf('function startItemProvider(')), context);
  return { context, children };
}

test('scanner waits for a nonempty player and does not duplicate a live child', () => {
  const { context, children } = providerContext();
  for (const name of [undefined, '', '   ']) context.startCreatureProvider('python', 42, name);
  context.startCreatureProvider('python', 0, 'Ash');
  assert.equal(children.length, 0);
  context.startCreatureProvider('python', 42, ' Ash ');
  context.startCreatureProvider('python', 42, 'Ash');
  assert.equal(children.length, 1);
  const nameIndex = children[0].args.indexOf('--player-name');
  assert.equal(children[0].args[nameIndex + 1], 'Ash');
});

test('scanner spawn error releases ownership and an old exit cannot clear its replacement', () => {
  const { context, children } = providerContext();
  context.startCreatureProvider('python', 42, 'Ash');
  children[0].child.emit('error', Error('spawn failed'));
  assert.equal(context.creatureProvider, null);
  context.startCreatureProvider('python', 42, 'Ash');
  assert.equal(children.length, 2);
  children[0].child.emit('exit', 1);
  assert.equal(context.creatureProvider, children[1].child);
  children[1].child.emit('exit', 0);
  assert.equal(context.creatureProvider, null);
});

test('live provider starts creature discovery when the matching player arrives', () => {
  const source = fs.readFileSync(path.join(root, 'reconstruction/app/main.cjs'), 'utf8');
  const lines = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = {}; child.stderr = {};
  const calls = [];
  const context = { smoke: false, audit: false, liveProvider: null, livePid: null,
    PROVIDER: 'provider.py', root, process: { env: {} }, fs: { existsSync: () => true },
    providerOptions: () => ({ pid: 42, args: [] }), discoverProcesses: () => [], spawn: () => child,
    createInterface: ({ input }) => input === child.stdout ? lines : new EventEmitter(),
    startCreatureProvider: (...args) => calls.push(args), startItemProvider() {}, providerStatus() {} };
  vm.createContext(context);
  const start = source.indexOf('function startLiveProvider(');
  const end = source.indexOf('const roamingDir', start + 1);
  assert.ok(start >= 0 && end > start, 'slice markers not found');
  vm.runInContext(source.slice(start, end), context);
  context.startLiveProvider(); calls.length = 0;
  lines.emit('line', JSON.stringify({ ok: true, pid: 99, player: { name: 'Other' } }));
  assert.equal(calls.length, 0);
  lines.emit('line', JSON.stringify({ ok: true, pid: 42, player: { name: 'Nobutdopai' } }));
  assert.equal(calls[0][2], 'Nobutdopai');
});

test('creature reads hide transient Windows errors and never reuse an expired snapshot', () => {
  let now = 2000;
  let contents = JSON.stringify({ schema: 2, pid: 42, generatedAt: new Date(1900).toISOString(), creatures: [] });
  let failure = null;
  const context = { module: { exports: {} }, structuredClone, Buffer, __dirname: path.join(root, 'tools'),
    require: name => name === 'node:fs' ? {
      statSync: () => { if (failure) throw Object.assign(Error('private/path: locked'), { code: failure });
        return { isFile: () => true, size: Buffer.byteLength(contents) }; },
      readFileSync: () => contents,
    } : require(name.startsWith('.') ? path.resolve(root, 'tools', name) : name) };
  context.require.main = null;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'tools/creature_bridge.cjs'), 'utf8'), context);
  const source = context.module.exports.createCreatureSource('fixture.json', { now: () => now, maxAgeMs: 500 });
  const snapshot = source();
  for (const value of ['', '   ', '{']) {
    contents = value;
    assert.equal(source().generatedAt, snapshot.generatedAt);
  }
  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'ENOENT']) {
    failure = code;
    assert.equal(source().generatedAt, snapshot.generatedAt);
    now = 2501;
    assert.throws(source, error => error.code === 'CREATURE_STREAM_WAITING'
      && !error.message.includes('private/path'));
    now = 2000;
  }
  failure = null; contents = ''; now = 2501;
  assert.throws(source, error => error.code === 'CREATURE_STREAM_WAITING');
});
