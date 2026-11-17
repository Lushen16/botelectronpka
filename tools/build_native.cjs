#!/usr/bin/env node
'use strict';

/**
 * Compila a DLL nativa, o injetor e o host de prova.
 *
 *   node tools/build_native.cjs              tudo
 *   node tools/build_native.cjs --only tap   so pka_tap.dll (modulo de captura)
 *   node tools/build_native.cjs --only bot   so pka_native.dll + injetor + host
 *
 * --only existe para os dois agentes nao brigarem pelo mesmo arquivo: quem
 * builda o tap nao reescreve pka_native.dll (que pode estar carregada no jogo,
 * o que da "Permission denied" no lld-link).
 *
 * Toolchain: zig cc (clang 21) target x86_64-windows-gnu. Sem MSVC.
 * Instalar: python -m pip install ziglang
 *
 * Saidas em native/:
 *   pka_native.dll    servidor do canal (injetar no jogo)   [bot]
 *   pka_tap.dll       espião passivo do pipe                [captura]
 *   pka_inject.exe    injetor CreateRemoteThread + LoadLibraryW
 *   pka_host.exe      carrega a DLL fora do jogo (prova de handshake)
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
  } catch { /* cai para o PATH */ }
  return 'zig';
}

function run(zig, args) {
  try {
    execFileSync(zig, args, { stdio: 'pipe', encoding: 'utf8' });
    return null;
  } catch (error) {
    const text = (error.stdout || '') + (error.stderr || '') + (error.message || '');
    const errors = text.split(/\r?\n/).filter(line => /error:/i.test(line));
    return errors.length ? errors.join('\n') : text.slice(0, 2000);
  }
}

function main() {
  const zig = findZig();
  console.log('zig: ' + zig);
  const version = run(zig, ['version']);
  if (version) {
    console.error('zig indisponivel. instale: python -m pip install ziglang');
    process.exit(1);
  }
  console.log('zig ok');

  const target = ['-target', 'x86_64-windows-gnu', '-O2'];
  const jobs = [
    { group: 'bot', name: 'pka_native.dll', src: 'pka_native.c', out: 'pka_native.dll',
      extra: ['-shared', '-lbcrypt'] },
    { group: 'tap', name: 'pka_tap.dll', src: 'pka_tap.c', out: 'pka_tap.dll',
      extra: ['-shared'] },
    { group: 'bot', name: 'pka_inject.exe', src: 'pka_inject.c', out: 'pka_inject.exe', extra: [] },
    { group: 'bot', name: 'pka_uninject.exe', src: 'pka_uninject.c', out: 'pka_uninject.exe', extra: [] },
    { group: 'bot', name: 'pka_host.exe', src: 'pka_native_host.c', out: 'pka_host.exe', extra: [] },
    { group: 'bot', name: 'pka_window_target.exe', src: 'pka_window_target.c', out: 'pka_window_target.exe', extra: ['-lgdi32', '-luser32'] },
  ];

  const only = (() => {
    const index = process.argv.indexOf('--only');
    return index >= 0 ? process.argv[index + 1] : null;
  })();
  if (only && !['tap', 'bot'].includes(only)) {
    console.error('--only aceita "tap" ou "bot"');
    process.exit(2);
  }
  if (only) console.log('grupo: ' + only + ' (os outros nao sao tocados)');

  let failed = 0;
  for (const job of jobs) {
    if (only && job.group !== only) continue;
    const src = path.join(dir, job.src);
    if (!fs.existsSync(src)) { console.log('SKIP ' + job.name + ' (fonte ausente)'); continue; }
    const out = path.join(dir, job.out);
    let error = run(zig, ['cc', ...target, '-o', out, src, ...job.extra]);

    /* Windows trava o arquivo enquanto ele esta mapeado num processo. Se o jogo
     * estiver aberto com o tap carregado, sobrescrever native\pka_tap.dll da
     * "Permission denied" no lld-link. Em vez de falhar, compila ao lado com
     * sufixo _new; as ferramentas escolhem a DLL mais nova automaticamente. */
    if (error && /Permission denied|permiss/i.test(error + out)) {
      const alt = out.replace(/\.dll$/, '_new.dll');
      const retry = run(zig, ['cc', ...target, '-o', alt, src, ...job.extra]);
      if (!retry) {
        console.log('BUSY ' + job.name + ' (travada por processo) -> ' +
          path.basename(alt) + ' (' + fs.statSync(alt).size + ' bytes)');
        job.written = alt;
        continue;
      }
      error = retry;
    }

    if (error) {
      failed++;
      console.log('FAIL ' + job.name + '\n' + error);
    } else {
      job.written = out;
      console.log('OK   ' + job.name + ' (' + fs.statSync(out).size + ' bytes)');
    }
  }

  if (failed) process.exit(1);
  if (!only || only === 'tap') {
    console.log('\ntap:  node tools/tap_test.cjs     (prova do espiao)');
    console.log('      node tools/tap_session.cjs --inject');
  }
  if (!only || only === 'bot') {
    console.log('\nbot:  node tools/native_e2e.cjs          (handshake contra o cliente real)');
    console.log('      node tools/native_inject_test.cjs    (injetar num alvo controlado)');
  }
}

main();
