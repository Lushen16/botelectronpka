'use strict';

/**
 * Reconcilia os tres totais do relatorio e mede duracao pelos TIMESTAMPS.
 *
 *   node tools/lure-reconcile.cjs --in analysis/lure-stop-rule/snapshot-*.jsonl
 *
 * READ-ONLY. Nao fala com o jogo.
 *
 * RESOLVE TRES PONTOS DE AUDITORIA:
 *
 * 1. Os tres totais divergentes (305 trocas, 305 runs, 498 transicoes) vem de
 *    SERIES DIFERENTES. Este script calcula cada um com filtro explicito e
 *    mostra a serie de origem.
 *
 * 2. Restringe a conclusao sobre minCount: mede se `count` CRUZA o limiar na
 *    entrada e na saida, separando "necessario" de "influencia indireta".
 *
 * 3. Mede duracao por TIMESTAMP, nao por contagem de amostras:
 *      duracao observada = t(primeiro false apos o run) - t(primeiro true)
 *      limite inferior    = t(ultimo true do run) - t(primeiro true)
 *    Runs sem `false` observado no mesmo episodio sao INCOMPLETOS.
 *    Justificativa: dois registros a 203 ms cobrem ~203 ms entre o primeiro e
 *    o ultimo; supor 406 ms assume que o estado sobreviveu mais um intervalo.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

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
if (!input || !fs.existsSync(input)) { console.error('faltou --in'); process.exit(2); }

const MEDIAN_MS = 203; // cadencia medida; usada so' para rotular, nao para duracao

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });

  const inLure = [];   // serie 1: registros em lure dynamic, ja' com episodio
  let episodeId = -1;
  let lastT = null;
  let prevWasLure = false;

  for await (const line of rl) {
    if (!line.includes('"kind":6')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o.d) continue;
    let obj; try { obj = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { continue; }
    const lu = obj.luring || {};
    const isLure = lu.mode === 'dynamic' && obj.paused !== true;

    if (!isLure) { prevWasLure = false; lastT = null; continue; }

    // borda de episodio: gap > MAX_AGE fecha o episodio
    if (!prevWasLure || lastT == null || (o.t - lastT) > MAX_AGE_MS) episodeId++;
    prevWasLure = true;
    lastT = o.t;

    inLure.push({
      t: o.t,
      episode: episodeId,
      holding: lu.holding,
      phase: String(lu.phase || 'off'),
      count: Number.isFinite(lu.count) ? lu.count : null,
      minCount: Number.isFinite(lu.minCount) ? lu.minCount : null,
    });
  }

  // ═══════════════════════════════════════════════════════════ PONTO 1
  //
  // SERIE A — DECISOES da regra `holding` (o que o replay produziu)
  //   filtro: todos os registros em lure
  //   unidade: troca de DECISAO prevista (usa o registro ANTERIOR p/ prever)
  //   borda: episodio novo zera prevDecision
  const decisions = [];
  let prevDecision = null;
  let prevEp = null;
  for (const r of inLure) {
    if (r.episode !== prevEp) { prevDecision = null; prevEp = r.episode; }
    let d = null;
    if (r.holding === true) d = 'STOP';
    else if (r.holding === false) d = 'MOVE';
    // a decisao efetiva do replay usa o registro ANTERIOR; para contar
    // TROCAS do sinal basta a sequencia de estados observados
    decisions.push({ t: r.t, episode: r.episode, d, phase: r.phase, count: r.count, minCount: r.minCount });
  }
  let decTransitions = 0, decStopToMove = 0, decMoveToStop = 0;
  let decPrev = null, decPrevEp = null;
  const runs = [];
  let runLen = 0;
  for (const d of decisions) {
    if (d.episode !== decPrevEp) { decPrev = null; decPrevEp = d.episode; runLen = 0; }
    if (d.d == null) continue;
    if (decPrev != null && d.d !== decPrev) {
      decTransitions++;
      if (decPrev === 'STOP') decStopToMove++; else decMoveToStop++;
      runs.push(runLen); runLen = 0;
    }
    decPrev = d.d; runLen++;
  }
  if (runLen > 0) runs.push(runLen); // run aberto no fim (nao e' transicao)

  // SERIE B — FASES do lure (o que a analise de minCount usou)
  //   filtro: mesma serie, mas unidade = mudanca de luring.phase
  //   borda: compara apenas dentro do mesmo episodio (gap > 600 ms corta)
  let phaseTransitions = 0;
  let entriesToStop = 0, exitsFromStop = 0;
  const entryDetail = []; const exitDetail = [];
  let pPrev = null, pPrevEp = null;
  const STOP_PHASES = new Set(['arc', 'stationary', 'wait', 'observe']);
  for (const r of inLure) {
    if (r.episode !== pPrevEp) { pPrev = null; pPrevEp = r.episode; }
    if (pPrev && pPrev.phase !== r.phase) {
      phaseTransitions++;
      const fromStop = STOP_PHASES.has(pPrev.phase);
      const toStop = STOP_PHASES.has(r.phase);
      if (!fromStop && toStop) {
        entriesToStop++;
        entryDetail.push({ t: r.t, from: pPrev.phase, to: r.phase,
          prevCount: pPrev.count, count: r.count, min: r.minCount });
      }
      if (fromStop && !toStop) {
        exitsFromStop++;
        exitDetail.push({ t: r.t, from: pPrev.phase, to: r.phase,
          prevCount: pPrev.count, count: r.count, min: r.minCount });
      }
    }
    pPrev = r;
  }

  // ═══════════════════════════════════════════════════════════ PONTO 3
  //
  // Duracao por TIMESTAMP. Um "run" e' uma sequencia contigua de holding=true
  // dentro do MESMO episodio.
  //
  //   duracao observada = t(primeiro false depois) - t(primeiro true)
  //   limite inferior   = t(ultimo true) - t(primeiro true)
  //
  // Se nao houver false depois dentro do episodio -> INCOMPLETO.
  const runsWithTime = [];
  let cur = null;
  let lastEpForRun = null;
  for (const r of inLure) {
    if (r.episode !== lastEpForRun) {
      if (cur) { cur.incomplete = true; runsWithTime.push(cur); cur = null; } // episodio cortou
      lastEpForRun = r.episode;
    }
    if (r.holding === true) {
      if (!cur) cur = { tFirst: r.t, tLast: r.t, tFalse: null, samples: 1, episode: r.episode };
      else { cur.tLast = r.t; cur.samples++; }
    } else if (r.holding === false) {
      if (cur) {
        cur.tFalse = r.t;
        cur.observed = r.t - cur.tFirst;
        cur.lowerBound = cur.tLast - cur.tFirst;
        cur.incomplete = false;
        runsWithTime.push(cur); cur = null;
      }
    }
  }
  if (cur) { cur.incomplete = true; runsWithTime.push(cur); }

  const complete = runsWithTime.filter(x => !x.incomplete);
  const incomplete = runsWithTime.filter(x => x.incomplete);
  const stat = (arr, f) => {
    const v = arr.map(f).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
    const q = p => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null);
    return { n: v.length, median: q(0.5), p90: q(0.9), max: v.length ? v[v.length - 1] : null };
  };

  // ═══════════════════════════════════════════════════════════ PONTO 2
  //
  // Restricao da conclusao sobre minCount:
  //   (a) na ENTRADA, o count mudou/atravessou o limiar?
  //   (b) na SAIDA, o count atravessou o limiar?
  //   (c) existe influencia indireta? (count no inicio do run vs duracao)
  const entryCross = entryDetail.filter(e => e.prevCount != null && e.count != null
    && e.min != null && e.prevCount < e.min && e.count >= e.min);
  const exitCross = exitDetail.filter(e => e.prevCount != null && e.count != null
    && e.min != null && e.prevCount >= e.min && e.count < e.min);
  const exitAtOrAbove = exitDetail.filter(e => e.count != null && e.min != null && e.count >= e.min);
  const exitBelow = exitDetail.filter(e => e.count != null && e.min != null && e.count < e.min);

  // correlacao simples: count na entrada do run vs duracao observada
  const pairsCT = [];
  {
    let idx = 0;
    for (const r of inLure) {
      if (r.holding === true) {
        const runI = runsWithTime.findIndex(x => x.tFirst === r.t);
        if (runI >= 0 && !runsWithTime[runI].incomplete && runsWithTime[runI].countAtStart === undefined) {
          runsWithTime[runI].countAtStart = r.count;
        }
      }
    }
    for (const x of complete) if (x.countAtStart != null) pairsCT.push([x.countAtStart, x.observed]);
  }
  const corr = (() => {
    if (pairsCT.length < 3) return null;
    const xs = pairsCT.map(p => p[0]), ys = pairsCT.map(p => p[1]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2;
    }
    return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
  })();

  const out = {
    file: path.basename(input),
    maxAgeMs: MAX_AGE_MS,
    totalFramesInLure: inLure.length,
    episodes: episodeId + 1,
    totals: {
      A_decisions: {
        source: 'sequencia de luring.holding (o sinal que a regra usa)',
        filter: 'mode=dynamic, !paused',
        episodeBoundary: `gap > ${MAX_AGE_MS} ms entre publicacoes`,
        transitions: decTransitions,
        stopToMove: decStopToMove,
        moveToStop: decMoveToStop,
        runsClosedByTransition: runs.length - 1 >= 0 ? runs.length : 0,
        note: 'runs.length inclui o run aberto no fim; por isso pode diferir de +1',
      },
      B_phases: {
        source: 'sequencia de luring.phase (usada na analise de minCount)',
        filter: 'mode=dynamic, !paused',
        episodeBoundary: `gap > ${MAX_AGE_MS} ms`,
        transitions: phaseTransitions,
        entriesToStop,
        exitsFromStop,
        sum: entriesToStop + exitsFromStop,
        note: 'entradas+saidas < total porque ha transicoes stop->stop de fase'
          + ' diferente (arc->stationary) que nao contam como entrada nem saida',
      },
    },
    minCountAudit: {
      entryTransitions: entryDetail.length,
      entryCrossedThreshold: entryCross.length,
      entryStableOrOther: entryDetail.length - entryCross.length,
      exitTransitions: exitDetail.length,
      exitCrossedDown: exitCross.length,
      exitAtOrAbove: exitAtOrAbove.length,
      exitBelow: exitBelow.length,
      correlationCountVsDuration: corr === null ? null : Number(corr.toFixed(3)),
      conclusion: entryCross.length === 0 && exitCross.length === 0
        ? 'count NAO cruza o limiar nem na entrada nem na saida: minCount nao e gatilho'
        : 'count cruza o limiar em alguns casos: verificar',
    },
    duration: {
      method: 't(primeiro false depois) - t(primeiro true), dentro do episodio',
      lowerBoundMethod: 't(ultimo true) - t(primeiro true)',
      runs: runsWithTime.length,
      complete: complete.length,
      incomplete: incomplete.length,
      observed: stat(complete, x => x.observed),
      lowerBound: stat(complete, x => x.lowerBound),
      samplesPerRun: stat(runsWithTime, x => x.samples),
      note: 'duracao real esta em [lowerBound, observed]; acima de observed so'
        + ' se o estado persistir apos a ultima amostra true',
    },
  };

  fs.writeFileSync(path.join(OUTDIR, 'reconciliacao.json'), JSON.stringify(out, null, 1));

  // ── saida legivel
  console.log('=== RECONCILIACAO DOS TOTAIS ===\n');
  console.log(`frames em lure : ${out.totalFramesInLure}`);
  console.log(`episodios      : ${out.episodes}\n`);

  console.log('SERIE A — decisoes por luring.holding:');
  console.log(`  trocas STOP<->MOVE : ${out.totals.A_decisions.transitions}`);
  console.log(`    parada->andou    : ${out.totals.A_decisions.stopToMove}`);
  console.log(`    andou->parada    : ${out.totals.A_decisions.moveToStop}`);
  console.log(`  runs (fechados+aberto): ${out.totals.A_decisions.runsClosedByTransition}`);
  console.log(`  filtro: mode=dynamic; borda: gap>${MAX_AGE_MS}ms\n`);

  console.log('SERIE B — transicoes de luring.phase:');
  console.log(`  total de mudancas de fase : ${out.totals.B_phases.transitions}`);
  console.log(`    entradas em parada      : ${out.totals.B_phases.entriesToStop}`);
  console.log(`    saidas de parada        : ${out.totals.B_phases.exitsFromStop}`);
  console.log(`    soma (o "498" anterior) : ${out.totals.B_phases.sum}`);
  console.log(`  nota: ${out.totals.B_phases.note}\n`);

  console.log('AUDITORIA DO minCount:');
  const m = out.minCountAudit;
  console.log(`  entradas em parada: ${m.entryTransitions} | cruzaram o limiar: ${m.entryCrossedThreshold}`);
  console.log(`  saidas de parada  : ${m.exitTransitions} | cruzaram p/ baixo: ${m.exitCrossedDown}`);
  console.log(`    saida com count>=min: ${m.exitAtOrAbove} | com count<min: ${m.exitBelow}`);
  console.log(`  correlacao count-entrada vs duracao: ${m.correlationCountVsDuration}`);
  console.log(`  -> ${m.conclusion}\n`);

  console.log('DURACAO POR TIMESTAMP:');
  const d = out.duration;
  console.log(`  runs de holding=true : ${d.runs} (completos ${d.complete}, incompletos ${d.incomplete})`);
  console.log(`  duracao observada (ms): mediana ${d.observed.median}, p90 ${d.observed.p90}, max ${d.observed.max}`);
  console.log(`  limite inferior  (ms): mediana ${d.lowerBound.median}, p90 ${d.lowerBound.p90}, max ${d.lowerBound.max}`);
  console.log(`  amostras por run     : mediana ${d.samplesPerRun.median}, max ${d.samplesPerRun.max}`);
  console.log(`  regra: ${d.method}`);
  console.log('\nEscrito: analysis/lure-stop-rule/reconciliacao.json');
}

main().catch(e => { console.error(e); process.exit(1); });
