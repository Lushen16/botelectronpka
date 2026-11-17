'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('creature scanner resolves session RTTI and rejects invalid control blocks', t => {
  if (process.platform !== 'win32') { t.skip('Windows RPM scanner'); return; }
  const root = path.resolve(__dirname, '..');
  const result = spawnSync('python', ['-B', 'tests/creature_scanner_session_checks.py'],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, /Ran 7 tests/u);
});
