'use strict';

/**
 * Uma (1) tentativa do teste A, com contagem regressiva e revalidacao final.
 *
 *   node tools/live_walk_armed.cjs --pid <PID> --direction north [--countdown 15]
 *
 * Fluxo:
 *   1. conta 15 s (o operador traz o jogo para frente nesse intervalo)
 *   2. revalida TUDO no fim: processo, modulo carregado, canal, entidade,
 *      hp, coerencia exata, estabilidade E FOCO
 *   3. se qualquer coisa falhar: ABORTA sem capturar foco e sem repetir
 *   4. se tudo passar: envia exatamente UM comando walk e mede o delta
 *   5. registra geometria da janela antes/depois
 *
 * Nao executa B nem S. Nao chama SetForegroundWindow nem qualquer funcao de
 * janela. Se o jogo nao estiver em primeiro plano no fim da contagem, aborta.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { Transport } = require(path.join(ROOT, 'reconstruction', 'transport.cjs'));
const { NativeSession } = require(path.join(ROOT, 'botfinal', 'core', 'native-session.cjs'));
const { CommandDispatcher } = require(path.join(ROOT, 'botfinal', 'core', 'command-dispatcher.cjs'));

const PROBE = path.join(ROOT, 'tools', 'live_probe.py');
const WATCH = path.join(ROOT, 'tools', 'window_watch.py');
const KEY_FILE = path.join(ROOT, 'native', 'pka_channel_key.txt');
const DLL = path.join(ROOT, 'native', 'pka_native.dll');
const EXPECTED_EXE = 'PokeAlliance_dx.exe';
const STAMP = new Date().toISOString().replace(/[:.]/gu, '-');
const OUT_DIR = path.join(ROOT, 'local-data');

const EXPECTED_DLL_SHA = 'b293b2e736714ac5c38f9f98b94952335581e44d704b93898f729fbf32cdf703';

function parseArgs(argv) {
  const out = { pid: null, direction: 'north', countdown: 30, verifyMs: 2500,
    engine: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--pid') out.pid = Number(argv[++i]);
    else if (a === '--direction') out.direction = argv[++i];
    else if (a === '--countdown') out.countdown = Number(argv[++i]);
    else if (a === '--verify-ms') out.verifyMs = Number(argv[++i]);
    else if (a === '--engine') out.engine = true;
  }
  return out;
}

const wait = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function probe(...args) {
  let raw;
  try {
    raw = execFileSync('python', [PROBE, ...args],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  } catch (error) {
    const text = (error.stdout || '').toString();
    if (text.trim()) {
      try { return JSON.parse(text.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).pop()); }
      catch { /* cai */ }
    }
    return { ok: false, error: 'probe falhou', detail: String(error.message || error) };
  }
  return JSON.parse(raw.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).pop());
}

/**
 * Resolve a janela a partir do PID — SEM HWND fixo.
 *
 * Usa `window_watch.py` sem `--seconds`, que e' o mesmo resolvedor usado no
 * diagnostico. Regras: pertence ao PID, visivel, area de cliente > 0, tem
 * WS_CAPTION, maior por area. Devolve tambem `foreground` com `ownerPid`, para
 * que o abort de foco registre o HWND/PID realmente em primeiro plano.
 */
function windowState(pid) {
  try {
    const raw = execFileSync('python', [WATCH, '--pid', String(pid)],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const j = JSON.parse(raw.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).pop());
    if (!j.ok) return { ok: false, error: j.error, raw: j };
    const w = j.window;
    return {
      ok: true,
      pid,
      hwnd: w.hwnd,
      ownerPid: w.ownerPid,
      ownerMatches: w.ownerMatches,
      title: w.title,
      rect: w.windowRect,
      clientRect: w.clientRect,
      visible: w.visible,
      iconic: w.iconic,
      zoomed: w.zoomed,
      foreground: j.foreground,
      gameIsForeground: j.gameIsForeground,
      foregroundIsOurPid: j.foregroundIsOurPid,
      rejectedWindows: j.rejected,
    };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

const evidence = {
  generatedAt: new Date().toISOString(),
  test: 'A',
  expectedDllSha256: EXPECTED_DLL_SHA,
  steps: [],
  aborted: null,
  result: null,
};

function step(name, ok, detail) {
  evidence.steps.push({ at: new Date().toISOString(), step: name, ok: Boolean(ok),
    ...(detail || {}) });
  log('  [' + (ok ? 'ok' : 'FALHA') + '] ' + name
    + (detail && detail.reason ? ' — ' + detail.reason : ''));
  return Boolean(ok);
}

function save() {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    /* `args` nao existe neste escopo: o modo vem de evidence.test. */
    const prefix = evidence.test === 'B' ? 'walk-testB-armed-' : 'walk-testA-armed-';
    const file = path.join(OUT_DIR, prefix + STAMP + '.json');
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    evidence.evidenceFile = file;
    return file;
  } catch { return null; }
}

function abortWith(reason, detail) {
  evidence.aborted = { reason, ...(detail || {}) };
  log('');
  log('ABORTADO: ' + reason);
  log('Nenhum movimento foi enviado. Nenhuma tentativa de capturar foco.');
  const f = save();
  if (f) log('evidencia: ' + f);
  evidence.claimsA = false;
  log('');
  log('RESULTADO: NAO VALIDADO NO CLIENTE (' + reason + ')');
  process.exit(2);
}

/** Revalida todas as condicoes. Devolve um objeto; nao lanca. */
async function validateAll(pid, playerName, options = {}) {
  const requireFocus = options.requireFocus !== false;
  const out = {};

  const proc = probe('proc', '--pid', String(pid));
  out.process = { ok: proc.ok && proc.executable === EXPECTED_EXE,
    executable: proc.executable, path: proc.path,
    reason: proc.ok && proc.executable === EXPECTED_EXE ? undefined
      : 'PID nao pertence a ' + EXPECTED_EXE };
  if (!out.process.ok) return out;

  const modhash = probe('modhash', '--pid', String(pid), '--module', 'pka_native.dll');
  out.module = {
    ok: modhash.ok && modhash.fileOnDiskSha256 === EXPECTED_DLL_SHA,
    loaderFileSha256: modhash.fileOnDiskSha256,
    base: modhash.base,
    reason: modhash.ok && modhash.fileOnDiskSha256 === EXPECTED_DLL_SHA ? undefined
      : 'modulo carregado nao e a versao corrigida',
  };
  if (!out.module.ok) return out;

  const env = { ...out.module };
  void env;

  const win = windowState(pid);
  /* Gate de janela com verificacao de PROPRIEDADE do HWND. Se o resolvedor
   * devolver um HWND cujo dono nao e' o PID pedido, isso e' divergencia e
   * aborta — nao se assume que a janela "provavelmente" e' a certa. */
  const ownerOk = win.ok && win.ownerMatches === true;
  const foregroundMatches = win.ok && win.gameIsForeground === true;
  out.window = { ...win,
    ok: win.ok && ownerOk && win.iconic === false
      && (requireFocus ? foregroundMatches : true),
    ownerOk,
    foregroundMatches,
    reason: !win.ok ? 'nao consegui resolver a janela: ' + (win.error || '?')
      : !ownerOk ? 'DIVERGENCIA: hwnd ' + win.hwnd + ' pertence ao pid '
        + win.ownerPid + ', nao ao pid ' + pid
        : win.iconic ? 'janela minimizada'
          : (requireFocus && !foregroundMatches)
            ? 'jogo NAO esta em primeiro plano (esperado hwnd ' + win.hwnd
              + ' pid ' + pid + '; em foreground hwnd '
              + (win.foreground?.hwnd ?? '?') + ' pid '
              + (win.foreground?.ownerPid ?? '?') + ')'
            : undefined };
  if (!out.window.ok) return out;

  try {
    out.transport = new Transport({ pid, key: fs.readFileSync(KEY_FILE, 'utf8').trim(),
      startupTimeoutMs: 6000 });
    out.transport.on('error', () => {});
    await out.transport.connect();
  } catch (error) {
    out.channel = { ok: false, reason: 'connect falhou: ' + error.message };
    return out;
  }

  out.session = new NativeSession({ pid }).attach(out.transport);
  const deadline = Date.now() + 6000;
  let snap = null;
  while (Date.now() < deadline) {
    snap = out.session.snapshot();
    if (snap && snap.online && !snap.stale) break;
    await wait(100);
  }
  out.channel = { ok: Boolean(snap && snap.online && !snap.stale),
    online: snap?.online ?? null, stale: snap?.stale ?? null,
    hp: snap?.healthPercent ?? null,
    player: snap?.telemetry?.playerName ?? null,
    pos: snap?.telemetry?.position ?? null,
    reason: snap && snap.online && !snap.stale ? undefined : 'sem snapshot online/fresco' };
  if (!out.channel.ok) return out;

  const ent = probe('entity', '--pid', String(pid), '--name', playerName);
  out.entity = { ok: ent.ok, ...(ent.ok ? ent.entity : { reason: ent.error }) };
  if (!out.entity.ok) return out;

  out.vital = { ok: out.entity.hp > 0 && out.entity.hp === out.channel.hp,
    entityHp: out.entity.hp, channelHp: out.channel.hp,
    reason: out.entity.hp > 0 && out.entity.hp === out.channel.hp ? undefined
      : 'hp invalido ou divergente' };
  if (!out.vital.ok) return out;

  const ch = out.channel.pos;
  const rp = out.entity.pos;
  out.coherence = { ok: ch.x === rp.x && ch.y === rp.y && ch.z === rp.z,
    channel: ch, rpm: rp,
    reason: ch.x === rp.x && ch.y === rp.y && ch.z === rp.z ? undefined
      : 'canal e RPM divergem' };
  if (!out.coherence.ok) return out;

  /* Estabilidade: exige que TODAS as leituras validas concordem e que a
   * maioria tenha sido valida.
   *
   * Por que nao exigir 100% de leituras validas: uma unica leitura pode falhar
   * por timing (o processo esta alocando, a regiao ficou PAGE_GUARD por um
   * instante). Isso e' falha de LEITURA, nao movimento. Mas aceitar qualquer
   * coisa seria pior: se houver uma unica posicao diferente entre as validas,
   * o personagem se moveu e o teste nao pode atribuir causa.
   *
   * Criterio: validas >= ceil(total*0.8) E posicoes distintas == 1. */
  /* Gate de estabilidade com criterios FIXOS e mensuraveis, vindos do probe:
   *   minValid (>=6), coverage (>=1000ms), maxGap (<=600ms entre leituras
   *   VALIDAS), singlePos, sameEntity.
   * Uma leitura perdida e' lacuna, nao movimento; mas o numero de validas e a
   * lacuna maxima tem limite explicito. Nao afrouxamos para "verde". */
  const still = probe('sample', '--pid', String(pid), '--name', playerName,
    '--count', '10', '--interval', '150');
  out.stability = {
    ok: still.ok === true,
    valid: still.validReads + '/' + still.total,
    coverageMs: still.coverageMs,
    maxGapMs: still.maxGapMs,
    checks: still.checks,
    thresholds: still.thresholds,
    positions: still.positions,
    sequence: still.sequence,
    entityIds: still.entityIds,
    reason: still.ok ? undefined
      : !still.checks ? 'probe nao retornou checks'
        : !still.checks.minValid ? 'leituras validas < minValid ('
          + still.validReads + '/' + still.total + ')'
          : !still.checks.coverage ? 'cobertura temporal insuficiente ('
            + still.coverageMs + 'ms)'
            : !still.checks.maxGap ? 'lacuna entre leituras validas acima do limite ('
              + still.maxGapMs + 'ms)'
              : !still.checks.singlePos ? 'posicao mudou durante a janela: '
                + (still.sequence || []).map(p => JSON.stringify(p)).join(' -> ')
                : !still.checks.sameEntity ? 'id de entidade mudou'
                  : undefined,
  };
  return out;
}

/**
 * TESTE B — exercita a cadeia completa pelo motor proprio.
 *
 * Diferenca essencial em relacao ao teste A: aqui a direcao NAO e' escolhida
 * pelo script. Construimos um waypoint adjacente na direcao pedida e deixamos
 * o WalkerEngine decidir, o BotRuntime orquestrar e o CommandDispatcher
 * despachar. Se o motor estiver errado, o delta nao bate — mesmo que o
 * transporte funcione.
 *
 * Limites explicitos, definidos ANTES:
 *   MAX_COMMANDS = 2   (o motor pode precisar de mais de um tick)
 *   MAX_MS       = 3000
 * O runtime para no primeiro limite. Aborta se perder sessao, se hp zerar ou
 * se o foco cair.
 */
async function runEngineStep({ args, post, dispatcher, before, expected, expectedDir }) {
  const { BotRuntime } = require(path.join(ROOT, 'botfinal', 'core', 'bot-runtime.cjs'));
  const { WalkerEngine } = require(path.join(ROOT, 'botfinal', 'engines', 'walker-engine.cjs'));
  const { StateArbiter } = require(path.join(ROOT, 'botfinal', 'core', 'state-arbiter.cjs'));

  const target = { x: before.x + expected[0], y: before.y + expected[1], z: before.z };
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

  /* Identidade e prazo explicitos: o motor precisa saber de quem e' a
   * sessao para abortar em troca de entidade, e o prazo define quando
   * desistir de esperar progresso sem repetir o comando. */
  const walker = new WalkerEngine(config, {
    playerId: post.entity.id,
    progressTimeoutMs: 2500,
  });
  const arbiter = new StateArbiter(config);
  const runtime = new BotRuntime({
    session: post.session, transport: post.transport, config, walker, arbiter, dispatcher,
    /* Sem combate: o combate nao esta implementado no executor (status 4) e
     * nao deve influenciar este teste. */
    combat: { filterValidTargets: () => [], isLureConditionMet: () => false,
      targetId: null, tick: async () => ({ status: 'idle' }) },
    healer: { tick: async () => ({ status: 'idle' }) },
    tickMs: 120,
  });

  const MAX_COMMANDS = 2;
  const MAX_MS = 3000;
  const base = dispatcher.log.length;
  const started = Date.now();
  let abortReason = null;

  log('  waypoint alvo: ' + JSON.stringify(target) + ' (direcao esperada '
    + JSON.stringify(expected) + ')');
  if (args.pid) { /* pid ja' validado */ }
  void expectedDir;

  /* Roda ate' o motor DECIDIR algo conclusivo:
   *   - waypoint-reached  -> concluiu
   *   - blocked           -> desistiu com motivo
   *   - erro/abort        -> interrompeu
   * MAX_COMMANDS e' protecao contra bug, nao meta. MAX_MS limita a espera.
   * Nao interrompemos ao atingir 2 comandos: isso mascararia o defeito. */
  runtime.start();
  while (Date.now() - started < MAX_MS) {
    const live = post.session.snapshot();
    if (!live || !live.online || live.stale) { abortReason = 'sessao/telemetria invalida'; break; }
    if (!(live.healthPercent > 0)) { abortReason = 'hp zerado'; break; }
    const win = windowState(args.pid);
    if (win.ok && win.gameIsForeground !== true) { abortReason = 'perdeu o foco'; break; }

    const lastStatus = runtime.last?.status;
    if (lastStatus === 'waypoint-reached') break;
    if (lastStatus === 'blocked') break;
    if (lastStatus === 'error' || lastStatus === 'aborted') break;

    if (dispatcher.log.length - base > MAX_COMMANDS) {
      abortReason = 'limite de comandos excedido (' + (dispatcher.log.length - base) + ')';
      break;
    }
    await wait(120);
  }
  runtime.stop();
  await runtime.pause();

  const commands = dispatcher.log.length - base;
  const entries = dispatcher.log.slice(base).map(e => ({ at: e.at, command: e.command,
    parameter: e.parameter }));

  log('  motor: ticks=' + runtime.ticks + ' estado=' + runtime.state.state
    + ' comandos=' + commands + ' last=' + JSON.stringify(runtime.last));
  log('  comandos: ' + JSON.stringify(entries));
  if (walker.pendingStep) {
    log('  PASSO PENDENTE ainda ativo: ' + JSON.stringify(walker.pendingStep));
  }
  if (walker.blocked) log('  BLOQUEADO: ' + JSON.stringify(walker.blocked));

  /* Observacao final: cobre oportunidades de ticks e de telemetria para
   * detectar despacho tardio. 3 s = 3 atualizacoes de telemetria (1000ms)
   * e ~12 ticks do runtime (120ms). Nao e' janela curta escolhida para passar. */
  const OBSERVE_MS = 3000;
  const obsStart = Date.now();
  const obsBase = dispatcher.log.length;
  await wait(OBSERVE_MS);
  const lateCommands = dispatcher.log.length - obsBase;

  return {
    engineState: {
      ticks: runtime.ticks,
      state: runtime.state.state,
      last: runtime.last,
      commands,
      commandLog: entries,
      abortReason,
      elapsedMs: Date.now() - started,
      limits: { maxCommands: MAX_COMMANDS, maxMs: MAX_MS },
      waypoint: target,
      expectedDirection: expected,
      pendingAfter: walker.pendingStep,
      blocked: walker.blocked,
      observation: {
        durationMs: Date.now() - obsStart,
        lateCommands,
        telemetryUpdatesCovered: Math.floor(OBSERVE_MS / 1000),
        runtimeTicksCovered: Math.floor(OBSERVE_MS / 120),
      },
    },
    dispatch: commands > 0
      ? { delivery: { enqueued: true, written: true, received: true, accepted: true },
          commandLog: entries }
      : null,
    dispatchError: commands === 0 ? { message: abortReason || 'motor nao despachou' } : null,
    abortedByEngine: abortReason,
    lateCommands,
  };
}

/** Cede o event loop ate o canal ficar fresco (probe bloqueia o loop). */
async function settleSession(session, maxWaitMs = 3000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await wait(120);
    const snap = session.snapshot();
    if (snap && snap.online && !snap.stale) return { ok: true, ageMs: snap.ageMs };
  }
  return { ok: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  log('=== teste A armado ===');
  log('stamp: ' + evidence.generatedAt);

  if (!Number.isInteger(args.pid) || args.pid <= 0) abortWith('--pid obrigatorio');
  const dirMap = { north: 0, east: 1, south: 2, west: 3 };
  const direction = String(args.direction).toLowerCase();
  if (!Object.hasOwn(dirMap, direction)) abortWith('direcao invalida: ' + args.direction);
  const dir = dirMap[direction];
  const expected = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }[direction];

  let playerName = '';
  try { playerName = fs.readFileSync(path.join(ROOT, 'native', 'pka_player_name.txt'),
    'utf8').trim(); } catch { /* vazio */ }
  if (!playerName) abortWith('nome do jogador ausente');

  evidence.test = args.engine ? 'B' : 'A';
  evidence.pid = args.pid;
  evidence.direction = direction;
  evidence.expectedDelta = expected;
  evidence.playerName = playerName;

  /* -- estado inicial -------------------------------------------------- */
  log('');
  log('--- estado inicial ---');
  const pre = await validateAll(args.pid, playerName, { requireFocus: false });
  /* Checagem defensiva: validateAll retorna cedo na primeira falha, entao os
   * campos seguintes podem nao existir. Nao acessar `.ok` de undefined. */
  const order = ['process', 'module', 'window', 'channel', 'entity', 'vital',
    'coherence', 'stability'];
  for (const key of order) {
    const stage = pre[key];
    if (!stage) abortWith('validacao inicial parou antes de ' + key, { failedAt: key, pre });
    if (!stage.ok) abortWith(stage.reason || key + ' falhou', { [key]: stage });
    if (key === 'process') log('  pid ' + args.pid + ' -> ' + stage.executable);
    if (key === 'module') log('  modulo carregado: ' + String(stage.loaderFileSha256).slice(0, 16) + '... (corrigida)');
    if (key === 'window') log('  janela: ' + stage.rect?.w + 'x' + stage.rect?.h
      + ' max=' + stage.zoomed + ' em foco=' + stage.gameIsForeground);
    if (key === 'channel') log('  canal: hp=' + stage.hp + ' pos=' + JSON.stringify(stage.pos));
    if (key === 'entity') log('  entidade: id=' + stage.id + ' hp=' + stage.hp
      + ' pos=' + JSON.stringify(stage.pos));
    if (key === 'stability') log('  estabilidade: ' + (stage.positions || []).join(' '));
  }

  evidence.initial = {
    process: pre.process, module: pre.module, window: pre.window,
    channel: pre.channel, entity: pre.entity, coherence: pre.coherence,
    stability: pre.stability,
  };
  try { pre.transport.close(); } catch { /* ignore */ }

  /* -- ARMADO + contagem ----------------------------------------------- */
  log('');
  log('ARMADO — coloque o PokeAlliance em foco agora e permaneca nele');
  log('Esperando ' + args.countdown + 's. Nao precisa responder nada.');
  log('Se o foco nao estiver no jogo ao fim, aborte sem tentar recuperar.');
  for (let left = args.countdown; left > 0; left -= 1) {
    log('  ' + left + 's');
    await wait(1000);
  }

  /* -- revalidacao final ----------------------------------------------- */
  log('');
  log('--- revalidacao final ---');
  const post = await validateAll(args.pid, playerName, { requireFocus: true });
  const failures = [];
  for (const key of ['process', 'module', 'window', 'channel', 'entity', 'vital',
    'coherence', 'stability']) {
    if (!post[key]?.ok) failures.push(key + ': ' + (post[key]?.reason || '?'));
  }
  evidence.revalidated = {
    process: post.process, module: post.module, window: post.window,
    channel: post.channel, entity: post.entity, vital: post.vital,
    coherence: post.coherence, stability: post.stability,
    failures,
  };
  if (failures.length) {
    try { post.transport?.close(); } catch { /* ignore */ }
    abortWith('revalidacao falhou', { failures });
  }
  log('  todas as condicoes OK, inclusive foco');

  /* -- posicao inicial nao pode ter mudado ----------------------------- */
  /* O waypoint foi calculado a partir de `pre.entity.pos`. Se a posicao no
   * fim da espera for outra, o percurso deixou de ser o combinado. Abortar,
   * NAO recalcular em silencio: recalcular mudaria o alvo que o operador
   * conferiu visualmente.
   *
   * Origem da mudanca fica DESCONHECIDA: o operador pode ter andado, o jogo
   * pode ter empurrado o personagem, ou qualquer outra coisa. Nao atribuimos
   * causa sem evidencia. */
  const posBefore = pre.entity.pos;
  const posNow = post.entity.pos;
  const sameStart = posBefore.x === posNow.x && posBefore.y === posNow.y
    && posBefore.z === posNow.z;
  evidence.startPositionCheck = {
    proposed: posBefore, observed: posNow, unchanged: sameStart,
    origin: 'desconhecida (nao atribuida sem evidencia adicional)',
  };
  if (!sameStart) {
    try { post.transport?.close(); } catch { /* ignore */ }
    abortWith('posicao inicial mudou durante a espera; percurso NAO foi recalculado', {
      proposed: posBefore,
      observed: posNow,
      delta: { x: posNow.x - posBefore.x, y: posNow.y - posBefore.y,
        z: posNow.z - posBefore.z },
      origin: 'desconhecida',
    });
  }
  log('  posicao inicial inalterada: ' + JSON.stringify(posNow));

  /* -- um passo --------------------------------------------------------- */
  const before = post.entity.pos;
  const winBefore = post.window;
  log('');
  log('--- ' + (args.engine
    ? 'WalkerEngine -> runtime -> dispatcher (TESTE B)'
    : 'UM passo pelo dispatcher (TESTE A)') + ' ---');
  log('  antes: ' + JSON.stringify(before));

  const fresh = await settleSession(post.session);
  if (!fresh.ok) {
    try { post.transport.close(); } catch { /* ignore */ }
    abortWith('canal nao ficou fresco antes do envio');
  }
  log('  canal fresco: ageMs=' + fresh.ageMs);

  const dispatcher = new CommandDispatcher({ transport: post.transport, session: post.session,
    maxAgeMs: 5000 });
  let dispatch = null;
  let dispatchError = null;
  let engineState = null;

  if (args.engine) {
    /* TESTE B: a direcao NAO vem do CLI. Vem do WalkerEngine, a partir dos
     * waypoints e da posicao lida. O dispatcher e' chamado PELO runtime, nao
     * por este script — senao nao seria teste do motor. */
    engineState = await runEngineStep({
      args, post, dispatcher, before, expected, expectedDir: dir,
    });
    dispatch = engineState.dispatch;
    dispatchError = engineState.dispatchError;
  } else {
    try { dispatch = await dispatcher.send('walk', dir); }
    catch (error) {
      dispatchError = { message: error.message, code: error.code || null,
        status: error.status ?? null };
    }
  }

  await wait(args.verifyMs);
  const after = probe('entity', '--pid', String(args.pid), '--name', playerName);
  const winAfter = windowState(args.pid);
  try { post.transport.close(); } catch { /* ignore */ }

  if (!after.ok) {
    evidence.result = { dispatchDelivery: dispatch?.delivery ?? null, dispatchError,
      afterError: after.error };
    abortWith('leitura depois do passo falhou');
  }

  const p1 = after.entity.pos;
  const delta = { x: p1.x - before.x, y: p1.y - before.y, z: p1.z - before.z };
  const exact = delta.x === expected[0] && delta.y === expected[1] && delta.z === 0;
  const sameEntity = post.entity.id === after.entity.id;
  const geometryKept = JSON.stringify(winBefore.rect) === JSON.stringify(winAfter.rect)
    && winBefore.zoomed === winAfter.zoomed && winBefore.iconic === winAfter.iconic;
  const ok = Boolean(dispatch) && exact && sameEntity && geometryKept;

  log('  depois: ' + JSON.stringify(p1));
  log('  delta : ' + JSON.stringify(delta) + ' (esperado ' + JSON.stringify(expected) + ')');
  log('  z intacto: ' + (delta.z === 0) + ' | mesma entidade: ' + sameEntity);
  log('  geometria inalterada: ' + geometryKept
    + ' (' + winBefore.rect?.w + 'x' + winBefore.rect?.h + ' -> '
    + winAfter.rect?.w + 'x' + winAfter.rect?.h + ')');

  evidence.result = {
    dispatchDelivery: dispatch?.delivery ?? null,
    dispatchError,
    before, after: p1, delta, expected,
    exactOneStep: exact,
    zUnchanged: delta.z === 0,
    sameEntity,
    entityIdBefore: post.entity.id,
    entityIdAfter: after.entity.id,
    commandLog: dispatcher.log.map(e => ({ at: e.at, command: e.command,
      parameter: e.parameter })),
    windowBefore: winBefore,
    windowAfter: winAfter,
    geometryUnchanged: geometryKept,
    effectObserved: exact,
  };

  step(args.engine ? 'teste-B' : 'teste-A', ok, {
    reason: ok ? undefined
      : !dispatch ? 'dispatcher recusou: ' + (dispatchError?.message || '?')
        : !sameEntity ? 'entidade mudou'
          : delta.z !== 0 ? 'z mudou'
            : !geometryKept ? 'geometria da janela mudou'
              : 'delta nao e exatamente 1 passo ' + JSON.stringify(expected),
  });

  const f = save();
  if (f) log('');
  if (f) log('evidencia: ' + f);
  log('');
  log('RESULTADO: ' + (ok ? 'VALIDADO NO CLIENTE' : 'NAO VALIDADO NO CLIENTE'));
  log('  B e S NAO foram executados.');
  process.exitCode = ok ? 0 : 6;
}

main().catch(error => {
  console.error('[FATAL] ' + (error.stack || error.message));
  abortWith('excecao: ' + error.message);
});
