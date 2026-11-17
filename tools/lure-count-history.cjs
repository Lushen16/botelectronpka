'use strict';

/**
 * Historico de `count` ANTES da entrada em parada.
 *
 *   node tools/lure-count-history.cjs \
 *     --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl
 *
 * READ-ONLY. Nao toca no PID 17748, nao captura, nao injeta.
 *
 * PERGUNTA: `count` sobe ANTES de `holding` virar true?
 *
 * METODO
 *   - entradas: transicoes observadas false->true (155 no snapshot)
 *   - para cada entrada, olhar kind6 ANTERIORES no mesmo episodio,
 *     dentro das janelas de 200, 400 e 600 ms
 *   - o frame da transicao e' EXCLUIDO (nao e' "antes")
 *   - limites: mesmo episodio (gap > 600 ms corta) e gap <= 600 ms
 *
 * COBERTURA (a parte que decide se o teste e' viavel)
 *   - nPrev0 / nPrev1 / nPrev2+ : quantas amostras validas anteriores
 *   - coveredFromStart : existe amostra valida no inicio da janela OU antes
 *     dela, dentro do mesmo episodio. Distingue "tem pontos na janela" de
 *     "tem cobertura desde o inicio".
 *
 * CONTROLE
 *   - frames em que `holding` permaneceu false, mesmo episodio,
 *     mesmo `count` atual da entrada correspondente quando possivel
 *   - mesmo criterio de cobertura
 *
 * O resultado e' ASSOCIACAO, nao causalidade.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROOT = path.resolve(__dirname, '..');
const OUTDIR = path.join(ROOT, 'analysis', 'lure-stop-rule');
const MAX_AGE_MS = 600;
const WINDOWS = [200, 400, 600];

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const input = String(arg('--in', ''));
if (!input || !fs.existsSync(input)) { console.error('faltou --in'); process.exit(2); }

const STOP_PHASES = new Set(['arc', 'stationary', 'wait', 'observe']);

async function main() {
  // ── carga preservando indice global e episodio
  const frames = [];
  let episode = -1, lastT = null, prevWasLure = false;

  const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  for await (const line of rl) {
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

    frames.push({
      gi: frames.length,
      t: o.t,
      episode,
      newEp,
      holding: lu.holding === true ? true : lu.holding === false ? false : null,
      phase: String(lu.phase || 'off'),
      count: Number.isFinite(lu.count) ? lu.count : null,
      min: Number.isFinite(lu.minCount) ? lu.minCount : null,
    });
  }

  // indice: por episodio, lista de frames
  const byEp = new Map();
  for (const f of frames) {
    if (!byEp.has(f.episode)) byEp.set(f.episode, []);
    byEp.get(f.episode).push(f);
  }

  // ── entradas observadas false->true
  const entries = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (a.episode !== b.episode) continue;
    if (a.holding === false && b.holding === true) {
      entries.push({ gi: i, t: b.t, episode: b.episode, countAtEntry: b.count, min: b.min });
    }
  }

  /**
   * Coleta amostras anteriores dentro de uma janela.
   * @returns {{samples: object[], coveredFromStart: boolean, atBoundary: boolean}}
   */
  function priorSamples(entry, windowMs) {
    const epFrames = byEp.get(entry.episode) || [];
    const lo = entry.t - windowMs;
    const samples = [];
    let coveredFromStart = false;
    let atBoundary = false;

    for (const f of epFrames) {
      if (f.t >= entry.t) break;            // so' o que vem ANTES da transicao
      if (f.t < lo) continue;               // fora da janela
      if (f.count != null) samples.push(f);
    }
    // cobertura desde o inicio: existe amostra valida em [lo, lo+gap) ou antes,
    // dentro do mesmo episodio
    const firstOfEp = epFrames[0];
    for (const f of epFrames) {
      if (f.t >= entry.t) break;
      if (f.t <= lo) {
        // existe historico anterior a janela no mesmo episodio
        coveredFromStart = f.count != null;
        atBoundary = f.count != null && (lo - f.t) <= MAX_AGE_MS;
      }
    }
    // se o episodio comeca dentro da janela, nao ha cobertura "desde o inicio"
    if (firstOfEp && firstOfEp.t >= lo) coveredFromStart = false;

    return { samples, coveredFromStart, atBoundary };
  }

  /** Subiu = existe aumento entre duas amostras consecutivas validas. */
  function roseWithin(samples) {
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].count > samples[i - 1].count) return true;
    }
    return false;
  }

  // ── analise por janela
  const report = {};
  for (const w of WINDOWS) {
    const stats = {
      windowMs: w,
      entries: entries.length,
      prev0: 0, prev1: 0, prev2plus: 0,
      coveredFromStart: 0,
      atBoundaryCount: 0,
      withAtLeast2: 0,            // subconjunto elegivel para testar subida
      rose: 0,                    // entre os elegiveis
      denominatorTestable: 0,
      roseRate: null,
      control: null,
    };

    const eligibleEntries = [];
    for (const e of entries) {
      const { samples, coveredFromStart, atBoundary } = priorSamples(e, w);
      const n = samples.length;
      if (n === 0) stats.prev0++;
      else if (n === 1) stats.prev1++;
      else stats.prev2plus++;

      if (coveredFromStart) stats.coveredFromStart++;
      if (atBoundary) stats.atBoundaryCount++;

      // teste de subida exige >= 2 amostras consecutivas
      if (n >= 2) {
        stats.denominatorTestable++;
        const rose = roseWithin(samples);
        if (rose) stats.rose++;
        eligibleEntries.push({ entry: e, samples, rose });
      }
    }
    stats.withAtLeast2 = stats.denominatorTestable;
    stats.roseRate = stats.denominatorTestable
      ? Number((stats.rose / stats.denominatorTestable).toFixed(4)) : null;

    // ── controle: frames com holding=false, mesma episodio, mesmo count atual
    //
    // Para cada entrada elegivel, procurar frames de controle no MESMO episodio
    // em que holding===false, com o MESMO count que a entrada tinha, e com o
    // mesmo numero de amostras anteriores disponiveis.
    let ctrlTotal = 0, ctrlRose = 0, ctrlMatched = 0;
    for (const el of eligibleEntries) {
      const e = el.entry;
      const epFrames = byEp.get(e.episode) || [];
      for (const f of epFrames) {
        if (f.holding !== false) continue;
        if (f.count == null || f.count !== e.countAtEntry) continue;
        // mesmo criterio de cobertura: amostras anteriores na janela
        const prior = priorSamples({ t: f.t, episode: f.episode }, w);
        if (prior.samples.length < 2) continue;
        ctrlTotal++;
        if (roseWithin(prior.samples)) ctrlRose++;
      }
      ctrlMatched++;
    }
    stats.control = {
      entriesMatched: ctrlMatched,
      frames: ctrlTotal,
      rose: ctrlRose,
      denominator: ctrlTotal,
      roseRate: ctrlTotal ? Number((ctrlRose / ctrlTotal).toFixed(4)) : null,
      note: 'frames holding=false, mesmo episodio, mesmo count da entrada, '
        + 'mesma exigencia de >=2 amostras anteriores',
    };

    if (stats.roseRate != null && stats.control.roseRate != null) {
      stats.deltaPercentagePoints =
        Number(((stats.roseRate - stats.control.roseRate) * 100).toFixed(1));
    }

    // ── PAREAMENTO POR Nº DE AMOSTRAS ANTERIORES
    //
    // Duas populacoes DIFERENTES e isso precisa ficar explicito:
    //   (a) controle BRUTO   : todo frame holding=false com >=2 anteriores
    //                          -> 20.348 frames, mas cada frame e' uma
    //                             observacao sobrepostas (nao independente)
    //   (b) estrato pareado  : mesma contagem de amostras anteriores
    //
    // O estimador pooled (sum rose / sum n) pondera pelo TAMANHO DO CONTROLE,
    // e o estrato n=3 domina. Isso infla o delta. O estimador correto para
    // comparar populacoes com tamanhos diferentes e' a PADRONIZACAO pela
    // distribuicao das entradas:
    //
    //   delta_padronizado = sum_estrato ( (n_e / N_e) * (taxa_e - taxa_c) )
    //
    // Ambas as formulas sao gravadas, rotuladas, e nao se misturam.
    const strata = {};
    const allCtrl = [];
    for (const f of frames) {
      if (f.holding !== false) continue;
      const prior = priorSamples({ t: f.t, episode: f.episode }, w);
      allCtrl.push({ n: prior.samples.length, rose: prior.samples.length >= 2 && roseWithin(prior.samples) });
    }
    for (const el of eligibleEntries) {
      const n = el.samples.length;
      if (!strata[n]) strata[n] = { entries: 0, entriesRose: 0, controls: 0, controlsRose: 0 };
      strata[n].entries++;
      if (el.rose) strata[n].entriesRose++;
    }
    for (const c of allCtrl) {
      if (!strata[c.n]) strata[c.n] = { entries: 0, entriesRose: 0, controls: 0, controlsRose: 0 };
      strata[c.n].controls++;
      if (c.rose) strata[c.n].controlsRose++;
    }

    const strataTable = {};
    let stdDelta = 0;         // padronizado pela distribuicao das ENTRADAS
    let pnE = 0, pdE = 0, pnC = 0, pdC = 0;  // pooled
    for (const [k, v] of Object.entries(strata)) {
      strataTable[k] = {
        entries: v.entries,
        entriesRose: v.entriesRose,
        entriesRate: v.entries ? Number((v.entriesRose / v.entries).toFixed(4)) : null,
        controls: v.controls,
        controlsRose: v.controlsRose,
        controlsRate: v.controls ? Number((v.controlsRose / v.controls).toFixed(4)) : null,
      };
      if (v.entries > 0 && v.controls > 0) {
        const wEntry = v.entries / stats.denominatorTestable;
        stdDelta += wEntry * ((v.entriesRose / v.entries) - (v.controlsRose / v.controls));
        pnE += v.entriesRose; pdE += v.entries;
        pnC += v.controlsRose; pdC += v.controls;
      }
    }

    stats.stratified = {
      bySamples: strataTable,
      // estimador A: pooled (pondera pelo tamanho de cada grupo)
      pooled: {
        entriesRose: pnE, entriesDenom: pdE,
        entriesRate: pdE ? Number((pnE / pdE).toFixed(4)) : null,
        controlsRose: pnC, controlsDenom: pdC,
        controlsRate: pdC ? Number((pnC / pdC).toFixed(4)) : null,
        deltaPercentagePoints: (pdE && pdC)
          ? Number((((pnE / pdE) - (pnC / pdC)) * 100).toFixed(2)) : null,
        note: 'pondera pelo tamanho do grupo; estrato n=3 domina os controles',
      },
      // estimador B: padronizado pela distribuicao das ENTRADAS (correto)
      standardized: {
        formula: 'sum_estrato ( (n_entradas_estrato / N_entradas) * (taxa_entradas - taxa_controles) )',
        deltaPercentagePoints: Number((stdDelta * 100).toFixed(2)),
        weightsBasis: 'distribuicao das 155 entradas',
      },
      note: 'os dois estimadores NAO sao intercambiaveis; o padronizado e o',
    };

    // ── CONTAGEM DE ESTABILIDADE (duas definicoes, explicitas)
    //
    // Historico ESTAVEL tem duas leituras possiveis e elas diferem:
    //
    //   (A) apenas amostras ANTERIORES iguais entre si  -> 102
    //       CORRETO: o teste de historico usa so' o que vem ANTES.
    //
    //   (B) anteriores iguais MAIS o frame da transicao -> 68
    //       ERRADO para o teste: inclui o proprio evento que se quer prever.
    //
    // A diferenca 68 vs 102 era exatamente esta: a versao original contava
    // (B) e a revisada conta (A). Ambas ficam gravadas para auditoria.
    let stablePrevOnly = 0;    // (A)
    let stableIncludingEntry = 0; // (B)
    for (const el of eligibleEntries) {
      const e = el.entry;
      const p = el.samples;
      if (p.every(x => x.count === p[0].count)) stablePrevOnly++;
      const withEntry = [...p.map(x => x.count), e.countAtEntry];
      if (withEntry.every(x => x === withEntry[0])) stableIncludingEntry++;
    }
    stats.stability = {
      prevOnly: stablePrevOnly,
      includingEntry: stableIncludingEntry,
      note: 'prevOnly e o correto para o teste de historico; includingEntry'
        + ' conta o proprio frame da transicao e nao deve ser usado como predicado',
    };

    // ── EXCLUSAO CONTAVEL DO ESTRATO
    //
    // O estrato (bySamples) contem TODOS os frames de controle (23.473),
    // inclusive n=0 e n=1. O estimador pooled usa apenas estratos com
    // entries>0, o que deixa de fora os estratos n=7 e n=8 (que tem
    // controles mas nenhuma entrada). Isso explica a diferenca 20.348 vs
    // 20.334. Registrado explicitamente:
    stats.controlAccounting = {
      allControls: allCtrl.length,
      withAtLeast2: allCtrl.filter(c => c.n >= 2).length,
      inPooled: Object.entries(strata)
        .filter(([, v]) => v.entries > 0 && v.controls > 0)
        .reduce((a, [, v]) => a + v.controls, 0),
      excludedFromPooled: Object.entries(strata)
        .filter(([, v]) => v.entries === 0 && v.controls > 0)
        .map(([k, v]) => ({ samples: Number(k), controls: v.controls })),
      note: 'pooled so inclui estratos com pelo menos 1 entrada; estratos com'
        + ' controles e zero entradas ficam de fora (n=7 e n=8)',
    };

    report[w] = stats;

    // ── RESTRITO A COBERTURA COMPLETA (ambos os grupos)
    //
    // 155/155 tem >=2 amostras, mas so' 143/155 tem cobertura DESDE O INICIO
    // da janela (amostra em t <= entryT - window, mesmo episodio). Sem isso,
    // "ha pontos na janela" nao garante que o comeco foi observado.
    // Este bloco exige cobertura completa nas ENTRADAS e nos CONTROLES.
    const fullEntries = [];
    const fullControls = [];
    for (const e of entries) {
      const { samples, coveredFromStart } = priorSamples(e, w);
      if (samples.length >= 2 && coveredFromStart) {
        fullEntries.push({ n: samples.length, rose: roseWithin(samples) });
      }
    }
    for (const f of frames) {
      if (f.holding !== false) continue;
      const { samples, coveredFromStart } = priorSamples({ t: f.t, episode: f.episode }, w);
      if (samples.length >= 2 && coveredFromStart) {
        fullControls.push({ n: samples.length, rose: roseWithin(samples) });
      }
    }
    const fs_ = {};
    for (const e of fullEntries) { if (!fs_[e.n]) fs_[e.n] = { e: 0, er: 0, c: 0, cr: 0 }; fs_[e.n].e++; if (e.rose) fs_[e.n].er++; }
    for (const c of fullControls) { if (!fs_[c.n]) fs_[c.n] = { e: 0, er: 0, c: 0, cr: 0 }; fs_[c.n].c++; if (c.rose) fs_[c.n].cr++; }
    let fStd = 0;
    const fullTable = {};
    for (const [k, v] of Object.entries(fs_)) {
      fullTable[k] = { entries: v.e, entriesRose: v.er, controls: v.c, controlsRose: v.cr };
      if (v.e > 0 && v.c > 0) {
        fStd += (v.e / fullEntries.length) * ((v.er / v.e) - (v.cr / v.c));
      }
    }
    stats.fullCoverage = {
      entries: fullEntries.length,
      controls: fullControls.length,
      bySamples: fullTable,
      standardizedDeltaPercentagePoints: Number((fStd * 100).toFixed(2)),
      note: 'entradas E controles exigem >=2 amostras E cobertura desde o'
        + ' inicio da janela; padronizado pela distribuicao das entradas restantes',
    };
    // fecha o loop das janelas
  }

  // ── veredito de viabilidade
  const w600 = report[600];
  const viable = w600.denominatorTestable > 0 && w600.denominatorTestable >= 30;

  const out = {
    generatedAt: new Date().toISOString(),
    input: path.basename(input),
    definitions: {
      maxAgeMs: MAX_AGE_MS,
      entry: 'transicao observada false->true',
      excluded: 'o frame da propria transicao',
      sample: 'kind6 anterior no mesmo episodio E dentro da janela E com count valido',
      coveredFromStart: 'existe amostra valida em t <= (entryT - window) no mesmo episodio',
      rose: 'pelo menos um aumento entre amostras consecutivas validas na janela',
      testable: '>= 2 amostras anteriores validas na janela',
    },
    volume: { framesInLure: frames.length, episodes: episode + 1, entries: entries.length },
    windows: report,
    viability: {
      denominator600: w600.denominatorTestable,
      threshold: 30,
      viable,
      conclusion: viable
        ? 'ha cobertura suficiente para testar associacao na janela de 600 ms'
        : 'cobertura insuficiente: o teste de subida nao e viavel nesta amostra',
    },
  };

  fs.writeFileSync(path.join(OUTDIR, 'count-history.json'), JSON.stringify(out, null, 1));

  // ── saida legivel
  console.log('=== HISTORICO DE `count` ANTES DA ENTRADA EM PARADA ===\n');
  console.log(`frames em lure : ${out.volume.framesInLure}`);
  console.log(`episodios      : ${out.volume.episodes}`);
  console.log(`entradas false->true : ${out.volume.entries}\n`);

  console.log('COBERTURA por janela (amostras anteriores validas):');
  console.log('  janela   n    prev0   prev1   prev2+   desdeInicio   noLimite');
  for (const w of WINDOWS) {
    const s = report[w];
    console.log(`  ${String(w).padStart(4)}ms  ${String(s.entries).padStart(4)}`
      + `  ${String(s.prev0).padStart(6)}  ${String(s.prev1).padStart(6)}`
      + `  ${String(s.prev2plus).padStart(7)}  ${String(s.coveredFromStart).padStart(12)}`
      + `  ${String(s.atBoundaryCount).padStart(9)}`);
  }

  console.log('\nTESTE "count subiu antes da parada" (so\' onde ha >=2 amostras):');
  for (const w of WINDOWS) {
    const s = report[w];
    if (s.denominatorTestable === 0) {
      console.log(`  ${w}ms: SEM DENOMINADOR (nenhuma entrada com >=2 amostras anteriores)`);
      continue;
    }
    console.log(`  ${w}ms: parada ${s.rose}/${s.denominatorTestable} = ${(s.roseRate * 100).toFixed(1)}%`
      + `  | controle ${s.control.rose}/${s.control.denominator} = ${
        s.control.roseRate == null ? 'n/a' : (s.control.roseRate * 100).toFixed(1) + '%'}`
      + `  | delta ${s.deltaPercentagePoints == null ? 'n/a' : s.deltaPercentagePoints + ' p.p.'}`);
  }

  console.log(`\nVIABILIDADE: ${out.viability.conclusion}`);
  console.log(`  denominador 600ms = ${out.viability.denominator600} (limiar ${out.viability.threshold})`);
  console.log(`\nEscrito: analysis/lure-stop-rule/count-history.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
