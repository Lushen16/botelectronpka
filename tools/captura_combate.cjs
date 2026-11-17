'use strict';

/**
 * Captura de combate do Shiba, com validacao em TEMPO REAL.
 *
 *   node tools/captura_combate.cjs --tag hunt1
 *   node tools/captura_combate.cjs --tag hunt1 --seconds 300
 *   node tools/captura_combate.cjs --status          # so' le a captura atual
 *
 * POR QUE ESTE SCRIPT E NAO O tap_session
 *
 * As cinco capturas que temos NAO TEM SELVAGEM (verificado: maximo 2 criaturas
 * por frame, tipos 0 e 3). Sem `creatures[type=1]`, nao ha como medir a
 * distancia que o Shiba mantem, a box, nem o movimento do Pokemon — que e'
 * exatamente o que falta para fechar o combate.
 *
 * Este script resolve o problema de processo: injeta o tap, abre um relatorio
 * AO VIVO e avisa quando a captura comecar a conter selvagem. Voce sabe na
 * hora se a hunt esta valendo, em vez de descobrir depois de 5 minutos.
 *
 * O QUE ELE NAO FAZ: nao injeta o pka_native.dll. Regra do AGENTS.md — as duas
 * DLLs juntas brigam pelo pipe. Aqui e' so' o tap (passivo).
 *
 * FLUXO
 *   1. fecha o jogo e o menu do Shiba
 *   2. node tools/captura_combate.cjs --tag hunt1
 *      - injeta o tap no proceso do jogo (e no menu, se aberto)
 *      - abre o monitor ao vivo
 *   3. abra o launcher do Shiba e clique ENTRAR
 *      - rode de novo: node tools/captura_combate.cjs --tag hunt1 --menu
 *      - isso tapa o menu Electron tambem (a metade c2s da conversa)
 *   4. no jogo: va' para a hunt e ligue o bot deles (Target + Walker)
 *   5. deixe uma lure completa acontecer (minCount selvagens, combo)
 *   6. Ctrl+C no monitor — ele imprime o veredito do que foi capturado
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const CAPTURES = path.join(ROOT, 'captures');
const INJECTOR = path.join(NATIVE, 'pka_inject.exe');
const GAME = 'PokeAlliance_dx.exe';

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const tag = String(arg('--tag', 'combate')).replace(/[^\w.-]/gu, '_');
const segundos = Number(arg('--seconds', 0)) || Infinity;
const soStatus = process.argv.includes('--status');
const taparMenu = process.argv.includes('--menu');
const pidForcado = Number(arg('--pid', 0)) || null;

/* ───────── descoberta ───────── */

function ps(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true }).trim();
  } catch { return ''; }
}

function acharJogo() {
  const out = ps(`(Get-Process ${GAME.replace('.exe', '')} -ErrorAction SilentlyContinue | ` +
    `Select-Object -First 1 -ExpandProperty Id)`);
  const pid = Number(out);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function acharMenu(gamePid) {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | ` +
    `Where-Object { $_.CommandLine -match '--client-pid=${gamePid}' } | ` +
    `Select-Object -First 1 -ExpandProperty ProcessId`);
  const pid = Number(out);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function arquivoTapDo(pid) {
  const candidatos = [
    path.join(CAPTURES, `tap-game-${pid}.jsonl`),
    path.join(CAPTURES, `tap-menu-${pid}.jsonl`),
    path.join(NATIVE, `pka_tap_${pid}.jsonl`),
    path.join(os.tmpdir(), `pka_tap_${pid}.jsonl`),
  ];
  return candidatos.find(f => fs.existsSync(f)) || null;
}

function injetar(pid, saida, rotulo) {
  const dll = path.join(NATIVE, 'pka_tap.dll');
  const nova = path.join(NATIVE, 'pka_tap_new.dll');
  const alvo = fs.existsSync(nova) && fs.statSync(nova).mtimeMs > fs.statSync(dll).mtimeMs ? nova : dll;
  if (!fs.existsSync(INJECTOR)) throw Error('sem pka_inject.exe — rode: node tools/build_native.cjs');
  if (!fs.existsSync(alvo)) throw Error('sem pka_tap.dll — rode: node tools/build_native.cjs');

  const staged = path.join(NATIVE, `staged_cap_${pid}_${Date.now()}.dll`);
  fs.copyFileSync(alvo, staged);
  try {
    const out = execFileSync(INJECTOR, ['--pid', String(pid), '--dll', staged], {
      env: { ...process.env, PKA_TAP_OUT: saida, PKA_TAP_ALL: '1' },
      encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    console.log(`  ${rotulo}: ${out.trim().split('\n').pop()}`);
  } finally {
    setTimeout(() => { try { fs.unlinkSync(staged); } catch {} }, 800).unref?.();
  }
}

/* ───────── monitor ao vivo ───────── */

const vivo = {
  linhas: 0, k5: 0, k6: 0, k11: 0,
  k5ComPos: 0, k5ComPoke: 0, k5ComSelvagem: 0,
  maxSelvagem: 0,
  fases: new Map(),      // fase -> frames
  dist: [],              // distancias Pokemon->selvagem mais proximo
  box3: [],              // quantos ate 3 tiles do Pokemon
  distPokeJogador: [],
  comboTexto: new Map(), // textos de talk/combo
  ultimoAviso: 0,
};

function distancia(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs((a.z ?? 0) - (b.z ?? 0)));
}

function lerK5(j) {
  vivo.k5++;
  if (!j.position) return;
  vivo.k5ComPos++;
  const cre = Array.isArray(j.creatures) ? j.creatures : [];
  const poke = cre.find(c => c && c.type === 3 && c.pos);
  const selv = cre.filter(c => c && c.type === 1 && c.healthPercent > 0 && c.pos);
  if (poke) vivo.k5ComPoke++;
  if (!selv.length) return;
  vivo.k5ComSelvagem++;
  if (selv.length > vivo.maxSelvagem) vivo.maxSelvagem = selv.length;
  if (!poke) return;

  const ds = selv.map(c => distancia(poke.pos, c.pos));
  vivo.dist.push(Math.min(...ds));
  vivo.box3.push(ds.filter(d => d <= 3).length);
  vivo.distPokeJogador.push(distancia(j.position, poke.pos));
}

function lerK6(j) {
  vivo.k6++;
  const l = j.luring;
  if (l && l.phase) vivo.fases.set(l.phase, (vivo.fases.get(l.phase) || 0) + 1);
}

function lerK11(j) {
  vivo.k11++;
  const chave = `${j.op}/${j.module || '-'}`;
  vivo.comboTexto.set(chave, (vivo.comboTexto.get(chave) || 0) + 1);
}

/**
 * Le os arquivos ate' o fim (ou ate' `limite`) e RETORNA.
 *
 * Separado do monitor ao vivo de proposito: o `--status` precisa terminar.
 * Antes as duas coisas usavam a mesma funcao, que abre um setInterval e um
 * handler de SIGINT — ela nunca retornava, e o `--status` travava.
 */
async function lerArquivos(arquivos, limite = Infinity) {
  for (const f of arquivos) {
    if (vivo.linhas >= limite) break;
    const rl = readline.createInterface({
      input: fs.createReadStream(f, { highWaterMark: 1 << 20 }),
      crlfDelay: Infinity,
    });
    for await (const linha of rl) {
      vivo.linhas++;
      if (vivo.linhas > limite) { rl.close(); break; }
      if (!linha.includes('"kind":')) continue;
      const mKind = linha.match(/"kind":(\d+)/);
      if (!mKind) continue;
      const k = mKind[1];
      if (k !== '5' && k !== '6' && k !== '11') continue;
      const mData = linha.match(/"d":"([0-9a-f]+)"/);
      if (!mData) continue;
      let j;
      try { j = JSON.parse(Buffer.from(mData[1], 'hex').toString('utf8')); } catch { continue; }
      if (k === '5') lerK5(j);
      else if (k === '6') lerK6(j);
      else lerK11(j);
    }
  }
}

/** Monitor ao vivo: le em paralelo e imprime painel ate' Ctrl+C ou `segundos`. */
async function monitorar(arquivos) {
  const streams = [];
  for (const f of arquivos) {
    const rl = readline.createInterface({ input: fs.createReadStream(f, { highWaterMark: 1 << 20 }), crlfDelay: Infinity });
    streams.push(rl);
    rl.on('line', linha => {
      vivo.linhas++;
      if (!linha.includes('"kind":')) return;
      const mKind = linha.match(/"kind":(\d+)/);
      const mData = linha.match(/"d":"([0-9a-f]+)"/);
      if (!mKind || !mData) return;
      let j;
      try { j = JSON.parse(Buffer.from(mData[1], 'hex').toString('utf8')); } catch { return; }
      const k = mKind[1];
      if (k === '5') lerK5(j);
      else if (k === '6') lerK6(j);
      else if (k === '11') lerK11(j);
    });
  }

  /* painel de 3 s: mostra se a captura esta servindo */
  const painel = setInterval(() => {
    const med = vivo.dist.length ? vivo.dist.slice(-500).sort((a, b) => a - b)[Math.floor(Math.min(499, vivo.dist.length - 1) * 0.5)] : null;
    const pronto = vivo.k5ComSelvagem > 0;
    const marca = pronto ? 'CAPTURANDO COMBATE' : 'sem selvagem ainda';
    process.stdout.write(
      `\r[${marca}] k5=${vivo.k5} (selvagem ${vivo.k5ComSelvagem}) k6=${vivo.k6} k11=${vivo.k11}` +
      ` | max selv=${vivo.maxSelvagem} | dist med=${med ?? '-'}   `);
    /* aviso unico: se passou muito tempo sem selvagem, o usuario esta no lugar errado */
    const agora = Date.now();
    if (!pronto && vivo.linhas > 20000 && agora - vivo.ultimoAviso > 60000) {
      vivo.ultimoAviso = agora;
      process.stdout.write('\n  [!] Nenhum selvagem capturado. Va\' para a hunt e ligue o Target.\n');
    }
  }, 3000);

  const parar = () => {
    clearInterval(painel);
    for (const s of streams) s.close();
    console.log('\n');
    veredito();
    process.exit(0);
  };
  process.on('SIGINT', parar);
  process.on('SIGTERM', parar);

  if (Number.isFinite(segundos)) setTimeout(parar, segundos * 1000);
}

/* ───────── veredito ───────── */

function veredito() {
  const q = (a, p) => {
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
  };
  const f = v => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

  console.log('══════════════════════════════════════════════════════');
  console.log(' VEREDITO DA CAPTURA');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  linhas          ${vivo.linhas}`);
  console.log(`  kind5           ${vivo.k5}   (com position: ${vivo.k5ComPos})`);
  console.log(`  kind6           ${vivo.k6}`);
  console.log(`  kind11          ${vivo.k11}`);
  console.log('');
  console.log(`  k5 com Pokemon  ${vivo.k5ComPoke}`);
  console.log(`  k5 com selvagem ${vivo.k5ComSelvagem}   <<< O QUE IMPORTA`);
  console.log(`  máximo de selvagens num frame: ${vivo.maxSelvagem}`);

  if (!vivo.k5ComSelvagem) {
    console.log('');
    console.log('  FALHOU: nenhum frame com selvagem. Sem isso nao da para medir');
    console.log('  distancia, box nem movimento do Pokemon.');
    console.log('  O que fazer: entre na hunt, ligue o Target do Shiba e deixe');
    console.log('  uma lure acontecer. Depois rode --status para conferir.');
    return;
  }

  console.log('');
  console.log('  DISTANCIA Pokemon -> selvagem mais proximo (Chebyshev)');
  console.log(`    n=${vivo.dist.length}  min=${Math.min(...vivo.dist)}  p10=${f(q(vivo.dist, 0.1))}` +
    `  mediana=${f(q(vivo.dist, 0.5))}  p90=${f(q(vivo.dist, 0.9))}  max=${Math.max(...vivo.dist)}`);
  console.log('');
  console.log('  BOX: selvagens ate 3 tiles do Pokemon');
  console.log(`    mediana=${f(q(vivo.box3, 0.5))}  p90=${f(q(vivo.box3, 0.9))}  max=${Math.max(...vivo.box3)}`);
  console.log('');
  console.log('  DISTANCIA jogador -> Pokemon');
  console.log(`    mediana=${f(q(vivo.distPokeJogador, 0.5))}  p90=${f(q(vivo.distPokeJogador, 0.9))}`);
  console.log('');
  console.log('  FASES DA LURE (frames)');
  for (const [fase, n] of [...vivo.fases].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${fase.padEnd(12)} ${n}`);
  }
  if (vivo.k11) {
    console.log('');
    console.log('  COMANDOS kind11 (menu -> runtime)');
    for (const [k, n] of vivo.comboTexto) console.log(`    ${k.padEnd(24)} ${n}`);
  }
  console.log('');
  console.log('  Agora rode o analisador completo:');
  console.log('    node tools/analise_combate_shiba.cjs --tap <arquivo>');
}

/* ───────── status de uma captura já em disco ───────── */

async function status() {
  /* Capturas vivem em dois lugares: `captures/` (sessoes deste script) e
   * `native/` (sessoes do tap_session e capturas antigas). Procurar nos dois
   * evita o "nenhuma captura" que nao reflete a realidade do disco.
   *
   * LIMITE: as capturas antigas somam 6,7 GB e ler tudo leva minutos. Por
   * padrao le apenas `captures/` + o arquivo mais recente de `native/`, com
   * teto de linhas. Use `--tap <arquivo> --max N` para analisar uma especifica. */
  const alvoExplicito = arg('--tap');
  const maxLinhas = Number(arg('--max', 0)) || 400000;

  let arquivos = [];
  if (alvoExplicito) {
    if (!fs.existsSync(alvoExplicito)) { console.log('nao existe: ' + alvoExplicito); return; }
    arquivos = [alvoExplicito];
  } else {
    for (const dir of [CAPTURES, NATIVE]) {
      if (!fs.existsSync(dir)) continue;
      const doDir = fs.readdirSync(dir)
        .filter(nome => /^(tap-.*|pka_tap_\d+)\.jsonl$/u.test(nome) && !nome.includes('_old'))
        .map(nome => path.join(dir, nome))
        .filter(f => fs.statSync(f).size > 0)
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      /* captures/ inteiro; native/ so' o mais recente */
      arquivos.push(...(dir === CAPTURES ? doDir : doDir.slice(0, 1)));
    }
  }
  if (!arquivos.length) {
    console.log('nenhuma captura encontrada em captures/ nem native/');
    console.log('rode: node tools/captura_combate.cjs --tag hunt1');
    return;
  }
  console.log('lendo ' + arquivos.length + ' arquivo(s), teto ' + maxLinhas + ' linhas:');
  for (const f of arquivos) {
    console.log(`  ${path.basename(f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
  }
  console.log('');
  await lerArquivos(arquivos, maxLinhas);
  veredito();
}

/* ───────── principal ───────── */

(async () => {
  if (soStatus) { await status(); return; }

  console.log('═══ CAPTURA DE COMBATE ═══\n');
  console.log('Regras:');
  console.log('  - NAO injeta pka_native.dll junto (briga pelo pipe)');
  console.log('  - tap e passivo: nao altera o jogo\n');

  fs.mkdirSync(CAPTURES, { recursive: true });

  const pid = pidForcado || acharJogo();
  if (!pid) {
    console.error(`${GAME} nao esta rodando.`);
    console.error('Abra o jogo primeiro, ou use --pid <n>.');
    process.exit(2);
  }
  console.log('jogo: pid ' + pid);

  const saidaJogo = path.join(CAPTURES, `tap-game-${pid}.jsonl`);
  const jaExiste = fs.existsSync(saidaJogo) && fs.statSync(saidaJogo).size > 0;
  if (jaExiste) {
    console.log(`  já existe captura (${(fs.statSync(saidaJogo).size / 1048576).toFixed(1)} MB) — continuando nela`);
  } else {
    injetar(pid, saidaJogo, 'tap no jogo');
  }

  if (taparMenu) {
    const menuPid = acharMenu(pid);
    if (menuPid) {
      const saidaMenu = path.join(CAPTURES, `tap-menu-${menuPid}.jsonl`);
      injetar(menuPid, saidaMenu, 'tap no menu');
    } else {
      console.log('  menu do Shiba nao encontrado — abra o launcher e rode de novo com --menu');
    }
  } else {
    console.log('  (use --menu depois de abrir o launcher do Shiba, para tapar o menu tambem)');
  }

  const arquivos = [saidaJogo];
  if (taparMenu) {
    const menuPid = acharMenu(pid);
    if (menuPid) arquivos.push(path.join(CAPTURES, `tap-menu-${menuPid}.jsonl`));
  }
  const existentes = arquivos.filter(f => fs.existsSync(f));

  console.log('\nmonitorando. AGORA:');
  console.log('  1. entre no mundo');
  console.log('  2. va\' para a hunt (com monstros visiveis)');
  console.log('  3. ligue o Target/Walker do Shiba');
  console.log('  4. deixe uma lure completa acontecer');
  console.log('\nCtrl+C quando terminar.\n');

  await monitorar(existentes);
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
