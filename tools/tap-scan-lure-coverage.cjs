'use strict';

/**
 * Varre uma captura grande do tap e extrai as JANELAS uteis para avaliar o lure.
 *
 *   node tools/tap-scan-lure-coverage.cjs --in native/pka_tap_17748.jsonl
 *   node tools/tap-scan-lure-coverage.cjs --in <tap> --extract out.jsonl
 *   node tools/tap-scan-lure-coverage.cjs --in <tap> --from-t 50000000
 *
 * READ-ONLY no original. Nao toca no jogo, no cliente, nos taps.
 *
 * POR QUE EXISTE: o tap grava continuamente por horas. Em vez de rodar o bot
 * de novo num lugar especifico, varremos o que ja' existe e recortamos apenas
 * os trechos onde a avaliacao e' possivel:
 *
 *     lure dynamic ATIVO  +  kind5 com position  +  creatures com type=1
 *
 * O resultado e' (a) um relatorio de cobertura e (b) opcionalmente um JSONL
 * pequeno com apenas esses trechos, que pode ser analisado offline sem
 * carregar 2,7 GB.
 *
 * CRITERIO DE "JANELA UTIL": existe ao menos um kind6 em lure dynamic cujo
 * kind5 anterior (<= MAX_SAMPLE_AGE_MS) tem position E pelo menos um
 * creature com type===1.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const MAX_SAMPLE_AGE_MS = 1500;

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const input = String(arg('--in', ''));
if (!input || !fs.existsSync(input)) { console.error('faltou --in <tap.jsonl>'); process.exit(2); }
const extract = arg('--extract', null);
const fromT = Number(arg('--from-t', 0));
const toT = Number(arg('--to-t', Number.MAX_SAFE_INTEGER));
const MAX_GAP_MS = Number(arg('--episode-gap', 600)); // corte de episodio de lure

const sizeMB = (fs.statSync(input).size / 1048576).toFixed(0);

function main() {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(input, { highWaterMark: 1 << 22 }),
      crlfDelay: Infinity,
    });

    const out = extract ? fs.createWriteStream(String(extract), { flags: 'w' }) : null;

    let scanned = 0;
    let k5Total = 0, k5Pos = 0, k5Wild = 0;
    let k6Total = 0, k6Lure = 0;

    // cobertura: kind6 em lure com amostra valida
    let coveredPos = 0, coveredWild = 0;

    // estado
    let lastK5 = null;            // ultimo kind5 com position
    let ep = -1, lastLureT = null, prevWasLure = false;
    let lastK6 = null;

    // janelas uteis: trechos contiguos com cobertura
    const windows = [];
    let curWindow = null;

    // para extracao: marcamos linhas de um intervalo que contenha janela util.
    // Estrategia simples: buffer circular das ultimas N linhas e, ao fechar uma
    // janela, gravar [inicio-janela, fim-janela]. Para nao segurar a captura
    // inteira, gravamos *em streaming* sempre que estivermos dentro de uma
    // janela util (com margem de 2 s antes).
    const MARGIN_MS = 2000;
    let insideSince = null;   // t a partir do qual estamos gravando

    const sinceStats = { firstT: null, lastT: null };

    rl.on('line', (line) => {
      scanned++;
      // filtro barato: so' linhas 4/5/6 interessam
      if (!line.includes('"kind":')) return;

      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.t < fromT || o.t > toT) return;

      if (sinceStats.firstT == null) sinceStats.firstT = o.t;
      sinceStats.lastT = o.t;

      // ── kind5: telemetria espacial
      if (o.kind === 5) {
        k5Total++;
        if (!o.d) return;
        let t;
        try { t = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { return; }
        if (!t.position) return;
        k5Pos++;
        const wilds = (t.creatures || []).filter(c => Number(c.type) === 1);
        if (wilds.length) k5Wild++;
        lastK5 = {
          t: o.t,
          position: t.position,
          wildCount: wilds.length,
          creatures: t.creatures || [],
          ownSummonId: t.ownSummonId,
        };
        return;
      }

      // ── kind6: estado de decisao
      if (o.kind === 6) {
        k6Total++;
        if (!o.d) return;
        let b;
        try { b = JSON.parse(Buffer.from(o.d, 'hex').toString('utf8')); } catch { return; }
        const lu = b.luring || {};
        const isLure = lu.mode === 'dynamic' && b.paused !== true;

        if (!isLure) {
          prevWasLure = false; lastLureT = null;
          if (curWindow) { windows.push(curWindow); curWindow = null; }
          if (out && insideSince != null) { insideSince = null; }
          return;
        }

        k6Lure++;
        const newEp = !prevWasLure || lastLureT == null || (o.t - lastLureT) > MAX_GAP_MS;
        if (newEp) ep++;
        prevWasLure = true; lastLureT = o.t;

        // amostra valida?
        const age = lastK5 ? (o.t - lastK5.t) : Infinity;
        const hasPos = Number.isFinite(age) && age >= 0 && age <= MAX_SAMPLE_AGE_MS;
        const hasWild = hasPos && lastK5.wildCount > 0;

        if (hasPos) coveredPos++;
        if (hasWild) {
          coveredWild++;
          if (!curWindow) curWindow = { tStart: o.t, tEnd: o.t, frames: 0, episode: ep, wildMax: 0 };
          curWindow.tEnd = o.t;
          curWindow.frames++;
          curWindow.wildMax = Math.max(curWindow.wildMax, lastK5.wildCount);

          if (out) {
            // grava a partir de (tStart - MARGIN) em streaming
            if (insideSince == null) insideSince = o.t - MARGIN_MS;
            out.write(line);
          }
        } else if (curWindow) {
          windows.push(curWindow); curWindow = null;
        }
        lastK6 = o.t;
        return;
      }

      // ── outras linhas: se estamos dentro de janela util e extraindo, grava
      if (out && insideSince != null && typeof o.t === 'number' && o.t >= insideSince) {
        out.write(line);
      }
    });

    rl.on('close', () => {
      if (curWindow) windows.push(curWindow);
      if (out) out.end();

      const total = windows.length;
      const dur = windows.map(w => w.tEnd - w.tStart);
      const usable = windows.filter(w => w.frames >= 2);

      const report = {
        file: path.basename(input),
        sizeMB: Number(sizeMB),
        scannedLines: scanned,
        timeRange: { from: fromT || null, to: toT === Number.MAX_SAFE_INTEGER ? null : toT,
          firstT: sinceStats.firstT, lastT: sinceStats.lastT },
        counts: { kind5: k5Total, kind5WithPosition: k5Pos, kind5WithWild: k5Wild,
          kind6: k6Total, kind6InLure: k6Lure },
        coverage: {
          kind6InLureWithSample: coveredPos,
          kind6InLureWithWild: coveredWild,
          ratePos: k6Lure ? Number((coveredPos / k6Lure).toFixed(4)) : null,
          rateWild: k6Lure ? Number((coveredWild / k6Lure).toFixed(4)) : null,
          note: 'rateWild e o numero que a previa precisa > 0',
        },
        windows: {
          total,
          withAtLeast2Frames: usable.length,
          durationMs: {
            median: dur.length ? dur.slice().sort((a, b) => a - b)[Math.floor(dur.length / 2)] : null,
            max: dur.length ? Math.max(...dur) : null,
            total: dur.reduce((a, b) => a + b, 0),
          },
          top: windows.slice().sort((a, b) => b.frames - a.frames).slice(0, 10)
            .map(w => ({ episode: w.episode, tStart: w.tStart, tEnd: w.tEnd,
              durationMs: w.tEnd - w.tStart, frames: w.frames, wildMax: w.wildMax })),
        },
      };

      const outJson = path.join(path.dirname(input), '..', 'analysis', 'lure-stop-rule',
        'scan-' + path.basename(input).replace(/\.jsonl$/, '') + '.json');
      try {
        fs.mkdirSync(path.dirname(outJson), { recursive: true });
        fs.writeFileSync(outJson, JSON.stringify(report, null, 1));
      } catch { /* ignore */ }

      console.log('=== SCAN DE COBERTURA DO LURE ===\n');
      console.log(`arquivo     : ${report.file} (${report.sizeMB} MB)`);
      console.log(`linhas lidas: ${scanned}`);
      if (report.timeRange.firstT) {
        const span = (report.timeRange.lastT - report.timeRange.firstT) / 60000;
        console.log(`janela      : t=${report.timeRange.firstT}..${report.timeRange.lastT} (${span.toFixed(1)} min)`);
      }
      console.log('');
      console.log('--- TELEMETRIA (kind5)');
      console.log(`  total              : ${k5Total}`);
      console.log(`  com position       : ${k5Pos}`);
      console.log(`  com selvagem (t=1) : ${k5Wild}`);
      console.log('');
      console.log('--- DECISAO (kind6)');
      console.log(`  total              : ${k6Total}`);
      console.log(`  em lure dynamic    : ${k6Lure}`);
      console.log(`  com amostra (<=1500ms): ${coveredPos}`);
      console.log(`  com amostra E selvagem: ${coveredWild}`);
      if (k6Lure) {
        console.log(`  taxa position      : ${(coveredPos / k6Lure * 100).toFixed(2)}%`);
        console.log(`  taxa selvagem      : ${(coveredWild / k6Lure * 100).toFixed(2)}%`);
      }
      console.log('');
      console.log('--- JANELAS UTEIS');
      console.log(`  total              : ${total}`);
      console.log(`  com >=2 frames     : ${usable.length}`);
      if (report.windows.durationMs.total) {
        console.log(`  duracao total      : ${(report.windows.durationMs.total / 1000).toFixed(1)} s`);
        console.log(`  duracao mediana    : ${report.windows.durationMs.median} ms`);
      }
      if (windows.length) {
        console.log('  top 5 (por frames):');
        for (const w of report.windows.top.slice(0, 5)) {
          console.log(`    ep=${w.episode} t=${w.tStart}..${w.tEnd} ${w.frames}f ${w.durationMs}ms wildMax=${w.wildMax}`);
        }
      }
      console.log('');
      const verdict = coveredWild === 0
        ? 'VEREDITO: nenhum frame com selvagem durante o lure. Nao gravar o piloto ainda.'
        : usable.length === 0
          ? 'VEREDITO: selvagem confirmado, mas sem janela de >=2 frames. Publicacao ok, cobertura insuficiente.'
          : `VEREDITO: ${usable.length} janela(s) utilizavel(is). Pode extrair e avaliar.`;
      console.log(verdict);
      if (out) console.log(`\nExtraido para: ${extract}`);
      console.log(`Relatorio     : ${outJson}`);
      resolve(report);
    });

    rl.on('error', reject);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
