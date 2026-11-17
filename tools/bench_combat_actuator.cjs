'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCombatInput } = require('../reconstruction/keyboard-combat.cjs');

const PYTHON = process.env.PKA_PYTHON || 'python';
const ROOT = path.resolve(__dirname, '..');
const ITERATIONS = Math.max(5, Number(process.env.BENCH_ITERATIONS) || 25);
const WARMUP = 3;
const DEAD_PID = 2147483640;

function stats(samples) {
  const ordered = [...samples].sort((a, b) => a - b);
  const round = value => Math.round(value * 1000) / 1000;
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  return {
    mean: round(mean),
    p50: round(ordered[Math.floor(ordered.length / 2)]),
    p99: round(ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * 0.99))]),
    min: round(ordered[0]),
    max: round(ordered[ordered.length - 1]),
  };
}

async function measure(label, input, request, iterations) {
  for (let index = 0; index < WARMUP; index++) {
    await input(DEAD_PID, request).catch(() => {});
  }
  const samples = [];
  for (let index = 0; index < iterations; index++) {
    const started = process.hrtime.bigint();
    await input(DEAD_PID, request).catch(() => {});
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { label, samples, stats: stats(samples) };
}

async function main() {
  const request = { kind: 'key', key: 'F1' };
  const legacy = createCombatInput({ daemon: false });
  const daemon = createCombatInput();
  const before = await measure('processo por comando', legacy, request, ITERATIONS);
  const coldStart = process.hrtime.bigint();
  await daemon(DEAD_PID, request).catch(() => {});
  const cold = Math.round(Number(process.hrtime.bigint() - coldStart) / 1e4) / 100;
  await daemon.prewarm();
  const after = await measure('canal residente', daemon, request, ITERATIONS);

  const dispatch = spawnSync(PYTHON, ['-B', path.join(__dirname, 'bench_combat_dispatch.py'), '1500'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const micro = dispatch.status === 0 ? JSON.parse(dispatch.stdout) : null;

  const speedup = after.stats.mean > 0 ? before.stats.mean / after.stats.mean : null;
  const report = {
    iterations: ITERATIONS,
    note: 'PID inexistente: mede o custo fixo de cada comando (spawn do interpretador, '
      + 'import, validacao de processo e enumeracao de janelas). O dispatch Win32 real e medido '
      + 'separadamente com Win32 simulado.',
    before: before.stats,
    after: after.stats,
    daemonFirstCommand: cold,
    speedup: speedup ? Math.round(speedup * 10) / 10 : null,
    micro,
  };
  if (daemon.close) daemon.close();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
    process.exit(1);
  });
}

module.exports = { main };
