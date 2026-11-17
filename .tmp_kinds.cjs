'use strict';
const fs = require('fs');
const rl = require('readline');
const r = rl.createInterface({ input: fs.createReadStream(process.argv[2]) });
const c = {}; const samples = {};
r.on('line', l => {
  let o; try { o = JSON.parse(l); } catch { return; }
  if (o.dir !== 'c2s') return;
  const k = o.kind; c[k] = (c[k] || 0) + 1;
  if (!samples[k]) samples[k] = [];
  if (samples[k].length < 3) samples[k].push(Buffer.from(o.d, 'hex').toString('hex'));
});
r.on('close', () => {
  console.log(JSON.stringify(c));
  for (const k of Object.keys(samples)) console.log('kind', k, samples[k].join(' | '));
});
