'use strict';

/**
 * Validacao da fatia de caminhada no cliente REAL.
 *
 *   node tools/live_walk_validate.cjs --pid <PID> [--direction north] [--steps 1]
 *   node tools/live_walk_validate.cjs --pid <PID> --test=A    # so' dispatcher
 *   node tools/live_walk_validate.cjs --pid <PID> --test=B    # WalkerEngine
 *
 * Dois testes SEPARADOS, porque provam coisas diferentes:
 *
 *   A) Dispatcher -> executor -> efeito
 *      Manda o comando direto pelo CommandDispatcher. Prova que o transporte,
 *      a DLL e o PostMessage chegam ao cliente.
 *
 *   B) WalkerEngine -> BotRuntime -> dispatcher -> executor -> efeito
 *      O motor decide a direcao a partir dos waypoints e da posicao lida. Prova
 *      a cadeia completa. B NAO esta validado se so' A rodou.
 *
 * Regras que este arquivo segue (e que a versao anterior violava):
 *   - falha em qualquer etapa aborta com `ok:false`; erro nao vira sucesso;
 *   - toda leitura precisa ser valida E atual E coerente entre RPM e canal;
 *   - divergencia entre RPM e canal bloqueia, nao "avisa";
 *   - o delta do passo tem que bater com a direcao e z nao pode mudar;
 *   - stop e' validado com um produtor ATIVO e mede ausencia de novos despachos,
 *     o que NAO e' o mesmo que cancelar movimento ja enviado;
 *   - hash do arquivo e hash da imagem carregada sao registrados como coisas
 *     diferentes;
 *   - --pid e' obrigatorio e o executavel e' conferido antes de qualquer acao;
 *   - PID/titulo/caminho sao mostrados; login e' confirmado a parte pela entidade;
 *   - falha de enumeracao de modulos aborta (lista vazia nunca e' "limpo").
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { Transport } = require(path.join(ROOT, 'reconstruction', 'transport.cjs'));
const { CommandDispatcher } = require(path.join(ROOT, 'botfinal', 'core', 'command-dispatcher.cjs'));
const { NativeSession } = require(path.join(ROOT, 'botfinal', 'core', 'native-session.cjs'));
const { BotRuntime } = require(path.join(ROOT, 'botfinal', 'core', 'bot-runtime.cjs'));
const { WalkerEngine } = require(path.join(ROOT, 'botfinal', 'engines', 'walker-engine.cjs'));
const { StateArbiter } = require(path.join(ROOT, 'botfinal', 'core', 'state-arbiter.cjs'));

const PROBE = path.join(ROOT, 'tools', 'live_probe.py');
const KEY_FILE = path.join(ROOT, 'native', 'pka_channel_key.txt');
const NAME_FILE = path.join(ROOT, 'native', 'pka_player_name.txt');
const DLL = path.join(ROOT, 'native', 'pka_native.dll');
const EXPECTED_EXE = 'PokeAlliance_dx.exe';
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-');
const OUT_DIR = path.join(ROOT, 'local-data');

const wait = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/* ---------------------------------------------------------------- args */

function parseArgs(argv) {
  const out = { pid: null, direction: 'north', steps: 1, test: 'A', verifyMs: 2500,
    confirm: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pid') out.pid = Number(argv[++i]);
    else if (a.startsWith('--pid=')) out.pid = Number(a.slice(6));
    else if (a === '--direction') out.direction = argv[++i];
    else if (a.startsWith('--direction=')) out.direction = a.slice(12);
    else if (a === '--steps') out.steps = Number(argv[++i]);
    else if (a === '--test') out.test = argv[++i];
    else if (a.startsWith('--test=')) out.test = a.slice(7);
    else if (a === '--verify-ms') out.verifyMs = Number(argv[++i]);
    else if (a === '--confirm') out.confirm = true;
  }
  return out;
}

/* --------------------------------------------------------------- probe */

function probe(...args) {
  let raw;
  try {
    raw = execFileSync('python', [PROBE, ...args],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  } catch (error) {
    const text = (error.stdout || '').toString();
    if (text.trim()) {
      try { return JSON.parse(text.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).pop()); }
      catch { /* cai no erro abaixo */ }
    }
    return { ok: false, error: 'probe falhou', detail: String(error.message || error) };
  }
  const line = raw.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).pop();
  try { return JSON.parse(line); }
  catch { return { ok: false, error: 'probe sem JSON valido', raw: line.slice(0, 400) }; }
}

/* ------------------------------------------------------------- evidencia */

const evidence = {
  generatedAt: new Date().toISOString(),
  expectedExe: EXPECTED_EXE,
  steps: [],
  claims: { A_dispatcher: false, B_walker: false, stop_with_active_producer: false },
};

function step(name, ok, detail) {
  evidence.steps.push({ at: new Date().toISOString(), step: name, ok: Boolean(ok), ...detail });
  log('[' + (ok ? 'ok' : 'FALHA') + '] ' + name
    + (detail && detail.reason ? ' :: ' + detail.reason : ''));
  return Boolean(ok);
}

function abort(name, reason, detail) {
  step(name, false, { reason, ...(detail || {}) });
  return finish(null);
}

function save() {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, 'walk-validation-' + STAMP + '.json');
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    log('evidencia: ' + file);
    return file;
  } catch (error) {
    log('[FALHA] nao consegui gravar evidencia: ' + error.message);
    return null;
  }
}

function finish(code) {
  const file = save();
  evidence.evidenceFile = file;
  log('');
  log('=== RESULTADO ===');
  if (code === 0) log('VALIDADO NO CLIENTE (ver claims abaixo)');
  else log('NAO VALIDADO NO CLIENTE');
  log(JSON.stringify(evidence.claims, null, 1));
  process.exitCode = code === 0 ? 0 : (code || 1);
  return code === 0 ? 0 : (code || 1);
}

/* ---------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log('=== validacao no cliente real ===');
  log('stamp: ' + evidence.generatedAt);

  /* -- 1. PID obrigatorio ------------------------------------------------ */
  if (!Number.isInteger(args.pid) || args.pid <= 0) {
    return abort('processo', '--pid e obrigatorio', { help: 'descubra com: Get-Process PokeAlliance_dx | Select Id' });
  }

  /* -- 2. identidade do processo ---------------------------------------- */
  const proc = probe('proc', '--pid', String(args.pid));
  if (!proc.ok) return abort('processo', 'probe falhou: ' + (proc.error || '?'), { probe: proc });
  if (proc.executable !== EXPECTED_EXE) {
    return abort('processo', 'PID nao pertence a ' + EXPECTED_EXE,
      { atual: proc.executable, path: proc.path });
  }
  log('[ok] pid=' + proc.pid + ' exe=' + proc.executable);
  log('     path: ' + proc.path);
  for (const w of proc.windows || []) {
    log('     janela: ' + w.title + ' (' + w.hwnd + ') ' + w.width + 'x' + w.height
      + (w.foreground ? ' [foco]' : ''));
  }
  step('processo', true, { pid: proc.pid, executable: proc.executable, path: proc.path,
    windows: proc.windows });

  /* -- 3. modulos: enumeracao precisa ser valida ------------------------ */
  if (!proc.moduleEnumeration?.ok) {
    return abort('modulos', 'enumeracao de modulos falhou (lista vazia NAO e processo limpo)',
      { probe: proc.moduleEnumeration });
  }
  const mods = proc.modules || [];
  if (mods.length === 0) return abort('modulos', 'enumeracao retornou zero modulos');
  const suspicious = proc.suspicious || [];
  const capture = suspicious.filter(n => /tap|shiba|msftedit/iu.test(n));
  if (capture.length) {
    return abort('modulos', 'componente de captura/terceiro carregado', { capture, suspicious });
  }
  const hasOurDll = suspicious.some(n => /^pka_native\.dll$/iu.test(n));
  log('[ok] modulos=' + mods.length + ' suspeitos=' + (suspicious.join(',') || 'nenhum'));
  step('modulos', true, { count: mods.length, suspicious, hasOurDll });

  /* -- 4. hash do arquivo (declarado como hash do arquivo) -------------- */
  let fileHash = null;
  try {
    fileHash = crypto.createHash('sha256').update(fs.readFileSync(DLL)).digest('hex');
  } catch (error) {
    return abort('hash-arquivo', 'nao consegui ler ' + DLL, { detail: error.message });
  }
  step('hash-arquivo', true, {
    hash: fileHash,
    note: 'SHA256 do ARQUIVO em disco. Nao prova qual versao esta carregada no processo.',
  });

  if (!hasOurDll) {
    return abort('dll', 'pka_native.dll NAO esta carregada; este validador nao injeta. '
      + 'Injete manualmente e rode de novo.', {});
  }

  /* -- 5. identidade do modulo carregado -------------------------------- */
  const modhash = probe('modhash', '--pid', String(args.pid), '--module', 'pka_native.dll');
  if (!modhash.ok) {
    return abort('modulo-carregado', 'nao consegui ler o modulo carregado: ' + (modhash.error || '?'),
      { probe: modhash });
  }
  evidence.loadedImage = modhash;
  /* Estes hashes NAO sao comparaveis: imagem em memoria x arquivo. O que
   * importa e' se o arquivo que o loader abriu e' o arquivo do disco AGORA. */
  const loaderFileMatchesDisk = modhash.fileOnDiskSha256 === fileHash;
  step('modulo-carregado', true, {
    base: modhash.base,
    imageSize: modhash.imageSize,
    loadedImageSha256: modhash.loadedImageSha256,
    loaderFileSha256: modhash.fileOnDiskSha256,
    diskFileSha256: fileHash,
    loaderFileMatchesDisk,
    note: 'hashes de imagem e de arquivo nao sao comparaveis entre si. '
      + 'loaderFileMatchesDisk compara o arquivo que o loader abriu com o arquivo em disco.',
  });
  if (!loaderFileMatchesDisk) {
    log('[AVISO] o arquivo que o loader abriu difere do arquivo em disco agora: '
      + modhash.fileOnDiskError || 'arquivo substituido apos a injecao');
  }

  /* -- 6. nome do jogador ------------------------------------------------ */
  let playerName = '';
  try { playerName = fs.readFileSync(NAME_FILE, 'utf8').trim(); } catch { /* vazio */ }
  if (!playerName) return abort('jogador', 'native/pka_player_name.txt ausente ou vazio');
  log('[ok] jogador configurado: ' + playerName);

  /* -- 7. canal proprio -------------------------------------------------- */
  const key = fs.readFileSync(KEY_FILE, 'utf8').trim();
  let transport;
  try {
    transport = new Transport({ pid: args.pid, key, startupTimeoutMs: 6000 });
    transport.on('error', () => {});
    await transport.connect();
  } catch (error) {
    return abort('canal', 'connect falhou: ' + error.message, { code: error.code || null });
  }
  const session = new NativeSession({ pid: args.pid }).attach(transport);
  const deadline = Date.now() + 6000;
  let snap = null;
  while (Date.now() < deadline) {
    snap = session.snapshot();
    if (snap && snap.online && !snap.stale) break;
    await wait(100);
  }
  if (!snap || !snap.online || snap.stale) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('canal', 'sem snapshot online/fresco',
      { online: snap?.online ?? null, stale: snap?.stale ?? null });
  }
  const chPos = snap.telemetry.position;
  const chName = snap.telemetry.playerName;
  log('[ok] canal: online=true hp=' + snap.healthPercent + ' nome="' + chName
    + '" pos=' + JSON.stringify(chPos));
  step('canal', true, { online: snap.online, hp: snap.healthPercent,
    player: chName, pos: chPos, auth: true });

  /* -- 8. entidade confirmada separadamente (login, nao so' PID) -------- */
  const ent = probe('entity', '--pid', String(args.pid), '--name', playerName);
  if (!ent.ok) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('entidade', 'entidade do jogador nao validada: ' + (ent.error || '?'),
      { probe: ent });
  }
  const e = ent.entity;
  log('[ok] entidade: va=' + e.va + ' id=' + e.id + ' hp=' + e.hp
    + ' pos=' + JSON.stringify(e.pos) + ' instancias=' + e.instances);
  step('entidade', true, { va: e.va, id: e.id, hp: e.hp, pos: e.pos,
    instances: e.instances });

  /* -- 8b. vivo e em estado de mundo ------------------------------------ */
  /* hp <= 0 e' personagem morto: nao anda, e qualquer delta seria ruido de
   * respawn. Exigir vida > 0 antes de medir efeito de caminhada. */
  if (!(e.hp > 0)) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('vida', 'personagem com hp=' + e.hp
      + ' (morto/respawn). Movimento nao pode ser medido nesse estado.',
      { hp: e.hp, pos: e.pos });
  }
  if (snap.healthPercent !== e.hp) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('vida', 'hp do canal (' + snap.healthPercent
      + ') diverge da entidade (' + e.hp + ')', { canal: snap.healthPercent, rpm: e.hp });
  }
  step('vida', true, { hp: e.hp, hpCanal: snap.healthPercent });

  /* -- 9. coerencia RPM x canal (EXATA) --------------------------------- */
  /* Um passo move 1 tile. Aceitar 2 quadrados de diferenca aqui injetaria
   * erro da mesma ordem do efeito que queremos medir. Exigimos igualdade. */
  if (chName.toLowerCase() !== playerName.toLowerCase()) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('coerencia', 'nome no canal difere do configurado',
      { canal: chName, configurado: playerName });
  }
  const dx = Math.abs(chPos.x - e.pos.x);
  const dy = Math.abs(chPos.y - e.pos.y);
  const dz = Math.abs((chPos.z ?? -1) - e.pos.z);
  const coherent = dx === 0 && dy === 0 && dz === 0;
  step('coerencia', coherent, {
    canal: chPos, rpm: e.pos, delta: { x: dx, y: dy, z: dz },
    reason: coherent ? undefined
      : 'RPM e canal divergem. Um passo vale 1 tile; tolerancia 2 mascararia o efeito. '
        + 'Tentativa bloqueada ate convergirem.',
  });
  if (!coherent) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('coerencia', 'RPM e canal divergem (exigido delta 0,0,0)',
      { canal: chPos, rpm: e.pos, delta: { x: dx, y: dy, z: dz } });
  }

  /* -- 10. estabilidade ANTES de qualquer comando ----------------------- */
  const still = probe('sample', '--pid', String(args.pid), '--name', playerName,
    '--count', '6', '--interval', '200');
  if (!still.ok) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('estabilidade', 'leituras invalidas antes do passo',
      { valid: still.validReads, total: still.total });
  }
  step('estabilidade', still.stable, {
    valid: still.validReads + '/' + still.total,
    positions: still.positions,
    reason: still.stable ? undefined
      : 'personagem JA em movimento sem comando nosso; nao da para atribuir causa',
  });
  if (!still.stable) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('estabilidade', 'personagem nao esta parado', { positions: still.positions });
  }

  const dirMap = { north: 0, east: 1, south: 2, west: 3,
    northeast: 4, southeast: 5, southwest: 6, northwest: 7 };
  const direction = String(args.direction).toLowerCase();
  if (!Object.hasOwn(dirMap, direction)) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('direcao', 'direcao invalida: ' + args.direction,
      { valid: Object.keys(dirMap) });
  }
  const dir = dirMap[direction];
  const expected = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }[direction] || null;
  if (!expected) {
    try { transport.close(); } catch { /* ignore */ }
    return abort('direcao', 'so direcoes cardinais tem delta exato definido', { direction });
  }

  /* -- 10b. confirmacao de inicio --------------------------------------- */
  /* O executor em modo foreground NAO captura foco: ele recusa (status 5)
   * se a janela nao estiver em primeiro plano. O --confirm existe para o
   * operador declarar que o jogo esta em foco e que ele nao esta usando
   * outra janela agora. */
  if (!args.confirm) {
    log('');
    log('[PARADA] pronto para mover, mas --confirm nao foi passado.');
    log('         O executor exige a janela JA em primeiro plano; ele nao captura foco.');
    log('         Traga o jogo para frente voce mesmo e rode:');
    log('           node tools/live_walk_validate.cjs --pid ' + args.pid
      + ' --direction ' + direction + ' --test=A --confirm');
    try { transport.close(); } catch { /* ignore */ }
    return abort('confirmacao', 'aguardando --confirm (inicio combinado)',
      { executorTakesFocus: false, requiresForeground: true, direction });
  }
  log('[ok] inicio confirmado pelo operador (--confirm)');

  const dispatcher = new CommandDispatcher({ transport, session, maxAgeMs: 5000 });
  const results = {};
  const requested = args.test.toUpperCase();
  let aborted = null;

  /* -- 11. TESTE A: dispatcher -> executor -> efeito -------------------- */
  if (requested.includes('A')) {
    results.A = await runStep({
      label: 'A',
      args, dispatcher, session, playerName, direction, dir, expected,
      send: () => dispatcher.send('walk', dir),
    });
    /* Se A falhou, PARA. Nao avanca para B nem para o teste de stop com
     * produtor, porque a causa ainda nao foi entendida. */
    if (!results.A.ok) {
      aborted = 'teste A falhou; B e stop nao foram executados';
      log('');
      log('[PARADA] ' + aborted);
    }
  }

  /* -- 12. TESTE B: WalkerEngine -> runtime -> dispatcher -> efeito ----- */
  /* B so' roda quando: foi pedido E A nao abortou. Rodar B sem A ter passado
   * seria medir a cadeia inteira sem saber se a ponta funciona. */
  if (!aborted && requested.includes('B')) {
    if (requested.includes('A') && !results.A?.ok) {
      aborted = 'teste B exige A aprovado';
    } else {
      results.B = await runWalkerTest({
        args, transport, session, dispatcher, playerName, direction, expected,
      });
      if (!results.B.ok) {
        aborted = 'teste B falhou';
        log('');
        log('[PARADA] ' + aborted);
      }
    }
  }

  /* -- 13. stop com produtor ATIVO ------------------------------------- */
  /* ESCOPO EXPLICITO: S so' roda quando foi pedido com --test=S.
   *
   * A versao anterior usava `if (!aborted)`, o que fazia `--test=A` iniciar
   * um produtor ativo e testar parada sem autorizacao — foi o desvio de
   * 2026-11-05 12:46. Agora exige a letra S. */
  if (!aborted && requested.includes('S')) {
    results.stop = await runStopTest({ args, transport, session, dispatcher, playerName });
  } else if (!requested.includes('S')) {
    log('[escopo] teste de stop NAO pedido (use --test=S para autorizar).');
  } else {
    log('[PARADA] teste de stop nao executado: ' + aborted);
  }

  try { transport.close(); } catch { /* ignore */ }

  evidence.results = results;
  evidence.aborted = aborted;
  evidence.claims.A_dispatcher = Boolean(results.A?.effectVerified);
  evidence.claims.B_walker = Boolean(results.B?.effectVerified);
  evidence.claims.stop_with_active_producer = Boolean(results.stop?.ok);

  /* Sucesso geral exige A. B e' adicional, nunca substituto. */
  const ok = evidence.claims.A_dispatcher;
  return finish(ok ? 0 : 6);
}

/**
 * Espera o canal voltar a ficar fresco.
 *
 * `execFileSync` (usado pelo probe Python) BLOQUEIA o event loop do Node.
 * Enquanto ele roda, os frames do socket chegam ao buffer mas os handlers
 * `data`/`state`/`telemetry` nao executam, entao `stateAt`/`telemetryAt`
 * congelam. Ao voltar, o snapshot parece "expirado" (STALE_SNAPSHOT) mesmo
 * com o jogo saudavel — foi exatamente o que aconteceu em 2026-11-05 12:41.
 *
 * Este helper cede o event loop ate o snapshot ficar fresco de verdade.
 * Nao afrouxa o limite do dispatcher: se o canal estiver realmente parado,
 * ele devolve false e o teste aborta.
 */
async function settleSession(session, maxWaitMs = 2500) {
  const deadline = Date.now() + maxWaitMs;
  let last = null;
  while (Date.now() < deadline) {
    await wait(120);
    const snap = session.snapshot();
    if (!snap) { last = { reason: 'sem snapshot' }; continue; }
    last = { ageMs: snap.ageMs, online: snap.online, stale: snap.stale,
      hp: snap.healthPercent };
    if (snap.online && !snap.stale) return { ok: true, ...last };
  }
  return { ok: false, ...(last || {}) };
}

/* ------------------------------------------------------- um passo + delta */

async function runStep({ label, args, dispatcher, session, playerName, direction, dir, expected, send }) {
  log('');
  log('--- teste ' + label + ' ---');
  const before = probe('entity', '--pid', String(args.pid), '--name', playerName);
  if (!before.ok) return { ok: false, reason: 'leitura antes do passo falhou', probe: before };

  /* O probe acima bloqueou o loop; cede ate o canal estar fresco de novo. */
  const fresh = await settleSession(session);
  if (!fresh.ok) {
    step('teste-' + label, false, { reason: 'canal nao voltou a ficar fresco antes do envio',
      canal: fresh });
    return { ok: false, reason: 'canal nao fresco apos probe', canal: fresh };
  }
  log('    canal fresco: ageMs=' + fresh.ageMs);

  let dispatch = null;
  let dispatchError = null;
  try { dispatch = await send(); }
  catch (error) {
    dispatchError = { message: error.message, code: error.code || null, status: error.status ?? null };
  }

  /* Espera a posicao assentar, depois le. */
  await wait(args.verifyMs);
  const after = probe('entity', '--pid', String(args.pid), '--name', playerName);
  if (!after.ok) {
    return { ok: false, reason: 'leitura depois do passo falhou', probe: after, dispatchError };
  }
  if (!dispatch) {
    step('teste-' + label, false, { reason: 'dispatcher recusou', dispatchError });
    return { ok: false, reason: 'dispatcher recusou', dispatchError };
  }

  const p0 = before.entity.pos;
  const p1 = after.entity.pos;
  const delta = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
  const zKept = delta.z === 0;
  const total = before.entity.id === after.entity.id;

  /* TESTE A exige EXATAMENTE um passo. `directionChecked` (que aceita N tiles)
   * fica reservado para o teste B, onde o motor tem cadencia propria. Aqui,
   * 2 tiles significa que saiu mais de uma tecla e o teste nao mede o que diz
   * medir. */
  const exactOneStep = delta.x === expected[0] && delta.y === expected[1] && delta.z === 0;
  const ok = exactOneStep && total;

  log('    ANTES  ' + JSON.stringify(p0) + '  (' + before.entity.va + ')');
  log('    DEPOIS ' + JSON.stringify(p1) + '  (' + after.entity.va + ')');
  log('    delta  ' + JSON.stringify(delta) + '  esperado exato ' + JSON.stringify(expected));
  step('teste-' + label, ok, {
    dispatchDelivery: dispatch.delivery,
    before: p0, after: p1, delta, expectedOneStep: expected,
    zUnchanged: zKept, sameEntity: total,
    exactOneStep,
    reason: ok ? undefined
      : !total ? 'entidade mudou entre as leituras'
        : !zKept ? 'z mudou (' + p0.z + ' -> ' + p1.z + ')'
          : 'delta ' + JSON.stringify(delta) + ' nao e exatamente 1 passo '
            + JSON.stringify(expected),
  });

  return {
    ok, effectVerified: ok,
    delivery: dispatch.delivery,
    before: p0, after: p1, delta, expected,
    zUnchanged: zKept, sameEntity: total, exactOneStep,
  };
}

function exactDelta(delta, expected) {
  return delta.x === expected[0] && delta.y === expected[1] && delta.z === 0;
}

/** Aceita N passos inteiros na direcao, eixo unico, sem deriva no outro. */
function directionChecked(delta, expected) {
  if (delta.z !== 0) return false;
  if (expected[0] === 0) {
    /* vertical: x deve ficar parado, y anda no sentido esperado */
    if (delta.x !== 0) return false;
    if (delta.y === 0) return false;
    return Math.sign(delta.y) === Math.sign(expected[1]);
  }
  if (delta.y !== 0) return false;
  if (delta.x === 0) return false;
  return Math.sign(delta.x) === Math.sign(expected[0]);
}

/* ------------------------------------------------------------- teste B */

async function runWalkerTest({ args, transport, session, dispatcher, playerName, direction, expected }) {
  log('');
  log('--- teste B (WalkerEngine -> runtime -> dispatcher) ---');
  const before = probe('entity', '--pid', String(args.pid), '--name', playerName);
  if (!before.ok) return { ok: false, reason: 'leitura antes falhou', probe: before };
  const p0 = before.entity.pos;

  /* Rota de um waypoint, no MESMO andar, adjacente na direcao pedida. */
  const target = { x: p0.x + expected[0], y: p0.y + expected[1], z: p0.z };
  const config = {
    target: { enabled: false, monsters: [], combo: { enabled: false } },
    healer: { enabled: false },
    walker: {
      enabled: true,
      smartWalking: true,
      waypoints: [{ action: 'walk', pos: target, param: '' }],
    },
    hoenn: { minWildsToEngage: 0, perfectLure: false },
  };
  const walker = new WalkerEngine(config);
  const arbiter = new StateArbiter(config);
  const runtime = new BotRuntime({
    session, transport, config, walker, arbiter, dispatcher,
    combat: { filterValidTargets: () => [], isLureConditionMet: () => false, targetId: null },
    healer: { tick: async () => ({ status: 'idle' }) },
    tickMs: 120,
  });

  const sentBefore = dispatcher.log.length;
  /* Limites definidos ANTES de comecar: no maximo 2 comandos e 2 s. O motor
   * para no primeiro que ocorrer. Se perder sessao/telemetria, aborta. */
  const MAX_COMMANDS = 2;
  const MAX_MS = 2000;
  /* O probe acima bloqueou o event loop: deixa o canal ficar fresco antes de
   * armar o motor, senao o primeiro tick cai em STALE_SNAPSHOT. */
  const fresh = await settleSession(session);
  if (!fresh.ok) {
    step('teste-B', false, { reason: 'canal nao ficou fresco antes do motor', canal: fresh });
    return { ok: false, reason: 'canal nao fresco antes do motor', canal: fresh };
  }
  const startedAt = Date.now();
  runtime.start();

  let abortedReason = null;
  while (Date.now() - startedAt < MAX_MS) {
    const commands = dispatcher.log.length - sentBefore;
    if (commands >= MAX_COMMANDS) break;
    const live = session.snapshot();
    if (!live || !live.online || live.stale) {
      abortedReason = 'sessao/telemetria invalida durante o teste';
      break;
    }
    if (!(live.healthPercent > 0)) {
      abortedReason = 'hp zerado durante o teste';
      break;
    }
    await wait(100);
  }
  runtime.stop();
  await runtime.pause();

  const engineState = { ticks: runtime.ticks, last: runtime.last,
    state: runtime.state.state, commands: dispatcher.log.length - sentBefore,
    abortedReason, elapsedMs: Date.now() - startedAt,
    limits: { maxCommands: MAX_COMMANDS, maxMs: MAX_MS } };
  log('    motor: ticks=' + runtime.ticks + ' estado=' + runtime.state.state
    + ' comandos=' + engineState.commands + ' last=' + JSON.stringify(runtime.last));

  await wait(args.verifyMs);
  const after = probe('entity', '--pid', String(args.pid), '--name', playerName);
  if (!after.ok) return { ok: false, reason: 'leitura depois falhou', probe: after, engineState };
  const p1 = after.entity.pos;
  const delta = { x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z };
  const producedCommand = engineState.commands > 0;
  const aligned = directionChecked(delta, expected);
  const zKept = delta.z === 0;
  const sameEntity = before.entity.id === after.entity.id;
  const ok = !abortedReason && producedCommand && aligned && zKept && sameEntity;

  log('    ANTES  ' + JSON.stringify(p0));
  log('    DEPOIS ' + JSON.stringify(p1) + ' delta=' + JSON.stringify(delta));
  step('teste-B', ok, {
    engineState, before: p0, after: p1, delta, expected,
    producedCommand, zUnchanged: zKept, sameEntity,
    reason: ok ? undefined
      : !producedCommand ? 'o motor nao despachou nenhum comando'
        : !sameEntity ? 'entidade mudou'
          : !zKept ? 'z mudou' : 'delta fora da direcao',
  });

  return { ok, effectVerified: ok, engineState, before: p0, after: p1, delta, expected,
    producedCommand, zUnchanged: zKept, sameEntity };
}

/* -------------------------------------------------------------- stop */

/**
 * stop com produtor ATIVO.
 *
 * Roda o walker com uma rota longa, deixa ele despachar, entao para. Mede:
 *   - despachos antes da parada (produtor ativo de verdade);
 *   - despachos depois de parar (tem que ser zero);
 *   - se a posicao ainda muda depois (movimento JA enviado pode continuar:
 *     isso NAO e cancelamento e nao e' chamado de cancelamento aqui).
 */
async function runStopTest({ args, transport, session, dispatcher, playerName }) {
  log('');
  log('--- stop com produtor ativo ---');
  const start = probe('entity', '--pid', String(args.pid), '--name', playerName);
  if (!start.ok) return { ok: false, reason: 'leitura inicial falhou', probe: start };

  const config = {
    target: { enabled: false, monsters: [], combo: { enabled: false } },
    healer: { enabled: false },
    walker: { enabled: true, smartWalking: true, waypoints: [
      { action: 'walk', pos: { x: start.entity.pos.x + 6, y: start.entity.pos.y, z: start.entity.pos.z }, param: '' },
      { action: 'walk', pos: { x: start.entity.pos.x + 6, y: start.entity.pos.y + 6, z: start.entity.pos.z }, param: '' },
    ] },
    hoenn: { minWildsToEngage: 0, perfectLure: false },
  };
  const walker = new WalkerEngine(config);
  const arbiter = new StateArbiter(config);
  const runtime = new BotRuntime({
    session, transport, config, walker, arbiter, dispatcher,
    combat: { filterValidTargets: () => [], isLureConditionMet: () => false, targetId: null },
    healer: { tick: async () => ({ status: 'idle' }) },
    tickMs: 100,
  });

  const base = dispatcher.log.length;
  /* Limite curto: o produtor para sozinho mesmo se a parada falhar. */
  const MAX_ACTIVE_COMMANDS = 4;
  const MAX_ACTIVE_MS = 2500;
  /* Probe bloqueante acima: cede o loop antes de armar o produtor. */
  const freshStop = await settleSession(session);
  if (!freshStop.ok) {
    step('stop', false, { reason: 'canal nao ficou fresco antes do produtor', canal: freshStop });
    return { ok: false, reason: 'canal nao fresco antes do produtor', canal: freshStop };
  }
  runtime.start();
  const activeDeadline = Date.now() + MAX_ACTIVE_MS;
  while (Date.now() < activeDeadline
         && dispatcher.log.length - base < MAX_ACTIVE_COMMANDS) await wait(100);
  const activeCommands = dispatcher.log.length - base;
  const cappedByLimit = dispatcher.log.length - base >= MAX_ACTIVE_COMMANDS;
  log('    produtor ativo: ' + activeCommands + ' comandos'
    + (cappedByLimit ? ' (limite atingido)' : ' (tempo esgotado)'));

  /* Para tudo e mede as DUAS coisas separadamente. */
  const stoppedAt = Date.now();
  const afterStopIndex = dispatcher.log.length;

  let stopError = null;
  let stopApplied = false;
  try {
    runtime.stop();
    await runtime.pause();
    stopApplied = true;
  } catch (error) {
    stopError = error.message;
  }
  log('    stop chamado: ' + (stopApplied ? 'ok' : 'ERRO: ' + stopError));

  await wait(1500);
  const newCommands = dispatcher.log.length - afterStopIndex;
  const drift = probe('entity', '--pid', String(args.pid), '--name', playerName);

  /* Duas condicoes independentes. Falha de uma NAO pode ser mascarada pela
   * outra, e o resultado final exige as duas. */
  const stopCallOk = stopApplied && stopError === null;
  const producerWasActive = activeCommands > 0;
  const noNewCommands = newCommands === 0;
  const ok = stopCallOk && producerWasActive && noNewCommands;

  /* Log dos comandos realmente despachados, com horario e direcao. Sem isto
   * nao da' para correlacionar o deslocamento residual com um comando
   * especifico — foi a lacuna da evidencia de 2026-11-05 15:47. */
  const commandLog = dispatcher.log.slice(afterStopIndex - activeCommands - 1 >= 0
    ? Math.max(0, afterStopIndex - activeCommands - 1) : 0)
    .map(entry => ({ at: entry.at, command: entry.command, parameter: entry.parameter }));

  step('stop', ok, {
    /* (a) resposta/erro da chamada de stop */
    stopCall: { applied: stopApplied, error: stopError, ok: stopCallOk },
    /* (b) interrupcao dos novos despachos */
    interruption: {
      producerWasActive,
      activeCommands,
      cappedByLimit,
      newCommandsAfterStop: newCommands,
      noNewCommands,
    },
    /* movimento residual: nao e' cancelamento, e nao entra em `ok` */
    driftAfterStop: drift.ok ? drift.entity.pos : null,
    /* comandos realmente despachados, para correlacionar deslocamento */
    commandLog,
    elapsedMs: Date.now() - stoppedAt,
    reason: !stopCallOk ? 'chamada de stop falhou: ' + stopError
      : !producerWasActive ? 'produtor nunca esteve ativo; o teste nao vale'
        : !noNewCommands ? newCommands + ' comandos sairam depois do stop'
          : undefined,
    note: 'Ausencia de novos despachos NAO e cancelamento de movimento ja enviado; '
      + 'a posicao pode continuar mudando por inercia do passo anterior. '
      + 'A direcao de cada comando despachado esta em commandLog.',
  });

  return {
    ok,
    stopCall: { applied: stopApplied, error: stopError, ok: stopCallOk },
    interruption: { producerWasActive, activeCommands, cappedByLimit,
      newCommands, noNewCommands },
    commandLog,
    driftAfterStop: drift.ok ? drift.entity.pos : null,
    /* O que `applied` significa, explicitamente. */
    appliedMeans: 'a chamada de stop no Node completou sem excecao '
      + '(runtime.stop + runtime.pause). NAO e prova de cancelamento no cliente.',
  };
}

main().catch(error => {
  console.error('[FATAL] ' + (error.stack || error.message));
  step('fatal', false, { reason: error.message });
  finish(1);
});
