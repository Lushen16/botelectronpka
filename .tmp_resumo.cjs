'use strict';
/* Resumo compacto de uma captura do tap: janela de tempo, taxa de frames
 * kind 5 e cadencia de mudanca de tile. Nao imprime payload nenhum. */
const fs = require('fs');
const rl = require('readline');
const file = process.argv[2];
let maxT = 0, n = 0, withPos = 0, last5 = 0, deltas = [], lastPos = null, changes = [];
const r = rl.createInterface({ input: fs.createReadStream(file) });
r.on('line', l => {
  let o; try { o = JSON.parse(l); } catch { return; }
  n += 1; if (o.t > maxT) maxT = o.t;
  if (o.kind !== 5 || o.dir !== 's2c') return;
  if (last5) deltas.push(o.t - last5); last5 = o.t;
  let t; try { t = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { return; }
  const p = t.position; if (!p) return;
  withPos += 1;
  const k = p.x + ',' + p.y + ',' + p.z;
  if (lastPos && lastPos.k !== k) changes.push(o.t - lastPos.t);
  if (!lastPos || lastPos.k !== k) lastPos = { k, t: o.t };
});
r.on('close', () => {
  const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  console.log(JSON.stringify({ frames: n, maxT, kind5: deltas.length + (last5 ? 1 : 0), withPos,
    pollMedianaMs: med(deltas), mudancas: changes.length, intervaloMedianoMs: med(changes),
    intervalos: changes.slice(-20) }));
});
