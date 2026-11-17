const fs = require('fs');

// We can require the test file after injecting our console.log
let testSrc = fs.readFileSync('tests/rpm_combat_runtime.test.cjs', 'utf8');

// Replace line 34 to log the result before assert
testSrc = testSrc.replace(
  "assert.equal((await value.runtime.tick()).action, 'attack');",
  "const t1 = await value.runtime.tick(); console.log('DEBUG TICK 1:', t1); console.log('TELEMETRY:', JSON.stringify(value.telemetry, null, 2)); assert.equal(t1.action, 'attack');"
);

fs.writeFileSync('tests/rpm_combat_runtime_debug.test.cjs', testSrc, 'utf8');
const { spawnSync } = require('child_process');
const res = spawnSync('node', ['--test', '--test-name-pattern=RPM pipeline waits for combat', 'tests/rpm_combat_runtime_debug.test.cjs'], { encoding: 'utf8' });
console.log(res.stdout);
console.log(res.stderr);
fs.unlinkSync('tests/rpm_combat_runtime_debug.test.cjs');
