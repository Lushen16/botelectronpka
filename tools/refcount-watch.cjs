#!/usr/bin/env node
'use strict';

/**
 * Mede o vazamento de refcount do shared_ptr antes de qualquer ataque.
 *
 * POR QUE: o handler de attack DESTROI o shared_ptr recebido (chama o
 * destrutor em exe+0x784be0+0x1ab). Se o chamador tambem decrementar, o
 * balanco e' -1 por chamada e o control block do Tile do LocalPlayer acaba
 * liberado -> o cliente morre minutos depois, sem log.
 *
 * Este script le' o refcount e observa:
 *   - sem attack:        tem que ficar ESTAVEL
 *   - apos 1 attack:     tem que ficar IGUAL (++ paga o -- do handler)
 *   - se CAIR:          o vazamento continua -> NAO atacar mais
 *
 * Le por RPM externo (nao depende da DLL), entao funciona mesmo com a DLL
 * em estado ruim.
 *
 * Uso:
 *   python tools/refcount-watch.py --pid 15264
 *   python tools/refcount-watch.py --pid 15264 --watch 30
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const script = path.join(ROOT, 'tools', 'refcount_watch.py');

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }

const args = [script, '--pid', String(pid)];
const watch = arg('--watch', null);
if (watch) args.push('--watch', String(watch));

try {
  const out = execFileSync('python', args, { encoding: 'utf8' });
  process.stdout.write(out);
} catch (e) {
  if (e.stdout) process.stdout.write(e.stdout);
  if (e.stderr) process.stderr.write(e.stderr);
  process.exit(e.status || 1);
}
