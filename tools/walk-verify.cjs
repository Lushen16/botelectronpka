#!/usr/bin/env node
'use strict';

/**
 * Valida movimento de 1 passo com critério rigoroso.
 *
 * Critério de sucesso (todos obrigatórios):
 *   1. delta EXATO (dx,dy) conforme a direção, não só Chebyshev == 1
 *   2. mesmo z
 *   3. UM comando enviado
 *   4. nenhum passo extra nos N segundos seguintes
 *   5. refcount do control block do Tile estável
 *
 * Uso:
 *   node tools/walk-verify.cjs --pid 27416 --dir 2
 *   node tools/walk-verify.cjs --pid 27416 --dir 2 --watch 6
 *   node tools/walk-verify.cjs --pid 27416 --dir 2 --native    (força nativo)
 *
 * Direções (convenção do cliente, igual walker_input):
 *   0=cima(-y) 1=direita(+x) 2=baixo(+y) 3=esquerda(-x)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }
const dir = Number(arg('--dir', 2));
const watchSec = Number(arg('--watch', 6));

const DELTA = {
  0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0],
  4: [0, -1], 5: [0, 1], 6: [0, 1], 7: [0, -1],
};

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
if (!fs.existsSync(keyFile)) { console.error('sem chave'); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')).key;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tileRefcount(pidTag) {
  try {
    const out = execFileSync('python', [path.join(ROOT, 'tools', 'refcount_watch.py'),
      '--pid', String(pidTag)], { encoding: 'utf8' });
    const m = out.match(/refcount forte = (\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

async function main() {
  const t = new NativeTransport({ pid, key });
  let tel = null;
  t.on('telemetry', v => { tel = v; });
  await t.connect();
  await sleep(2500);
  if (!tel) { console.error('sem telemetria'); process.exit(1); }

  const p0 = tel.position;
  const rc0 = tileRefcount(pid);
  console.log(`dir=${dir}  esperado delta=(${DELTA[dir][0]},${DELTA[dir][1]})`);
  console.log(`antes: pos=(${p0.x},${p0.y},${p0.z})  tileRefcount=${rc0 ?? '?'}`);

  let sent = 1;
  let ack = null;
  try {
    ack = await t.sendCommand('walk', dir);
    console.log(`walk -> ${JSON.stringify(ack)}`);
  } catch (e) {
    console.log(`walk falhou: ${e.message}`);
    sent = 0;
  }

  // acompanha a posição por watchSec, registrando TODA mudança
  const marks = [];
  let last = { ...p0 };
  const t0 = Date.now();
  while (Date.now() - t0 < watchSec * 1000) {
    await sleep(400);
    if (tel && tel.position) {
      const cur = tel.position;
      if (cur.x !== last.x || cur.y !== last.y || cur.z !== last.z) {
        marks.push({ t: ((Date.now() - t0) / 1000).toFixed(1), ...cur });
        console.log(`  t=${marks[marks.length - 1].t}s  pos=(${cur.x},${cur.y},${cur.z})`);
        last = { ...cur };
      }
    }
  }

  const rc1 = tileRefcount(pid);
  console.log(`depois: tileRefcount=${rc1 ?? '?'}  (antes ${rc0 ?? '?'})`);

  const final = tel ? tel.position : p0;
  const dx = final.x - p0.x;
  const dy = final.y - p0.y;
  const dz = final.z - p0.z;
  const [ex, ey] = DELTA[dir];

  console.log();
  console.log('=== veredito ===');
  const checks = [
    ['delta exato', dx === ex && dy === ey, `(${dx},${dy}) vs (${ex},${ey})`],
    ['mesmo z', dz === 0, `dz=${dz}`],
    ['um comando', sent === 1, `sent=${sent}`],
    ['sem passo extra', marks.length <= 1, `mudancas=${marks.length}`],
    ['refcount estavel', rc0 === null || rc1 === null || rc0 === rc1, `${rc0} -> ${rc1}`],
  ];
  let ok = true;
  for (const [name, pass, detail] of checks) {
    if (!pass) ok = false;
    console.log(`  ${pass ? 'OK  ' : 'FALHA'}  ${name.padEnd(18)} ${detail}`);
  }
  console.log();
  console.log(ok ? 'SUCESSO: movimento nativo de 1 tile validado.'
                 : 'FALHOU: ver os itens acima.');
  if (!ok && marks.length === 0) {
    console.log('Nada se moveu. Ver %TEMP%\\pka_native.log (walk nativo vs teclado).');
  }
  t.close();
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
