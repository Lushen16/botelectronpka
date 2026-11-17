'use strict';

/**
 * Avaliacao por TRANSICAO do DynamicLure contra o Shiba, em replay offline.
 *
 *   node tools/lure-transition-eval.cjs \
 *     --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl \
 *     [--tolerance 250] [--holdout 0.4]
 *
 * READ-ONLY. Nao toca no PID 17748, nos taps, nem no cliente.
 *
 * PRINCIPIO: `holding` do Shiba e' APENAS referencia de avaliacao. Nunca entra
 * como entrada do nosso controlador. As entradas sao so' o que existe no
 * instante da decisao:
 *     - kind5 com position/ownPokemon/creatures (recencia maxima N)
 *     - o proprio estado interno do lure (fase, tUltimaDecisao)
 *
 * Simulacao em tempo real: o lurer so' ve' o kind5 MAIS RECENTE publicado
 * ANTES do kind6 atual. Isso reproduz a condicao de operacao.
 *
 * ORDEM DAS FASES (medida no checkpoint adendo 14):
 *   travel = anda | arc/stationary/wait/observe = PULSE (agrupando/parado)
 *
 * TOLERANCIA: declarada ANTES de comparar (default 250 ms = ~1 publicacao
 * kind6). Serve para casar transicoes, nao para perdoar erro de estado.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'analysis', 'lure-stop-rule');
const { DynamicLure, LURE_PHASE } = require(path.join(ROOT, 'botfinal', 'engines', 'dynamic-lure.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const input = String(arg('--in', ''));
if (!input || !fs.existsSync(input)) { console.error('faltou --in <snapshot>'); process.exit(2); }
const TOLERANCE_MS = Number(arg('--tolerance', 250));
const HOLDOUT = Number(arg('--holdout', 0.4));   // fracao final dos episodios
const MAX_AGE_MS = 600;
const MAX_SAMPLE_AGE_MS = 1500;   // kind5 mais velho que isso nao serve

const PULSE = new Set(['arc', 'stationary', 'wait', 'observe']);
const isPulse = p => PULSE.has(String(p));
/** Agrupa a fase do Shiba em TRAVEL / PULSE para comparacao de estado. */
const shibaBucket = p => (isPulse(p) ? 'PULSE' : (p === 'travel' ? 'TRAVEL' : String(p)));

async function main() {
  // ── carga em uma passada
  const kind6 = [];      // frames de decisao
  const kind5 = [];      // amostras espaciais, em ordem de t
  let episode = -1, lastT = null, prevWasLure = false;

  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.includes('"kind":5')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o.d) continue;
      let t; try { t = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { continue; }
      if (!t.position || !Array.isArray(t.creatures)) continue;
      const own = Number.isFinite(t.ownSummonId)
        ? (t.creatures.find(c => c.id === t.ownSummonId) || null) : null;
      kind5.push({
        t: o.t,
        position: t.position,
        ownPokemon: own ? { id: own.id, pos: own.pos, healthPercent: own.healthPercent } : null,
        creatures: t.creatures,
      });
      continue;
    }
    if (!line.includes('"kind":6')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o.d) continue;
    let obj; try { obj = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { continue; }
    const lu = obj.luring || {};
    const isLure = lu.mode === 'dynamic' && obj.paused !== true;
    if (!isLure) { prevWasLure = false; lastT = null; continue; }

    const newEp = !prevWasLure || lastT == null || (o.t - lastT) > MAX_AGE_MS;
    if (newEp) episode++;
    prevWasLure = true; lastT = o.t;

    kind6.push({
      t: o.t,
      episode,
      firstOfEpisode: newEp,
      shibaPhase: String(lu.phase || 'off'),
      shibaHolding: lu.holding === true ? true : lu.holding === false ? false : null,
      shibaCount: Number.isFinite(lu.count) ? lu.count : null,
      shibaMin: Number.isFinite(lu.minCount) ? lu.minCount : null,
    });
  }

  // ── config do Shiba (medida em analysis/kind11-start-target.json)
  const CONFIG = {
    luring: { enabled: true, frontEnabled: true, maxDistance: 3,
      frontRegroupMargin: 5, frontRegroupSteps: 3 },
    hoenn: { minWildsToEngage: 8, bestTileRange: 4,
      perfectLureTimeoutMs: 10000, perfectLureMinHp: 30 },
  };

  /** kind5 mais recente ANTES de t (estritamente). */
  let k5i = -1;
  function sampleBefore(t) {
    while (k5i + 1 < kind5.length && kind5[k5i + 1].t < t) k5i++;
    if (k5i < 0) return null;
    const s = kind5[k5i];
    if (t - s.t > MAX_SAMPLE_AGE_MS) return null;   // amostra velha demais
    return s;
  }

  // ── reproduz o 97,9%: acordo de ESTADO (TRAVEL vs PULSE)
  const lure = new DynamicLure(CONFIG);
  const stateRows = [];
  k5i = -1;
  for (const f of kind6) {
    const s = sampleBefore(f.t);
    if (!s) continue;   // sem telemetria: nao comparavel
    const dec = lure.decide(s, { now: f.t });
    stateRows.push({
      t: f.t, episode: f.episode,
      ours: dec.phase,
      theirs: shibaBucket(f.shibaPhase),
      oursBucket: isPulse(dec.phase) ? 'PULSE' : (dec.phase === 'travel' ? 'TRAVEL' : dec.phase),
      boxed: dec.boxed,
      action: dec.action,
      reason: dec.reason,
      shibaPhase: f.shibaPhase,
      holding: f.shibaHolding,
      count: f.shibaCount, min: f.shibaMin,
      sampleAge: f.t - s.t,
    });
  }

  const stateAgree = stateRows.filter(r => r.oursBucket === r.theirs).length;
  const stateMatrix = {};
  for (const r of stateRows) {
    const k = `nosso=${r.oursBucket} shiba=${r.theirs}`;
    stateMatrix[k] = (stateMatrix[k] || 0) + 1;
  }

  // ── TRANSICOES: nosso sinal vs referencia
  //
  // Cada transicao do Shiba e' uma mudanca de bucket entre frames consecutivos
  // do MESMO episodio. Idem para o nosso. Casamento 1:1 por direcao, dentro de
  // TOLERANCE_MS, mesma episodio, sem reutilizar evento.
  function transitionsOf(rows, key) {
    const out = [];
    let prev = null;
    for (const r of rows) {
      if (prev && prev.episode === r.episode && prev[key] !== r[key]) {
        out.push({
          t: r.t, episode: r.episode,
          from: prev[key], to: r[key],
          dir: `${prev[key]}->${r[key]}`,
          row: r,
        });
      }
      prev = r;
    }
    return out;
  }

  const oursTr = transitionsOf(stateRows.map(r => ({ ...r, bucket: r.oursBucket })), 'bucket');
  const refTr = transitionsOf(stateRows.map(r => ({ ...r, bucket: r.theirs })), 'bucket');

  /** Casa 1:1 por direcao e episodio, dentro da tolerancia. */
  function match(ours, ref, tolMs) {
    const usedRef = new Set();
    const pairs = [];
    const missed = [];
    for (const o of ours) {
      let best = -1, bestDt = Infinity;
      for (let i = 0; i < ref.length; i++) {
        if (usedRef.has(i)) continue;
        const r = ref[i];
        if (r.episode !== o.episode) continue;
        if (r.dir !== o.dir) continue;
        const dt = Math.abs(r.t - o.t);
        if (dt <= tolMs && dt < bestDt) { best = i; bestDt = dt; }
      }
      if (best >= 0) { usedRef.add(best); pairs.push({ ours: o, ref: ref[best], dt: ref[best].t - o.t }); }
      else missed.push(o);
    }
    const extra = ref.filter((_, i) => !usedRef.has(i));
    return { pairs, missed, extra };
  }

  const m = match(oursTr, refTr, TOLERANCE_MS);
  const stopsRef = refTr.filter(x => x.to === 'PULSE');
  const resRef = refTr.filter(x => x.to === 'TRAVEL');
  const stopsOurs = oursTr.filter(x => x.to === 'PULSE');
  const resOurs = oursTr.filter(x => x.to === 'TRAVEL');
  const mStops = match(stopsOurs, stopsRef, TOLERANCE_MS);
  const mRes = match(resOurs, resRef, TOLERANCE_MS);

  // ── divergencias nao-casadas: padrao de erro
  const divergences = [];
  for (const o of m.missed) {
    const r = o.row;
    divergences.push({
      kind: 'nosso_sem_par', t: o.t, episode: o.episode, dir: o.dir,
      oursPhase: r.ours, shibaPhase: r.shibaPhase, boxed: r.boxed,
      holding: r.holding, count: r.count, min: r.min, reason: r.reason,
    });
  }
  for (const e of m.extra) {
    const r = e.row;
    divergences.push({
      kind: 'shiba_sem_par', t: e.t, episode: e.episode, dir: e.dir,
      oursPhase: r.ours, shibaPhase: r.shibaPhase, boxed: r.boxed,
      holding: r.holding, count: r.count, min: r.min, reason: r.reason,
    });
  }
  const patternCount = {};
  for (const d of divergences) {
    const k = `${d.kind} dir=${d.dir} nosso=${d.oursPhase} shiba=${d.shibaPhase}`;
    patternCount[k] = (patternCount[k] || 0) + 1;
  }

  // ── split descoberta/reserva por EPISODIO (inteiro)
  const episodes = [...new Set(stateRows.map(r => r.episode))].sort((a, b) => a - b);
  const cut = Math.floor(episodes.length * (1 - HOLDOUT));
  const discEps = new Set(episodes.slice(0, cut));
  const holdEps = new Set(episodes.slice(cut));
  const split = (rows, set) => rows.filter(r => set.has(r.episode));
  const discRows = split(stateRows, discEps);
  const holdRows = split(stateRows, holdEps);
  const rate = rows => rows.length
    ? Number((rows.filter(r => r.oursBucket === r.theirs).length / rows.length).toFixed(4)) : null;

  const report = {
    generatedAt: new Date().toISOString(),
    input: path.basename(input),
    toleranceMs: TOLERANCE_MS,
    holdoutFraction: HOLDOUT,
    sampled: {
      kind6InLure: kind6.length,
      kind5WithSpatial: kind5.length,
      comparableFrames: stateRows.length,
    },
    reproduction: {
      expected: '7.513/7.671 = 97,9% conforme CHECKPOINT adendo 14',
      got: `${stateAgree}/${stateRows.length} = ${(stateAgree / stateRows.length * 100).toFixed(1)}%`,
      reproduces: stateRows.length === 7671 && stateAgree === 7513,
      matrix: stateMatrix,
    },
    transitions: {
      reference: { total: refTr.length, stops: stopsRef.length, resumes: resRef.length },
      ours: { total: oursTr.length, stops: stopsOurs.length, resumes: resOurs.length },
      all: { pairs: m.pairs.length, missed: m.missed.length, extra: m.extra.length },
      stops: {
        pairs: mStops.pairs.length,
        missed: mStops.missed.length, extra: mStops.extra.length,
        dt: mStops.pairs.map(p => p.dt).sort((a, b) => a - b),
      },
      resumes: {
        pairs: mRes.pairs.length,
        missed: mRes.missed.length, extra: mRes.extra.length,
        dt: mRes.pairs.map(p => p.dt).sort((a, b) => a - b),
      },
    },
    episodeSplit: {
      episodes: episodes.length,
      discovery: { episodes: discEps.size, frames: discRows.length, agreement: rate(discRows) },
      holdout: { episodes: holdEps.size, frames: holdRows.length, agreement: rate(holdRows) },
    },
    divergencePatterns: patternCount,
    divergences: divergences.slice(0, 60),
  };

  fs.writeFileSync(path.join(OUTDIR, 'transition-eval.json'), JSON.stringify(report, null, 1));

  const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);

  console.log('=== AVALIACAO POR TRANSICAO — DynamicLure ===\n');
  if (stateRows.length === 0) {
    console.log('BLOQUEADO: nenhum frame comparavel.');
    console.log('  motivo: o snapshot tem kind6 de lure, mas kind5 com posicao');
    console.log('  praticamente nao existe (8 amostras em 1,4 s, fora da janela do lure).');
    console.log('  Sem telemetria espacial, o DynamicLure nao tem entrada.');
    console.log('  Ver analysis/lure-stop-rule/transition-eval.json\n');
  }
  console.log(`arquivo        : ${report.input}`);
  console.log(`kind6 em lure  : ${kind6.length}`);
  console.log(`kind5 espacial : ${kind5.length}`);
  console.log(`frames comparaveis: ${stateRows.length}\n`);

  console.log('--- REPRODUCAO DO 97,9%');
  console.log(`  esperado : 7.513/7.671 = 97,9%`);
  console.log(`  obtido   : ${report.reproduction.got}`);
  console.log(`  reproduz : ${report.reproduction.reproduces}`);
  console.log('  matriz de estado:');
  for (const [k, v] of Object.entries(stateMatrix).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(6)}  ${k}`);
  }

  console.log('\n--- TRANSICOES (tolerancia ' + TOLERANCE_MS + ' ms)');
  console.log(`  referencia : ${refTr.length} (paradas ${stopsRef.length}, retomadas ${resRef.length})`);
  console.log(`  nosso      : ${oursTr.length} (paradas ${stopsOurs.length}, retomadas ${resOurs.length})`);
  console.log(`  pareadas   : ${m.pairs.length}`);
  console.log(`  perdidas (nosso sinal sem par): ${m.missed.length}`);
  console.log(`  extras (referencia sem par)  : ${m.extra.length}`);
  console.log(`  PARADAS   : pares ${mStops.pairs.length} | perdidas ${mStops.missed.length} | extras ${mStops.extra.length}`);
  console.log(`  RETOMADAS : pares ${mRes.pairs.length} | perdidas ${mRes.missed.length} | extras ${mRes.extra.length}`);
  for (const [label, s] of [['paradas', report.transitions.stops], ['retomadas', report.transitions.resumes]]) {
    if (s.dt.length) {
      console.log(`  dt ${label}: mediana ${q(s.dt, 0.5)} ms, p90 ${q(s.dt, 0.9)} ms, min ${s.dt[0]}, max ${s.dt[s.dt.length - 1]}`);
    } else {
      console.log(`  dt ${label}: sem pares`);
    }
  }

  console.log('\n--- SPLIT POR EPISODIO');
  console.log(`  descoberta: ${discEps.size} episodios, ${discRows.length} frames, acordo ${(report.episodeSplit.discovery.agreement * 100).toFixed(1)}%`);
  console.log(`  reserva   : ${holdEps.size} episodios, ${holdRows.length} frames, acordo ${(report.episodeSplit.holdout.agreement * 100).toFixed(1)}%`);

  console.log('\n--- PADROES DE DIVERGENCIA (top 8)');
  for (const [k, v] of Object.entries(patternCount).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }
  console.log(`\nEscrito: analysis/lure-stop-rule/transition-eval.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
