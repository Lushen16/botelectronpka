'use strict';

/**
 * Replay sincronizado: testa UMA regra (holding) contra o que o log permite.
 *
 *   node tools/lure-replay.cjs --in analysis/lure-stop-rule/snapshot-*.jsonl
 *
 * READ-ONLY. Nao fala com o jogo, nao injeta, nao captura.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ LIMITE DECLARADO: NAO EXISTE GRAVACAO DESTA SESSAO.                  │
 * │                                                                      │
 * │ Varredura: 28 video no diretorio Videos, TODOS de outros jogos.      │
 * │ Nenhum MP4/MKV/WEBM do PokeAlliance em disco. Nenhum screenshot      │
 * │ de 11/11.                                                            │
 * │                                                                      │
 * │ Consequencia: "o personagem realmente parou?" NAO E' RESPONDIVEL      │
 * │ com os artefatos existentes. Este replay mede o que E' mensuravel:   │
 * │   1. estabilidade do sinal (holding troca de valor?)                │
 * │   2. histerese (quantos frames ficam em cada estado)                │
 * │   3. coerencia entre `page` textual e `holding`                     │
 * │   4. o sinal sobrevive ao limite de 600 ms?                          │
 * │ e deixa a latencia real PARADA/RETOMADA em aberto, como pedido.      │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * REGRA TESTADA (unica, congelada):
 *   holding === true   -> manter parada
 *   holding === false  -> liberar movimento normal
 *   ultimo kind6 ausente OU idade > 600 ms -> INDETERMINADO
 *   count/minCount NAO entram nesta decisao (o relatorio mostrou que o
 *   filtro so' elimina casos reais de parada)
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'analysis', 'lure-stop-rule');

const MAX_AGE_MS = 600; // N congelado na analise anterior

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const input = String(arg('--in', ''));
if (!input || !fs.existsSync(input)) {
  console.error('faltou --in <snapshot.jsonl>');
  process.exit(2);
}

/** A regra. Uma unica funcao, sem ramificacao escondida. */
function predict(lastKind6, nowT) {
  if (!lastKind6) return { decision: null, reason: 'sem kind6 anterior' };
  if (typeof lastKind6.t !== 'number' || typeof nowT !== 'number') {
    return { decision: null, reason: 'timestamp ausente' };
  }
  const age = nowT - lastKind6.t;
  if (age < 0) return { decision: null, reason: 'kind6 posterior' };
  if (age > MAX_AGE_MS) return { decision: null, reason: `idade ${age}ms > ${MAX_AGE_MS}ms` };
  if (lastKind6.holding === true) return { decision: 'STOP', reason: 'holding=true', age };
  if (lastKind6.holding === false) return { decision: 'MOVE', reason: 'holding=false', age };
  return { decision: null, reason: 'holding ausente', age };
}

async function main() {
  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });

  const stats = {
    file: input,
    maxAgeMs: MAX_AGE_MS,
    kind6Total: 0,
    kind6InLure: 0,
    // passos de replay: cada kind6 e' um "instante de decisao"
    steps: 0,
    stop: 0, move: 0, undetermined: 0,
    undeterminedReasons: {},
    // trocas de estado (replay decide a cada kind6)
    transitions: 0,
    stopToMove: 0, moveToStop: 0,
    // frames em cada estado (duracao do sinal)
    framesStop: 0, framesMove: 0,
    // idade do ultimo kind6 no instante de cada decisao
    ages: [],
    // episodios
    episodes: 0,
    episodeLengths: [],
    // histerese: quantos kind6 consecutivos no mesmo estado
    runs: [],
    // divergencia phase x holding (deve ser zero)
    phaseHoldingDivergences: 0,
    // transicoes de fase com contexto
    phaseTransitions: [],
  };

  let last = null;          // ultimo kind6 (para idade)
  let prevDecision = null;
  let runLen = 0;
  let episode = null;
  let lastEpT = null;

  for await (const line of rl) {
    if (!line.includes('"kind":6')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o.d) continue;
    let obj; try { obj = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { continue; }
    const lu = obj.luring || {};

    stats.kind6Total++;

    // episodio: mode=dynamic e nao pausado
    const inLure = lu.mode === 'dynamic' && obj.paused !== true;
    if (!inLure) {
      if (episode) { stats.episodes++; stats.episodeLengths.push(episode.frames); episode = null; }
      last = null; prevDecision = null; runLen = 0; lastEpT = null;
      continue;
    }
    stats.kind6InLure++;

    // novo episodio por gap > MAX_AGE
    if (episode && typeof o.t === 'number' && typeof lastEpT === 'number' && (o.t - lastEpT) > MAX_AGE_MS) {
      stats.episodes++; stats.episodeLengths.push(episode.frames); episode = null;
      prevDecision = null; runLen = 0;
    }
    if (!episode) episode = { start: o.t, frames: 0 };
    episode.frames++;
    lastEpT = o.t;

    // ---- a regra decide com base no kind6 ANTERIOR (nunca no atual)
    const p = predict(last, o.t);
    stats.steps++;
    if (p.decision === 'STOP') { stats.stop++; stats.framesStop++; stats.ages.push(p.age); }
    else if (p.decision === 'MOVE') { stats.move++; stats.framesMove++; stats.ages.push(p.age); }
    else { stats.undetermined++; stats.undeterminedReasons[p.reason] = (stats.undeterminedReasons[p.reason] || 0) + 1; }

    // ---- coerencia do sinal
    if (lu.holding != null && lu.phase != null && lu.phase !== 'off') {
      const byHolding = lu.holding === true;
      const byPhase = ['arc', 'stationary', 'wait', 'observe'].includes(String(lu.phase));
      if (byHolding !== byPhase) stats.phaseHoldingDivergences++;
    }

    // ---- trocas e histerese
    if (p.decision != null) {
      if (prevDecision != null && p.decision !== prevDecision) {
        stats.transitions++;
        if (prevDecision === 'STOP') stats.stopToMove++; else stats.moveToStop++;
        stats.runs.push(runLen);
        runLen = 0;
      }
      prevDecision = p.decision;
      runLen++;
    }

    // ---- transicao de fase com contexto (para inspecao)
    if (last && String(last.phase) !== String(lu.phase)) {
      stats.phaseTransitions.push({
        t: o.t, fromPhase: String(last.phase).slice(0, 40),
        toPhase: String(lu.phase).slice(0, 40),
        count: lu.count, min: lu.minCount, holding: lu.holding,
        prevCount: last.count, msInPrev: o.t - last.t,
      });
    }

    last = { t: o.t, holding: lu.holding, count: lu.count, minCount: lu.minCount,
      phase: lu.phase, mode: lu.mode };
  }
  if (episode) { stats.episodes++; stats.episodeLengths.push(episode.frames); }

  // ---- estatisticas
  const ages = stats.ages.slice().sort((a, b) => a - b);
  const q = p => (ages.length ? ages[Math.min(ages.length - 1, Math.floor(ages.length * p))] : null);
  const runs = stats.runs.slice().sort((a, b) => a - b);
  const rq = p => (runs.length ? runs[Math.min(runs.length - 1, Math.floor(runs.length * p))] : null);

  stats.ageStats = { n: ages.length, median: q(0.5), p90: q(0.9), p95: q(0.95), max: ages.length ? ages[ages.length - 1] : null };
  stats.runStats = { n: runs.length, median: rq(0.5), p90: rq(0.9), max: runs.length ? runs[runs.length - 1] : null };
  stats.episodeStats = {
    n: stats.episodeLengths.length,
    median: (() => { const s = stats.episodeLengths.slice().sort((a, b) => a - b);
      return s.length ? s[Math.floor(s.length / 2)] : null; })(),
    max: stats.episodeLengths.length ? Math.max(...stats.episodeLengths) : null,
  };

  fs.writeFileSync(path.join(OUTDIR, 'replay-holding.json'), JSON.stringify(stats, null, 1));

  console.log('=== REPLAY: regra unica `holding` (N=600ms) ===\n');
  console.log(`arquivo              : ${path.basename(input)}`);
  console.log(`kind6 total          : ${stats.kind6Total}`);
  console.log(`kind6 em lure dynamic: ${stats.kind6InLure}`);
  console.log(`episodios            : ${stats.episodes}  (mediana ${stats.episodeStats.median} frames, max ${stats.episodeStats.max})`);
  console.log('');
  console.log('--- decisoes do replay');
  console.log(`  STOP   : ${stats.stop}`);
  console.log(`  MOVE   : ${stats.move}`);
  console.log(`  INDET  : ${stats.undetermined}`);
  for (const [r, n] of Object.entries(stats.undeterminedReasons).sort((a, b) => b[1] - a[1])) {
    console.log(`           ${String(n).padStart(6)}  ${r}`);
  }
  console.log('');
  console.log('--- sinal');
  console.log(`  trocas STOP<->MOVE : ${stats.transitions}  (parada->andou ${stats.stopToMove}, andou->parada ${stats.moveToStop})`);
  console.log(`  duracao do run (kind6 consecutivos): mediana ${stats.runStats.median}, p90 ${stats.runStats.p90}, max ${stats.runStats.max}`);
  console.log(`  idade do kind6 usado: mediana ${stats.ageStats.median}ms, p95 ${stats.ageStats.p95}ms, max ${stats.ageStats.max}ms`);
  console.log('');
  console.log(`--- coerencia phase x holding: ${stats.phaseHoldingDivergences} divergencias`);
  console.log('');
  console.log('LATENCIA PARADA/RETOMADA: INDISPONIVEL');
  console.log('  motivo: nao existe gravacao desta sessao (nenhum video do PokeAlliance');
  console.log('  em disco). Sem referencia visual, nao ha transicao observada para parear.');
  console.log('');
  console.log('Escrito: analysis/lure-stop-rule/replay-holding.json');
}

main().catch(e => { console.error(e); process.exit(1); });
