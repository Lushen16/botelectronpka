#!/usr/bin/env node
'use strict';

/**
 * Compila o tracer de walktrace e o alvo/host de teste auxiliar.
 * Nao toca em pka_native.dll nem pka_tap.dll.
 *
 *   node tools/build_walktrace.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'native');

function findZig() {
  if (process.env.PKA_ZIG && fs.existsSync(process.env.PKA_ZIG)) return process.env.PKA_ZIG;
  try {
    const out = execFileSync('python', ['-c',
      'import ziglang,os;print(os.path.join(os.path.dirname(ziglang.__file__),"zig.exe"))'],
      { encoding: 'utf8' }).trim();
    if (out && fs.existsSync(out)) return out;
  } catch { /* PATH */ }
  return 'zig';
}

const zig = findZig();
const log = [];
let failed = 0;

function build(name, args) {
  try {
    execFileSync(zig, args, { stdio: 'pipe', encoding: 'utf8', cwd: root });
    log.push('ok    ' + name);
    return true;
  } catch (error) {
    const text = (error.stdout || '') + (error.stderr || '') + (error.message || '');
    const errors = text.split(/\r?\n/).filter(l => /error:/i.test(l));
    log.push('FAIL  ' + name + '\n      ' + (errors.length ? errors.join('\n      ')
      : text.slice(0, 3000)));
    failed += 1;
    return false;
  }
}

const target = ['cc', '-target', 'x86_64-windows-gnu', '-O2'];
const obj = path.join(dir, 'build');
fs.mkdirSync(obj, { recursive: true });

/* DLL do tracer */
build('pka_walktrace.dll', [...target, '-shared',
  '-o', path.join(dir, 'pka_walktrace.dll'),
  path.join(dir, 'pka_walktrace.c'),
  '-lpsapi']);

/* alvo auxiliar simples */
build('walktrace_target.exe', [...target,
  '-o', path.join(dir, 'walktrace_target.exe'),
  path.join(dir, 'walktrace_target.c')]);

/* host que dirige o ciclo de vida no mesmo processo */
build('walktrace_host.exe', [...target,
  '-o', path.join(dir, 'walktrace_host.exe'),
  path.join(dir, 'walktrace_host.c')]);

/* injetor PROPRIO do tracer (nao mexe em pka_inject.c, que e compartilhado) */
build('walktrace_inject.exe', [...target,
  '-o', path.join(dir, 'walktrace_inject.exe'),
  path.join(dir, 'walktrace_inject.c')]);

console.log(log.join('\n'));
const outFile = path.join(root, 'validation-logs', 'walktrace_build.txt');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, [
  'zig: ' + zig,
  'zig version: ' + (() => { try { return execFileSync(zig, ['version'], { encoding: 'utf8' }).trim(); } catch { return '?'; } })(),
  '',
  log.join('\n'),
  ''
].join('\n'), 'utf8');

process.exit(failed ? 1 : 0);
