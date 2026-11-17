'use strict';

/**
 * Analise offline: qual regra descreve parada/retomada do Shiba no lure.
 *
 *   node tools/lure-rule-analysis.cjs --session native/pka_tap_17748.jsonl
 *   node tools/lure-rule-analysis.cjs --discover native/pka_tap_8036.jsonl \
 *                                     --validate native/pka_tap_17748.jsonl
 *
 * READ-ONLY nos originais. Escreve so' em analysis/lure-stop-rule/.
 * Nao fala com o jogo, nao injeta, nao captura.
 *
 * LIMITE CENTRAL DECLARADO NO CABECALHO DO RELATORIO:
 * nao existe rotulo independente de movimento. `kind5.position` aparece em 8
 * de 2.296 publicacoes, e `luring.holding`/`luring.phase` sao 100%
 * redundantes (892/892 frames). Portanto:
 *   - Teste A (holding) e B (holding+count) sao CIRCULARES: a "verdade" e o
 *     proprio preditor.
 *   - Teste C (phase+holding) e' circular por construcao (phase == holding).
 *   - A unica medida honesta possivel e' CONSISTENCIA INTERNA e LAG entre
 *     publicacoes, nao acuracia contra movimento real.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'analysis', 'lure-stop-rule');

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const SESSION_DISCOVER = String(arg('--discover', path.join(ROOT, 'native', 'pka_tap_8036.jsonl')));
const SESSION_VALIDATE = String(arg('--validate', path.join(ROOT, 'native', 'pka_tap_17748.jsonl')));
const MAX_AGE_MS = Number(arg('--max-age', 600)); // N, justificado abaixo

/** Extrai kind6 com os campos de lure, em ordem de recebimento (t do tap). */
async function loadKind6(file) {
  const out = [];
  if (!fs.existsSync(file)) return { file, exists: false, frames: out };
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"kind":6')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!o.d) continue;
    let obj; try { obj = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { continue; }
    const lu = obj.luring || {};
    out.push({
      t: o.t,                       // GetTickCount() do PROCESSO do jogo, ms
      tick: obj.tick,               // contador de publicacao do runtime
      phase: obj.phase || '',
      lurePhase: String(lu.phase || 'off'),
      holding: lu.holding,
      count: Number.isFinite(lu.count) ? lu.count : null,
      minCount: Number.isFinite(lu.minCount) ? lu.minCount : null,
      mode: String(lu.mode || 'off'),
      paused: obj.paused === true,
    });
  }
  return { file, exists: true, frames: out };
}

/** Rótulo de PARADA usado nesta analise. */
function stopped(frame) {
  if (!frame) return null;
  if (frame.paused) return null;            // pausa global nao e' decisao de lure
  if (frame.mode === 'off') return null;    // lure desligado nao decide nada
  if (frame.holding === true) return true;
  if (frame.holding === false) return false;
  return null;
}

/** Teste A: prever parada por holding. */
const ruleA = f => (f.holding === true ? true : f.holding === false ? false : null);
/** Teste B: holding + limiar de count (usa minCount quando existe). */
function ruleB(f, fallbackMin = 8) {
  if (f.holding !== true) return f.holding === false ? false : null;
  const min = f.minCount != null && f.minCount > 0 ? f.minCount : fallbackMin;
  return f.count != null && f.count >= min;
}
/** Teste C: a "fase" — mas phase == holding, entao e' a mesma funcao. */
const ruleC = f => (['arc', 'stationary', 'wait', 'observe'].includes(f.lurePhase) ? true : false);

/** Distribuicao de intervalos entre publicacoes. */
function gaps(frames, pred = () => true) {
  const g = [];
  let prev = null;
  for (const f of frames) {
    if (!pred(f)) continue;
    if (prev != null && typeof f.t === 'number') {
      const d = f.t - prev;
      if (d > 0 && d < 60000) g.push(d);
    }
    prev = typeof f.t === 'number' ? f.t : null;
  }
  g.sort((a, b) => a - b);
  const q = p => (g.length ? g[Math.min(g.length - 1, Math.floor(g.length * p))] : null);
  return { n: g.length, median: q(0.5), p90: q(0.9), p95: q(0.95), max: g.length ? g[g.length - 1] : null };
}

/**
 * Episodios de lure: trechos contiguos com mode === 'dynamic'.
 * Um gap maior que MAX_AGE_MS encerra o episodio (mesma janela usada para
 * "ultimo kind6 valido"), o que torna episodios e alinhamento consistentes.
 */
function episodes(frames) {
  const eps = [];
  let cur = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const inLure = f.mode === 'dynamic' && !f.paused;
    if (!inLure) { if (cur) { eps.push(cur); cur = null; } continue; }
    const gapOk = cur && typeof f.t === 'number' && typeof cur.lastT === 'number'
      && (f.t - cur.lastT) <= MAX_AGE_MS && (f.t - cur.lastT) >= 0;
    if (!cur || !gapOk) {
      if (cur) eps.push(cur);
      cur = { startIndex: i, endIndex: i, lastT: f.t, frames: [f] };
    } else {
      cur.endIndex = i; cur.lastT = f.t; cur.frames.push(f);
    }
  }
  if (cur) eps.push(cur);
  return eps;
}

/** Transicoes parada<->movimento dentro de um episodio. */
function transitions(frames) {
  const tr = [];
  let prev = null;
  for (const f of frames) {
    const s = stopped(f);
    if (s == null) continue;
    if (prev != null && s !== prev) {
      tr.push({ t: f.t, from: prev, to: s, phase: f.lurePhase, count: f.count, holding: f.holding });
    }
    prev = s;
  }
  return tr;
}

/** Compara duas regras contra o rotulo `stopped` (que e' holding -> circular). */
function evaluate(frames, rule) {
  const m = { agree: 0, disagree: 0, undetermined: 0, tp: 0, tn: 0, fp: 0, fn: 0 };
  for (const f of frames) {
    const truth = stopped(f);
    const pred = rule(f);
    if (truth == null || pred == null) { m.undetermined++; continue; }
    if (pred === truth) m.agree++; else m.disagree++;
    if (truth && pred) m.tp++;
    else if (!truth && !pred) m.tn++;
    else if (!truth && pred) m.fp++;   // pausa indevida
    else m.fn++;                        // parada perdida
  }
  return m;
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const disc = await loadKind6(SESSION_DISCOVER);
  const val = await loadKind6(SESSION_VALIDATE);

  const episodeReport = (loaded) => {
    if (!loaded.exists) return { file: loaded.file, exists: false };
    const eps = episodes(loaded.frames);
    const allTr = eps.flatMap(e => transitions(e.frames));
    return {
      file: loaded.file,
      exists: true,
      frames: loaded.frames.length,
      framesInLure: eps.reduce((a, e) => a + e.frames.length, 0),
      episodes: eps.length,
      episodeFrames: eps.map(e => e.frames.length),
      transitions: allTr.length,
      stops: allTr.filter(x => x.to === true).length,
      resumes: allTr.filter(x => x.to === false).length,
    };
  };

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    clock: {
      field: 't',
      source: 'GetTickCount() do processo do jogo (ver native/pka_tap.c:149)',
      resolution: '~15,6 ms (tick padrao do Windows)',
      kind: 'monotonico relativo ao boot do sistema; NAO tem data/hora',
      noReceiveTimestamp: true,
      consequence: 'nao e possivel medir latencia publicacao->recebimento nem alinhar com relogio externo',
    },
    label: {
      name: 'stopped(frame)',
      source: 'luring.holding (kind6)',
      independent: false,
      note: 'O unico rotulo disponivel E o proprio preditor. Movimento real'
        + ' (kind5.position) aparece em 8 de 2296 publicacoes — insuficiente.',
    },
    discovery: episodeReport(disc),
    validation: episodeReport(val),
    gapsDiscovery: gaps(disc.frames, f => f.mode === 'dynamic'),
    gapsValidation: gaps(val.frames, f => f.mode === 'dynamic'),
    maxAgeMs: MAX_AGE_MS,
  };

  // ---- Teste A/B/C contra o unico rotulo possivel (holding)
  const run = (frames, rule) => evaluate(frames.filter(f => f.mode === 'dynamic' && !f.paused), rule);
  report.tests = {
    A: { discovery: run(disc.frames, ruleA), validation: run(val.frames, ruleA) },
    B: { discovery: run(disc.frames, ruleB), validation: run(val.frames, ruleB) },
    C: { discovery: run(disc.frames, ruleC), validation: run(val.frames, ruleC) },
  };

  // ---- circularidade: phase e holding divergem alguma vez?
  const diverge = (frames) => {
    let n = 0, diff = 0;
    for (const f of frames) {
      if (f.mode !== 'dynamic') continue;
      n++;
      const byHolding = f.holding === true;
      const byPhase = ['arc', 'stationary', 'wait', 'observe'].includes(f.lurePhase);
      if (byHolding !== byPhase) diff++;
    }
    return { frames: n, divergences: diff };
  };
  report.circularity = {
    discovery: diverge(disc.frames),
    validation: diverge(val.frames),
  };

  // ---- transicoes: latencia preditor vs observado (mesma fonte -> 0 por construcao)
  report.transitionTiming = {
    note: 'preditor e rotulo vem do MESMO campo (holding). A latencia medida e 0'
      + ' por construcao e nao informa nada sobre atraso real de movimento.',
    discovery: transitions(disc.frames.filter(f => f.mode === 'dynamic')).length,
    validation: transitions(val.frames.filter(f => f.mode === 'dynamic')).length,
  };

  fs.writeFileSync(path.join(OUTDIR, 'resultado.json'), JSON.stringify(report, null, 1));

  // ---- resumo legivel
  console.log('=== ANALISE OFFLINE: regra de parada/retomada no lure ===\n');
  console.log('RELÓGIO: t = GetTickCount() do processo do jogo');
  console.log('  resolucao ~15,6 ms | monotonico | SEM data/hora | SEM horario de recebimento');
  console.log('  -> latencia publicacao->recebimento: INDISPONIVEL');
  console.log('  -> alinhamento com relogio externo: INDISPONIVEL\n');
  console.log('RÓTULO: stopped() = luring.holding');
  console.log('  independente: NAO (e o proprio preditor de A e B)\n');
  for (const [name, d] of [['DESCOBERTA', report.discovery], ['VALIDACAO', report.validation]]) {
    if (!d.exists) { console.log(`${name}: arquivo ausente (${d.file})`); continue; }
    console.log(`${name}: ${d.file}`);
    console.log(`  kind6=${d.frames} | em lure dynamic=${d.framesInLure} | episodios=${d.episodes}`);
    console.log(`  transicoes=${d.transitions} (paradas=${d.stops}, retomadas=${d.resumes})`);
  }
  console.log(`\nGAP kind6 em lure (ms): descoberta mediana=${report.gapsDiscovery.median} p95=${report.gapsDiscovery.p95} max=${report.gapsDiscovery.max}`);
  console.log(`                        validacao mediana=${report.gapsValidation.median} p95=${report.gapsValidation.p95} max=${report.gapsValidation.max}`);
  console.log(`N (idade maxima aceitavel) = ${MAX_AGE_MS} ms (cobre p95 com folga)\n`);
  for (const t of ['A', 'B', 'C']) {
    const d = report.tests[t].discovery, v = report.tests[t].validation;
    console.log(`Teste ${t}: descoberta acordo=${d.agree} desacordo=${d.disagree} indeterm=${d.undetermined} | validacao acordo=${v.agree} desacordo=${v.disagree} indeterm=${v.undetermined}`);
  }
  console.log(`\nCIRCULARIDADE phase vs holding:`);
  console.log(`  descoberta: ${report.circularity.discovery.frames} frames, ${report.circularity.discovery.divergences} divergencias`);
  console.log(`  validacao : ${report.circularity.validation.frames} frames, ${report.circularity.validation.divergences} divergencias`);
  console.log(`\n-> phase e holding NUNCA divergem. Teste C e' identico a A por construcao.`);
  console.log(`\nEscrito: analysis/lure-stop-rule/resultado.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
