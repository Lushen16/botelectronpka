const fs = require('node:fs');
const readline = require('node:readline');
const f = process.argv[2];
const size = fs.statSync(f).size;
const inicio = Math.max(0, size - 25 * 1024 * 1024);
const rl = readline.createInterface({ input: fs.createReadStream(f, { start: inicio }), crlfDelay: Infinity });
let k5 = 0, comPoke = 0, comSelv = 0, maxSelv = 0, primeira = true;
const tipos = {};
const dist = [];
rl.on('line', l => {
  if (primeira) { primeira = false; return; }
  if (!l.includes('"kind":5,')) return;
  const m = l.match(/"d":"([0-9a-f]+)"/);
  if (!m) return;
  let j;
  try { j = JSON.parse(Buffer.from(m[1], 'hex').toString('utf8')); } catch { return; }
  k5++;
  const c = Array.isArray(j.creatures) ? j.creatures : [];
  for (const x of c) tipos[x.type] = (tipos[x.type] || 0) + 1;
  const selv = c.filter(x => x.type === 1 && x.healthPercent > 0 && x.pos);
  const poke = c.find(x => x.type === 3 && x.pos);
  if (poke) comPoke++;
  if (selv.length) {
    comSelv++;
    if (selv.length > maxSelv) maxSelv = selv.length;
    if (poke) {
      const ds = selv.map(x => Math.max(Math.abs(poke.pos.x - x.pos.x), Math.abs(poke.pos.y - x.pos.y)));
      dist.push(Math.min(...ds));
    }
  }
});
rl.on('close', () => {
  console.log('  kind5 no tail :', k5);
  console.log('  com Pokemon   :', comPoke);
  console.log('  com SELVAGEM  :', comSelv, comSelv ? '<<< TEM COMBATE' : '(nenhum)');
  console.log('  max selvagens :', maxSelv);
  console.log('  tipos         :', JSON.stringify(tipos));
  if (dist.length) {
    const s = [...dist].sort((a, b) => a - b);
    console.log('  dist poke->selvagem: mediana=' + s[Math.floor(s.length / 2)] + ' min=' + s[0] + ' max=' + s[s.length - 1]);
  }
});
