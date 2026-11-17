'use strict';

/**
 * Extrai o comportamento de COMBATE do Shiba a partir das capturas do tap.
 *
 *   node tools/analise_combate_shiba.cjs --tap native/pka_tap_17748.jsonl
 *   node tools/analise_combate_shiba.cjs --tap <arquivo> --max 800000
 *
 * POR QUE ESTE SCRIPT EXISTE
 *
 * Temos 6,7 GB de captura passiva do Shiba e nenhum numero sobre o combate.
 * As perguntas que decidem o nosso motor sao objetivas:
 *
 *   1. Que distancia o Shiba mantem entre o Pokemon e o monstro na lure?
 *   2. Quanto tempo ele espera em cada fase antes de soltar o combo?
 *   3. O Pokemon se move durante a lure, ou fica parado?
 *   4. Quando o `luring.holding` liga? (quando ele "segura" o Pokemon)
 *
 * O dado ja' esta' gravado. Este script so' cruza kind5 (posicoes) com
 * kind6 (fase da lure) e imprime mediana / p90 / distribuicao.
 *
 * FONTES E LIMITES (medidos em 2026-11-14)
 *
 *   kind5  traz `position` (jogador), `creatures[]` com `pos`, e o Pokemon
 *          em `creatures` com `type: 3`. NAO traz `ownPokemon` — a posicao do
 *          Pokemon tem que ser derivada de creatures[type=3].
 *   kind6  traz `luring.{phase,count,minCount,mode,holding,target}`,
 *          `hoennCounts`, `core.movementOwner`, `walkerIndex`.
 *
 *   A captura NAO tem video sincronizado, entao parada fisica e fluidez de
 *   caminhada continuam sem prova (ver analysis/lure-stop-rule/).
 *
 * O que este script NAO faz: nao prova que o nosso motor e' equivalente. Ele
 * produz a especificacao medida; a comparacao com o nosso e' trabalho depois.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

/* ─────────── argumentos ─────────── */

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const tapFile = arg('--tap');
if (!tapFile || !fs.existsSync(tapFile)) {
  console.error('uso: node tools/analise_combate_shiba.cjs --tap <arquivo.jsonl> [--max N]');
  if (tapFile) console.error('  arquivo nao encontrado: ' + tapFile);
  process.exit(2);
}
const maxLinhas = Number(arg('--max', 0)) || Infinity;

/* ─────────── estatistica ─────────── */

const media = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
function quantil(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)));
  return s[i];
}
const mediana = a => quantil(a, 0.5);
const p90 = a => quantil(a, 0.9);
const p10 = a => quantil(a, 0.1);
const f = v => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

/* ─────────── estado da analise ─────────── */

const FASE_LURE = ['off', 'travel', 'arc', 'stationary', 'wait', 'observe'];
const obs = {
  linhas: 0,
  kind5: 0, kind6: 0,
  k5comPos: 0, k5comPoke: 0, k5comSelvagem: 0,

  /* por fase da lure: distancias Pokemon<->selvagem mais proximo */
  distPorFase: Object.fromEntries(FASE_LURE.map(f => [f, []])),
  /* por fase: distancia jogador<->Pokemon */
  distPokeJogador: Object.fromEntries(FASE_LURE.map(f => [f, []])),
  /* por fase: duracao da fase em ms (transicoes) */
  durFase: {},
  /* por fase: count e minCount */
  countPorFase: Object.fromEntries(FASE_LURE.map(f => [f, []])),
  /* por fase: quantos selvagens dentro de 1..5 tiles DO POKEMON */
  boxPorFase: Object.fromEntries(FASE_LURE.map(f => [f, { 1: [], 2: [], 3: [], 4: [], 5: [] }])),
  /* o Pokemon se moveu entre frames da mesma fase? */
  pokeMoveu: Object.fromEntries(FASE_LURE.map(f => [f, { moveu: 0, parado: 0, saltos: [] }])),
  /* holding do Shiba vs distancia real */
  holding: { ligado: [], desligado: [] },
  /* sequencia de fases observada */
  transicoes: {},
  /* amostras de combo: quantas skills por ciclo */
  comboNativo: { usaSequencia: 0, semSequencia: 0 },
};

let faseAnterior = null;
let faseDesdeMs = null;
let pokeAnterior = null;
let ultimaFasePoke = null;

/* kind5 e kind6 chegam em streams separados; guardamos o ultimo kind5
 * conhecido para correlacionar com o kind6 que chega depois. */
let ultimoK5 = null;
let ultimoK5Ms = 0;
const JANELA_CORRELACAO_MS = 1500;

function processarK5(j) {
  obs.kind5++;
  if (!j.position) return;
  obs.k5comPos++;

  /* Pokemon = creature com type 3 (o summon). NAO existe ownPokemon no kind5
   * capturado do Shiba — medido em 472k frames. */
  const poke = (j.creatures || []).find(c => c && c.type === 3 && c.pos);
  if (!poke) return;
  obs.k5comPoke++;

  const selvagens = (j.creatures || []).filter(c => c && c.type === 1 && c.healthPercent > 0 && c.pos);
  if (!selvagens.length) return;
  obs.k5comSelvagem++;

  const distancia = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const dPoke = selvagens.map(c => distancia(poke.pos, c.pos));

  ultimoK5 = {
    ms: j.clockMs ?? null,
    posJogador: j.position,
    posPoke: poke.pos,
    pokeHp: poke.healthPercent,
    pokeNome: poke.name,
    distMin: Math.min(...dPoke),
    dPoke,
    selvagens: selvagens.length,
  };
  ultimoK5Ms = Date.now();
}

function processarK6(j) {
  obs.kind6++;
  const l = j.luring;
  if (!l) return;
  const fase = FASE_LURE.includes(l.phase) ? l.phase : null;
  if (!fase) return;

  /* duracao de fase */
  const ms = j.tick;
  if (fase !== faseAnterior) {
    if (faseAnterior !== null && faseDesdeMs !== null && Number.isFinite(ms)) {
      const dur = ms - faseDesdeMs;
      if (dur > 0 && dur < 120000) {
        (obs.durFase[faseAnterior] ||= []).push(dur);
      }
      const chave = `${faseAnterior}->${fase}`;
      obs.transicoes[chave] = (obs.transicoes[chave] || 0) + 1;
    }
    faseAnterior = fase;
    faseDesdeMs = Number.isFinite(ms) ? ms : null;
  }

  /* correlaciona com a ultima posicao conhecida */
  const k5 = ultimoK5;
  if (!k5) return;

  obs.distPorFase[fase].push(k5.distMin);
  obs.distPokeJogador[fase].push(
    Math.max(Math.abs(k5.posJogador.x - k5.posPoke.x), Math.abs(k5.posJogador.y - k5.posPoke.y)));

  if (Number.isFinite(l.count)) (obs.countPorFase[fase] ||= []).push(l.count);

  /* box: quantos selvagens dentro de N tiles do Pokemon */
  for (const raio of [1, 2, 3, 4, 5]) {
    const dentro = k5.dPoke.filter(d => d <= raio).length;
    (obs.boxPorFase[fase][raio] ||= []).push(dentro);
  }

  /* o Pokemon se moveu desde a amostra anterior desta fase? */
  if (ultimaFasePoke === fase && pokeAnterior) {
    const d = Math.max(
      Math.abs(k5.posPoke.x - pokeAnterior.x),
      Math.abs(k5.posPoke.y - pokeAnterior.y));
    const slot = obs.pokeMoveu[fase];
    if (d > 0) { slot.moveu++; slot.saltos.push(d); } else slot.parado++;
  }
  pokeAnterior = { ...k5.posPoke };
  ultimaFasePoke = fase;

  /* holding */
  if (l.holding === true) obs.holding.ligado.push(k5.distMin);
  else if (l.holding === false) obs.holding.desligado.push(k5.distMin);
}

function processarK9ouCombo(j) {
  /* kind 9 e' manual (o Shiba nao usa); kind 6/7 pelo pipe sao texto.
   * Aqui so' registramos se a config de combo tinha sequencia. */
  if (!j) return;
}

/* ─────────── varredura ─────────── */

async function varrer() {
  const rl = readline.createInterface({
    input: fs.createReadStream(tapFile, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });

  for await (const linha of rl) {
    obs.linhas++;
    if (obs.linhas > maxLinhas) break;

    /* filtro rapido antes do JSON.parse: o arquivo tem 2,6 GB */
    if (!linha.includes('"kind":5,') && !linha.includes('"kind":6,')) continue;

    const mKind = linha.match(/"kind":(\d+)/);
    if (!mKind) continue;
    const kind = mKind[1];
    if (kind !== '5' && kind !== '6') continue;

    const mData = linha.match(/"d":"([0-9a-f]+)"/);
    if (!mData) continue;

    let j;
    try {
      j = JSON.parse(Buffer.from(mData[1], 'hex').toString('utf8'));
    } catch { continue; }

    if (kind === '5') processarK5(j);
    else processarK6(j);

    if (obs.linhas % 200000 === 0) {
      process.stderr.write(`  ${obs.linhas} linhas... (k5 ${obs.kind5}, k6 ${obs.kind6})\n`);
    }
  }
}

/* ─────────── relatorio ─────────── */

function relatorio() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' COMBATE DO SHIBA — medido das capturas do tap');
  console.log(' arquivo: ' + path.basename(tapFile));
  console.log('══════════════════════════════════════════════════════════\n');

  console.log('AMOSTRAS');
  console.log(`  linhas lidas       ${obs.linhas}`);
  console.log(`  kind5 (telemetria) ${obs.kind5}`);
  console.log(`  kind6 (automacao)  ${obs.kind6}`);
  console.log(`  k5 com position    ${obs.k5comPos}`);
  console.log(`  k5 com Pokemon     ${obs.k5comPoke}   (creature type=3)`);
  console.log(`  k5 com selvagem    ${obs.k5comSelvagem}`);
  if (!obs.k5comPoke) {
    console.log('\n  SEM amostra com Pokemon + selvagem: nao da para medir distancia.');
    return;
  }

  console.log('\n── DISTANCIA Pokemon → selvagem mais proximo (Chebyshev) ──\n');
  console.log('  fase          n      min   p10  mediana  p90   max');
  for (const fase of FASE_LURE) {
    const a = obs.distPorFase[fase];
    if (!a.length) continue;
    console.log(`  ${fase.padEnd(12)} ${String(a.length).padStart(6)}  ` +
      `${String(Math.min(...a)).padStart(4)}  ${String(f(p10(a))).padStart(4)}  ` +
      `${String(f(mediana(a))).padStart(7)}  ${String(f(p90(a))).padStart(4)}  ` +
      `${String(Math.max(...a)).padStart(4)}`);
  }

  console.log('\n── DISTANCIA jogador → Pokemon ──\n');
  console.log('  fase          n    mediana  p90');
  for (const fase of FASE_LURE) {
    const a = obs.distPokeJogador[fase];
    if (!a.length) continue;
    console.log(`  ${fase.padEnd(12)} ${String(a.length).padStart(6)}   ` +
      `${String(f(mediana(a))).padStart(7)}  ${String(f(p90(a))).padStart(4)}`);
  }

  console.log('\n── DURACAO DE CADA FASE (ms) ──\n');
  console.log('  fase          n    mediana    p90    max');
  for (const fase of FASE_LURE) {
    const a = obs.durFase[fase] || [];
    if (!a.length) continue;
    console.log(`  ${fase.padEnd(12)} ${String(a.length).padStart(6)}   ` +
      `${String(f(mediana(a))).padStart(7)}  ${String(f(p90(a))).padStart(6)}  ` +
      `${String(Math.max(...a)).padStart(6)}`);
  }

  console.log('\n── BOX: selvagens ate N tiles DO POKEMON (mediana por fase) ──\n');
  console.log('  fase          n      1t   2t   3t   4t   5t');
  for (const fase of FASE_LURE) {
    const fonte = obs.boxPorFase[fase];
    if (!fonte || !fonte[3] || !fonte[3].length) continue;
    const n = fonte[3].length;
    const cols = [1, 2, 3, 4, 5].map(r => String(f(mediana(obs.boxPorFase[fase][r] || []))).padStart(4));
    console.log(`  ${fase.padEnd(12)} ${String(n).padStart(6)}  ${cols.join('  ')}`);
  }

  console.log('\n── O POKEMON SE MOVE DURANTE A LURE? ──\n');
  console.log('  fase          parado   moveu   mediana do salto (tiles)');
  for (const fase of FASE_LURE) {
    const s = obs.pokeMoveu[fase];
    if (!s || (!s.moveu && !s.parado)) continue;
    const total = s.moveu + s.parado;
    const pct = total ? ((s.parado / total) * 100).toFixed(0) : '0';
    console.log(`  ${fase.padEnd(12)} ${String(s.parado).padStart(6)} (${pct}%) ${String(s.moveu).padStart(6)}   ` +
      `${String(f(mediana(s.saltos))).padStart(6)}`);
  }

  console.log('\n── holding (o Shiba "segura" o Pokemon?) ──\n');
  const hOn = obs.holding.ligado, hOff = obs.holding.desligado;
  console.log(`  holding=true   n=${hOn.length}` + (hOn.length ? `  dist mediana=${f(mediana(hOn))}  p90=${f(p90(hOn))}` : ''));
  console.log(`  holding=false  n=${hOff.length}` + (hOff.length ? `  dist mediana=${f(mediana(hOff))}  p90=${f(p90(hOff))}` : ''));

  console.log('\n── TRANSICOES DE FASE MAIS COMUNS ──\n');
  const trans = Object.entries(obs.transicoes).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!trans.length) console.log('  (nenhuma transicao — captura sem lure ativa?)');
  for (const [chave, n] of trans) console.log(`  ${chave.padEnd(28)} ${n}`);

  console.log('\n── O QUE ISSO PERMITE CONCLUIR ──');
  console.log('  Distancia mantida, tempo de espera por fase e movimento do Pokemon');
  console.log('  sao medidos acima. Parada fisica e fluidez de caminhada NAO:');
  console.log('  nao ha video sincronizado (analysis/lure-stop-rule/).');
  console.log('');
}

(async () => {
  await varrer();
  relatorio();
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
