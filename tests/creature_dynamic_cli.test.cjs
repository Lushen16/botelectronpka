'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('CLI creature scanner uses relocated module and player identity', context => {
  if (process.platform !== 'win32') return context.skip('Windows RPM');
  const result = spawnSync(process.env.PKA_PYTHON || 'python', ['-B', 'tests/creature_dynamic_cli_checks.py'],
    { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
