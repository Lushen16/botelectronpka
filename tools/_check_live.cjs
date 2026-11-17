const fs = require('node:fs');
const readline = require('node:readline');

const f = process.argv[2];
const janelaMB = Number(process.argv[3] || 30);
const size = fs.statSync(f).size;
const start = Math.max(0, size - janelaMB * 1024 * 1024);

console.log(`lendo ultimos ${janelaMB} MB de ${(size / 1048576).toFixed(1)} MB`);

const rl = readline.createInterface({
  input: fs.createReadStream(f, { start }), crlfDelay: Infinity,
});

let k5 = 0, comPoke = 0, comSelv = 0, comTudo = 0, maxSelv = 0;
const tipos = {};
const dist = [];
let ultPos = null, ultLure = null, ultPhase = null, primeira = true;

rl.on('line', l => {
  if (primeira) { primeira = false; return; }  // linha parcial no inicio
  const km = l.match(/"kind":(\d+)/);
  const dm = l.match(/"d":"([0-9a-f]+)"/);
  if (!km || !dm) return;
  let j;
  try { j = JSON.parse(Buffer.from(dm[1], 'hex').toString('utf8')); } catch { return; }

  if (km[1] === '5') {
    k5++;
    if (j.position) ultPos = j;
    const c = Array.isArray(j.creatures) ? j.creatures : [];
    for (const x of c) tipos[x.type] = (tipos[x.type] || 0) + 1;
    const selv = c.filter(x => x.type === 1 && x.healthPercent > 0 && x.pos);
    const poke = c.find(x => x.type === 3 && x.pos);
    if (poke) comPoke++;
    if (selv.length) {
      comSelv++;
      if (selv.length > maxSelv) maxSelv = selv.length;
      if (poke) {
        comTudo++;
        const ds = selv.map(x => Math.max(Math.abs(poke.pos.x - x.pos.x), Math.abs(poke.pos.y - x.pos.y)));
        dist.push(Math.min(...ds));
      }
    }
  } else if (km[1] === '6') {
    if (j.luring) ultLure = j.luring;
    if (j.phase) ultPhase = j.phase;
  }
});

rl.on('close', () => {
  console.log(`\nkind5 : ${k5}`);
  console.log(`  com Pokemon  : ${comPoke}`);
  console.log(`  com SELVAGEM : ${comSelv}${comSelv ? '   <<< TEM COMBATE' : ''}`);
  console.log(`  com os dois  : ${comTudo}`);
  console.log(`  max selvagens: ${maxSelv}`);
  console.log(`  tipos        : ${JSON.stringify(tipos)}`);

  if (dist.length) {
    const s = [...dist].sort((a, b) => a - b);
    const q = p => s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
    console.log(`\n  DISTANCIA Pokemon -> selvagem mais proximo`);
    console.log(`    n=${s.length} min=${s[0]} p10=${q(0.1)} mediana=${q(0.5)} p90=${q(0.9)} max=${s[s.length - 1]}`);
  }

  if (ultPos) {
    console.log(`\n  ultima posicao : ${JSON.stringify(ultPos.position)}`);
    console.log(`  player         : ${JSON.stringify(ultPos.playerName)}`);
    console.log(`  pokemon        : ${JSON.stringify(ultPos.pokemonName)}`);
  }
  if (ultLure) console.log(`  lure           : ${JSON.stringify(ultLure)}`);
  if (ultPhase) console.log(`  phase          : ${JSON.stringify(ultPhase)}`);
});
