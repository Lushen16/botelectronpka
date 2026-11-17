'use strict';

/**
 * Auditoria final do replay: reconcilia TODAS as series do snapshot congelado,
 * verifica a hipotese das 20 saidas ausentes evento a evento, corrige minCount,
 * mede duracao por timestamp com denominadores explicitos.
 *
 *   node tools/lure-audit-final.cjs \
 *     --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl
 *
 * READ-ONLY. Nao toca no processo do jogo, nao captura, nao injeta.
 *
 * DEFINICOES FIXAS (congeladas antes de medir):
 *   episodio  : mode=dynamic, !paused, corte quando gap entre publicacoes > 600 ms
 *   replay    : decide no frame N usando o kind6 do frame N-1 (nunca o atual)
 *   indeciso  : sem kind6 anterior no episodio, OU idade > 600 ms
 *   run       : sequencia contigua de holding=true DENTRO do mesmo episodio
 *   duracao   : t(primeiro false seguinte) - t(primeiro true)   [so' runs completos]
 *   inferior  : t(ultimo true) - t(primeiro true)               [todos os runs]
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'analysis', 'lure-stop-rule');
const MAX_AGE_MS = 600;

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const input = String(arg('--in', ''));
if (!input || !fs.existsSync(input)) { console.error('faltou --in <snapshot>'); process.exit(2); }

const STOP_PHASES = new Set(['arc', 'stationary', 'wait', 'observe']);
const isStopPhase = p => STOP_PHASES.has(String(p));

function quantiles(vals) {
  const v = vals.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const q = p => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null);
  return { n: v.length, min: v.length ? v[0] : null, median: q(0.5), p90: q(0.9), max: v.length ? v[v.length - 1] : null };
}

function correlation(pairs) {
  if (pairs.length < 3) return null;
  const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2;
  }
  return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
}

async function main() {
  // ── hash do snapshot (integridade do insumo)
  const stat = fs.statSync(input);
  const sha = crypto.createHash('sha256');
  await new Promise((res, rej) => {
    const s = fs.createReadStream(input);
    s.on('data', c => sha.update(c)); s.on('end', res); s.on('error', rej);
  });
  const sha256 = sha.digest('hex');

  // ── carga: todo kind6, marcando episodio
  const frames = [];
  let episode = -1;
  let lastT = null;
  let prevWasLure = false;

  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"kind":6')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o.d) continue;
    let obj; try { obj = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { continue; }
    const lu = obj.luring || {};
    const isLure = lu.mode === 'dynamic' && obj.paused !== true;

    if (!isLure) { prevWasLure = false; lastT = null; continue; }

    const newEpisode = !prevWasLure || lastT == null || (o.t - lastT) > MAX_AGE_MS;
    if (newEpisode) episode++;
    prevWasLure = true; lastT = o.t;

    frames.push({
      t: o.t,
      episode,
      holding: lu.holding === true ? true : lu.holding === false ? false : null,
      phase: String(lu.phase || 'off'),
      count: Number.isFinite(lu.count) ? lu.count : null,
      min: Number.isFinite(lu.minCount) ? lu.minCount : null,
      firstOfEpisode: newEpisode,
    });
  }

  const totalEpisodes = episode + 1;
  const totalFrames = frames.length;

  // ══════════════════════════════ PARTE 1: series e reconciliacao

  // Serie R — REPLAY: decisao usa o frame anterior; 1o frame do episodio = INDET
  const replay = { STOP: 0, MOVE: 0, INDET: 0, reasons: {} };
  const replaySeq = [];      // {t, episode, decision|null}
  let prevFrame = null;
  for (const f of frames) {
    if (f.firstOfEpisode || !prevFrame || prevFrame.episode !== f.episode) {
      replay.INDET++; replay.reasons['sem kind6 anterior no episodio']++;
      replaySeq.push({ t: f.t, episode: f.episode, decision: null });
    } else {
      const age = f.t - prevFrame.t;
      if (age < 0) { replay.INDET++; replay.reasons['kind6 posterior']++;
        replaySeq.push({ t: f.t, episode: f.episode, decision: null }); }
      else if (age > MAX_AGE_MS) { replay.INDET++; replay.reasons[`idade ${age}ms > ${MAX_AGE_MS}ms`]++;
        replaySeq.push({ t: f.t, episode: f.episode, decision: null }); }
      else if (prevFrame.holding === true) { replay.STOP++;
        replaySeq.push({ t: f.t, episode: f.episode, decision: 'STOP' }); }
      else if (prevFrame.holding === false) { replay.MOVE++;
        replaySeq.push({ t: f.t, episode: f.episode, decision: 'MOVE' }); }
      else { replay.INDET++; replay.reasons['holding ausente']++;
        replaySeq.push({ t: f.t, episode: f.episode, decision: null }); }
    }
    prevFrame = f;
  }
  // trocas do replay: entre decisoes validas consecutivas, mesma episodio
  let replayTransitions = 0, replayStopToMove = 0, replayMoveToStop = 0;
  const replayMissingEvents = [];   // transicoes observadas que o replay nao ve
  {
    let prev = null;
    for (const r of replaySeq) {
      if (r.decision == null) { prev = null; continue; }   // INDET quebra a sequencia
      if (prev && prev.decision !== r.decision) {
        replayTransitions++;
        if (prev.decision === 'STOP') replayStopToMove++; else replayMoveToStop++;
      }
      prev = r;
    }
  }

  // Serie H — HOLDING observado (o sinal bruto, sem defasagem)
  let holdTransitions = 0, holdStopToMove = 0, holdMoveToStop = 0;
  const holdEvents = [];      // eventos de transicao observada
  {
    let prev = null;
    for (const f of frames) {
      if (f.holding == null) { prev = null; continue; }
      if (prev && prev.episode === f.episode && prev.holding !== f.holding) {
        holdTransitions++;
        if (prev.holding === true) holdStopToMove++; else holdMoveToStop++;
        holdEvents.push({ t: f.t, episode: f.episode, from: prev.holding, to: f.holding,
          phaseFrom: prev.phase, phaseTo: f.phase,
          countFrom: prev.count, countTo: f.count, min: f.min,
          atEpisodeStart: f.firstOfEpisode });
      }
      prev = f;
    }
  }

  // Serie P — mudancas de PHASE
  let phaseChanges = 0, phaseToStop = 0, phaseFromStop = 0, phaseStopToStop = 0;
  const phaseEvents = [];
  {
    let prev = null;
    for (const f of frames) {
      if (prev && prev.episode === f.episode && prev.phase !== f.phase) {
        phaseChanges++;
        const a = isStopPhase(prev.phase), b = isStopPhase(f.phase);
        if (!a && b) phaseToStop++;
        else if (a && !b) phaseFromStop++;
        else if (a && b) phaseStopToStop++;
        phaseEvents.push({ t: f.t, episode: f.episode, from: prev.phase, to: f.phase,
          fromStop: a, toStop: b,
          countFrom: prev.count, countTo: f.count, min: f.min });
      }
      prev = f;
    }
  }

  // Serie R2 — RUNS de holding=true
  const runs = [];
  {
    let cur = null;
    for (const f of frames) {
      if (f.holding === true) {
        if (!cur || cur.episode !== f.episode) {
          if (cur) { cur.boundaryEnd = 'episodio'; runs.push(cur); }
          cur = { episode: f.episode, tFirst: f.t, tLast: f.t, samples: 1,
            startAtEpisodeStart: f.firstOfEpisode, countAtFirst: f.count,
            minAtFirst: f.min, boundaryEnd: null };
        } else { cur.tLast = f.t; cur.samples++; }
      } else if (f.holding === false) {
        if (cur && cur.episode === f.episode) { cur.tFalse = f.t; runs.push(cur); cur = null; }
        else if (cur) { cur.boundaryEnd = 'episodio'; runs.push(cur); cur = null; }
      }
      // holding ausente: nao fecha nem abre
    }
    if (cur) { cur.boundaryEnd = 'fim-do-log'; runs.push(cur); }
  }
  for (const r of runs) {
    r.complete = Number.isFinite(r.tFalse);
    r.observed = r.complete ? r.tFalse - r.tFirst : null;
    r.lowerBound = r.tLast - r.tFirst;
  }
  const completeRuns = runs.filter(r => r.complete);
  const incompleteRuns = runs.filter(r => !r.complete);

  // ══════════════════════════════ PARTE 2: minCount com denominadores

  // Entradas em parada: transicao !stopPhase -> stopPhase (mesmo episodio)
  const entries = phaseEvents.filter(e => !e.fromStop && e.toStop);
  // Saidas: stopPhase -> !stopPhase
  const exits = phaseEvents.filter(e => e.fromStop && !e.toStop);

  const classify = (c, m) => {
    if (c == null || m == null) return 'invalido';
    if (c < m) return '<';
    if (c === m) return '=';
    return '>';
  };
  const entryBucket = { '<': 0, '=': 0, '>': 0, invalido: 0 };
  for (const e of entries) entryBucket[classify(e.countTo, e.min)]++;
  const exitBucket = { '<': 0, '=': 0, '>': 0, invalido: 0 };
  for (const e of exits) exitBucket[classify(e.countTo, e.min)]++;

  const entryCrossed = entries.filter(e => e.countFrom != null && e.countTo != null
    && e.min != null && e.countFrom < e.min && e.countTo >= e.min);
  const exitCrossedDown = exits.filter(e => e.countFrom != null && e.countTo != null
    && e.min != null && e.countFrom >= e.min && e.countTo < e.min);

  // Correlacao: count no primeiro frame do run vs duracao observada.
  // EXIGE count observado NO run (nao herdado), e run completo.
  const pairsCountDur = [];
  const runsWithoutCount = [];
  for (const r of completeRuns) {
    if (r.countAtFirst == null) { runsWithoutCount.push(r); continue; }
    pairsCountDur.push([r.countAtFirst, r.observed]);
  }
  const rCountDur = correlation(pairsCountDur);

  // ══════════════════════════════ PARTE 3: duracao e amostras

  const sampleHistogram = {};
  for (const r of runs) sampleHistogram[r.samples] = (sampleHistogram[r.samples] || 0) + 1;
  const singleTrue = runs.filter(r => r.samples === 1).length;

  // intervalos locais entre publicacoes (a cadencia que importa)
  const localGaps = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].episode !== frames[i - 1].episode) continue;
    const d = frames[i].t - frames[i - 1].t;
    if (d > 0 && d <= MAX_AGE_MS) localGaps.push(d);
  }

  // ══════════════════════════════ hipotese das 20 saidas ausentes
  //
  // replayStopToMove < holdStopToMove. Cada evento de saida que o replay nao
  // ve deve ter ocorrido no primeiro frame de um episodio (onde ele e' INDET).
  const missedStopToMove = holdEvents.filter(e => e.from === true && e.to === false && e.atEpisodeStart);
  const missedDetail = missedStopToMove.map(e => ({
    episode: e.episode, t: e.t,
    phaseFrom: e.phaseFrom, phaseTo: e.phaseTo,
    countFrom: e.countFrom, countTo: e.countTo, min: e.min,
    note: 'primeiro frame do episodio: replay marca INDET, nao ve a saida',
  }));

  const out = {
    generatedAt: new Date().toISOString(),
    input: path.basename(input),
    snapshot: { bytes: stat.size, sha256 },
    definitions: { maxAgeMs: MAX_AGE_MS, episodeCut: 'gap > 600 ms', replayUses: 'kind6 do frame anterior' },
    volume: { frames, episodes: totalEpisodes },
    series: {
      replay: { ...replay, transitions: replayTransitions,
        stopToMove: replayStopToMove, moveToStop: replayMoveToStop },
      holding: { transitions: holdTransitions, stopToMove: holdStopToMove, moveToStop: holdMoveToStop },
      phase: { changes: phaseChanges, toStop: phaseToStop, fromStop: phaseFromStop,
        stopToStop: phaseStopToStop, sumInOut: phaseToStop + phaseFromStop,
        note: 'toStop+fromStop exclui stop->stop (mudanca de fase dentro da parada)' },
      runs: { total: runs.length, complete: completeRuns.length,
        incomplete: incompleteRuns.length,
        startAtEpisodeStart: runs.filter(r => r.startAtEpisodeStart).length,
        endAtBoundary: runs.filter(r => r.boundaryEnd).length },
    },
    missedTransitions: {
      hypothesis: 'replay perde saidas que ocorrem no 1o frame do episodio',
      count: missedDetail.length,
      expectedDiff: holdStopToMove - replayStopToMove,
      matches: missedDetail.length === (holdStopToMove - replayStopToMove),
      events: missedDetail,
    },
    minCount: {
      entries: { total: entries.length, bucket: entryBucket,
        crossedUp: entryCrossed.length,
        crossedUpDetail: entryCrossed.map(e => ({ from: e.countFrom, to: e.countTo, min: e.min })) },
      exits: { total: exits.length, bucket: exitBucket,
        crossedDown: exitCrossedDown.length },
      correlation: {
        r: rCountDur == null ? null : Number(rCountDur.toFixed(4)),
        n: pairsCountDur.length,
        runsWithoutCount: runsWithoutCount.length,
        note: 'apenas runs completos com count observado no 1o frame do run',
      },
    },
    duration: {
      complete: quantiles(completeRuns.map(r => r.observed)),
      lowerBoundAll: quantiles(runs.map(r => r.lowerBound)),
      lowerBoundComplete: quantiles(completeRuns.map(r => r.lowerBound)),
      samplesPerRun: quantiles(runs.map(r => r.samples)),
      histogramSamples: sampleHistogram,
      singleTrue,
      singleTrueFraction: runs.length ? Number((singleTrue / runs.length).toFixed(4)) : null,
      localGap: quantiles(localGaps),
    },
  };

  fs.writeFileSync(path.join(OUTDIR, 'auditoria-final.json'), JSON.stringify(out, null, 1));

  // ── saida
  const R = out.series.replay, H = out.series.holding, P = out.series.phase, U = out.series.runs;
  console.log('=== AUDITORIA FINAL DO REPLAY ===\n');
  console.log(`snapshot: ${out.snapshot.bytes} bytes`);
  console.log(`sha256  : ${out.snapshot.sha256}\n`);
  console.log(`frames em lure : ${totalFrames}`);
  console.log(`episodios      : ${totalEpisodes}\n`);

  console.log('--- SERIES (mesmos limites de episodio)');
  console.log(`REPLAY (kind6 anterior): STOP=${R.STOP} MOVE=${R.MOVE} INDET=${R.INDET}`);
  for (const [k, v] of Object.entries(R.reasons).sort((a, b) => b[1] - a[1])) console.log(`        ${String(v).padStart(6)}  ${k}`);
  console.log(`        trocas=${R.transitions} (parada->andou ${R.stopToMove}, andou->parada ${R.moveToStop})`);
  console.log(`HOLDING observado      : trocas=${H.transitions} (parada->andou ${H.stopToMove}, andou->parada ${H.moveToStop})`);
  console.log(`PHASE                  : mudancas=${P.changes} | entrada=${P.toStop} saida=${P.fromStop} stop->stop=${P.stopToStop} | soma in+out=${P.sumInOut}`);
  console.log(`RUNS holding=true      : total=${U.total} completos=${U.complete} incompletos=${U.incomplete}`);
  console.log(`        comecam no 1o frame do episodio: ${U.startAtEpisodeStart}`);
  console.log(`        terminam na borda do episodio : ${U.endAtBoundary}\n`);

  console.log('--- HIPOTESE DAS SAIDAS AUSENTES');
  console.log(`  esperado (holding - replay) = ${out.missedTransitions.expectedDiff}`);
  console.log(`  eventos encontrados no 1o frame = ${out.missedTransitions.count}`);
  console.log(`  bate: ${out.missedTransitions.matches}\n`);

  console.log('--- minCount');
  console.log(`  entradas: n=${entries.length} | <${out.minCount.entries.bucket['<']} =${out.minCount.entries.bucket['=']} >${out.minCount.entries.bucket['>']} invalido=${out.minCount.entries.bucket.invalido}`);
  console.log(`            cruzaram para cima: ${out.minCount.entries.crossedUp}`);
  console.log(`  saidas  : n=${exits.length} | <${out.minCount.exits.bucket['<']} =${out.minCount.exits.bucket['=']} >${out.minCount.exits.bucket['>']} invalido=${out.minCount.exits.bucket.invalido}`);
  console.log(`            cruzaram para baixo: ${out.minCount.exits.crossedDown}`);
  console.log(`  correlacao count x duracao: r=${out.minCount.correlation.r} (n=${out.minCount.correlation.n}, sem count=${out.minCount.correlation.runsWithoutCount})\n`);

  const D = out.duration;
  console.log('--- DURACAO');
  console.log(`  runs completos: n=${D.complete.n} mediana=${D.complete.median}ms p90=${D.complete.p90}ms max=${D.complete.max}ms`);
  console.log(`  limite inferior (todos): n=${D.lowerBoundAll.n} mediana=${D.lowerBoundAll.median}ms p90=${D.lowerBoundAll.p90}ms max=${D.lowerBoundAll.max}ms`);
  console.log(`  amostras/run: mediana=${D.samplesPerRun.median} max=${D.samplesPerRun.max}`);
  console.log(`  histograma: ${JSON.stringify(D.histogramSamples)}`);
  console.log(`  runs com 1 unico true: ${D.singleTrue}/${runs.length} = ${(D.singleTrueFraction * 100).toFixed(1)}%`);
  console.log(`  intervalo local entre publicacoes: mediana=${D.localGap.median}ms p90=${D.localGap.p90}ms max=${D.localGap.max}ms`);
  console.log(`\nEscrito: analysis/lure-stop-rule/auditoria-final.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
