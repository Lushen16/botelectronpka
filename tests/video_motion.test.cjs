'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('offline video motion contracts and FFmpeg integration', () => {
  const result = spawnSync(process.env.PYTHON || 'python', [path.join(__dirname, 'video_motion_checks.py')], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 120000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
