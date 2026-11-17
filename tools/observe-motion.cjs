#!/usr/bin/env node
'use strict';

/**
 * Coleta posicao real + holding usando NOSSA DLL.
 *
 *   node tools/observe-motion.cjs --pid 1712 --seconds 120
 *   node tools/observe-motion.cjs --pid 1712 --seconds 120 --hz 20
 *
 * POR QUE ESTE CAMINHO (e nao RPM):
 *   O objetivo do projeto e' o nosso bot — a DLL injetada e' o produto. Ler a
 *   memoria de fora (RPM) resolve a medicao mas nao exercita o produto.
 *   Aqui a posicao vem do canal nativo (`kind 5`, campo position), publicado
 *   pela nossa pka_native.dll. Isso:
 *     - testa o caminho que vai ser usado em producao
 *     - usa o MESMO relogio do kind6 (GetTickCount do processo do jogo)
 *     - nao precisa de permissao de leitura externa
 *
 *   A cadencia e' controlada por `native/pka_observe_hz.txt` (lido pela DLL).
 *   Este script escreve esse arquivo antes de comecar.
 *
 * SAIDA
 *   <out>.positions.jsonl  -> {"t":..,"x":..,"y":..,"z":..}   (NOSSA DLL, kind5)
 *   <out>.summary.json
 *
 * SOBRE `holding`:
 *   `holding` e' conceito do Shiba, publicado no kind6 dele. Nossa DLL nao
 *   publica esse campo. Para comparar, use o tap do Shiba em paralelo e rode
 *   tools/holding_vs_motion.py com:
 *
 *       --kind6    <tap do Shiba, filtrado na mesma janela>
 *       --position <out>.positions.jsonl
 *
 *   Os dois relogios sao GetTickCount do sistema, entao alinham direto.
 *
 * READ-ONLY no jogo: so' conecta no pipe e escuta. Nao envia comando.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }
const seconds = Number(arg('--seconds', 60));
const hz = Number(arg('--hz', 20));
const outBase = String(arg('--out', path.join(ROOT, 'captures', 'motion', `observe-${pid}`)));
/** Sequencia de caminhada: "1,1,1,3,3,3" — cada item e' uma direcao 0..7. */
const walkSeq = String(arg('--walk', '')).split(',')
  .map(s => s.trim()).filter(Boolean).map(Number)
  .filter(d => Number.isInteger(d) && d >= 0 && d <= 7);
/** Intervalo entre passos da sequencia (ms). */
const walkStepMs = Number(arg('--walk-step-ms', 1200));

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
const nativeKeyFile = path.join(ROOT, 'native', 'pka_channel_key.txt');

function resolveKey() {
  if (fs.existsSync(keyFile)) {
    try { return JSON.parse(fs.readFileSync(keyFile, 'utf8')).key; } catch { /* segue */ }
  }
  if (fs.existsSync(nativeKeyFile)) {
    const k = fs.readFileSync(nativeKeyFile, 'utf8').trim();
    if (k) {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, JSON.stringify({
        capturedAt: new Date().toISOString(), pid, key: k, source: 'native-file',
      }, null, 1));
      return k;
    }
  }
  return null;
}

/** Escreve a cadencia para a DLL ler. Ela recarrega 1x/s. */
function setObserveHz(value) {
  const target = path.join(ROOT, 'native', 'pka_observe_hz.txt');
  try {
    fs.writeFileSync(target, String(value));
    return target;
  } catch (e) {
    console.error('nao consegui escrever ' + target + ': ' + e.message);
    return null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const key = resolveKey();
  if (!key) {
    console.error('sem chave do canal. Rode a injecao primeiro (native/pka_channel_key.txt).');
    process.exit(2);
  }

  const hzFile = setObserveHz(hz);
  if (hzFile) console.log(`cadencia: ${hz} Hz (${hzFile})`);

  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const posPath = outBase + '.positions.jsonl';
  const posOut = fs.createWriteStream(posPath, { flags: 'w' });

  const t = new NativeTransport({ pid, key });
  let lastPos = null;
  let telemetryCount = 0;
  let withPosition = 0;
  let xyChanges = 0;
  let tFirst = null, tLast = null;
  const gaps = [];
  // A primeira telemetria chega depois do handshake (~3 s). O gap inicial nao
  // e' cadencia — e' conexao. So' comeca a medir depois de 2 amostras boas.
  let warmup = 0;

  t.on('telemetry', v => {
    telemetryCount++;
    const now = Date.now();
    const pos = v && v.position;
    if (pos && Number.isInteger(pos.x) && Number.isInteger(pos.y)) {
      withPosition++;
      // `t` local em ms epoch. O alinhamento com kind6 do Shiba e' por ordem
      // e por offset constante (GetTickCount dos dois lados e' o mesmo relogio
      // do sistema quando comparado com o tap do mesmo boot).
      const rec = { t: now, x: pos.x, y: pos.y, z: pos.z,
        tick: Number.isFinite(v.tick) ? v.tick : null };
      posOut.write(JSON.stringify(rec) + '\n');
      if (warmup < 2) { warmup++; lastPos = { t: now, x: pos.x, y: pos.y, z: pos.z }; return; }
      if (lastPos) {
        if (pos.x !== lastPos.x || pos.y !== lastPos.y) xyChanges++;
        const d = now - lastPos.t;
        if (d > 0) gaps.push(d);
      }
      lastPos = { t: now, x: pos.x, y: pos.y, z: pos.z };
      if (tFirst == null) tFirst = now;
      tLast = now;
    }
  });

  t.on('state', () => {
    // `kind 4` do NOSSO protocolo nao carrega `holding` (campo do Shiba).
    // Existe apenas para atualizar online/HP; nada a gravar aqui.
  });

  await t.connect();
  console.log(`conectado. coletando ${seconds}s...`);

  // Movimento dirigido na MESMA sessao. Sem isso, um walk disparado por outro
  // processo/shell nao cai na janela de coleta (era o bug do Start-Job).
  let walked = 0;
  if (walkSeq.length) {
    console.log(`sequencia: ${walkSeq.join(',')} a cada ${walkStepMs} ms`);
    (async () => {
      for (const dir of walkSeq) {
        try {
          const ack = await t.sendCommand('walk', dir);
          if (ack && ack.status === 0) walked++;
        } catch { /* o resumo mostrara walked menor */ }
        await sleep(walkStepMs);
      }
    })();
  }

  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    await sleep(500);
    if (telemetryCount > 0 && withPosition === 0 && Date.now() > deadline - seconds * 1000 + 5000) {
      console.error('AVISO: telemetria chegando sem position. A DLL carregada e a antiga?');
    }
  }

  t.close();
  posOut.end();
  await sleep(300);

  const sortedGaps = gaps.slice().sort((a, b) => a - b);
  const q = p => (sortedGaps.length ? sortedGaps[Math.min(sortedGaps.length - 1,
    Math.floor(sortedGaps.length * p))] : null);

  const summary = {
    pid, requestedHz: hz, requestedSeconds: seconds,
    files: { positions: posPath },
    telemetryFrames: telemetryCount,
    withPosition,
    ratePosition: telemetryCount ? +(withPosition / telemetryCount).toFixed(3) : null,
    xyChanges,
    walked,
    spanMs: tFirst && tLast ? tLast - tFirst : 0,
    gapMs: { median: q(0.5), p90: q(0.9), max: sortedGaps.length ? sortedGaps[sortedGaps.length - 1] : null },
  };
  fs.writeFileSync(outBase + '.summary.json', JSON.stringify(summary, null, 2));

  console.log('\n=== RESUMO ===');
  console.log(JSON.stringify(summary, null, 2));

  if (withPosition === 0) {
    console.error('\nNENHUMA amostra com position. Verifique se a DLL carregada inclui');
    console.error('o campo position no kind 5 e se pka_observe_hz.txt existe.');
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
