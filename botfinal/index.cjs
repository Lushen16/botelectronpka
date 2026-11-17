'use strict';

/**
 * Entrada do botfinal — Dual-Transport.
 *
 *   --transport=native  canal real do jogo (padrao)
 *   --transport=mock    servidor local com mundo simulado
 *   --probe             so conecta e relata o canal; nao envia comando
 *   --version           imprime a versao de protocolo lida da configuracao
 *
 * A chave em modo native vem de --key, PKA_CHANNEL_KEY ou --key-file
 * (JSON com {pid, key}, contrato de reconstruction/native-adapter.cjs).
 * Em modo mock a chave e de teste e pode ser omitida.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createTransport, probeTransport, classify } = require('./core/pipe-transport.cjs');
const { NativeSession } = require('./core/native-session.cjs');
const { CommandDispatcher } = require('./core/command-dispatcher.cjs');
const { BotRuntime } = require('./core/bot-runtime.cjs');
const { MemoryScanner } = require('./core/memory-scanner.cjs');
const { UniversalActuator } = require('./core/universal-actuator.cjs');
const { StateArbiter, BOT_STATES } = require('./core/state-arbiter.cjs');
const { CombatEngine } = require('./engines/combat-engine.cjs');
const { WalkerEngine } = require('./engines/walker-engine.cjs');
const { HealerEngine } = require('./engines/healer-engine.cjs');
const { AutomationControl, STATE } = require('./core/automation-control.cjs');
const { ControlBridge } = require('./core/control-bridge.cjs');

const MOCK_KEY = 'mock-channel-key-000000000000';
const FAILURE_TEXT = {
  busy: 'Pipe ocupado: outro cliente mantem a instancia unica.',
  orphaned: 'Pipe existe mas o servidor nao atende (EPIPE / erro 233). O runtime nao re-arma nesta sessao.',
  missing: 'Pipe inexistente: o jogo nao esta injetado ou o PID esta errado.',
  'bad-key': 'Chave recusada: a prova do servidor nao confere.',
  unknown: 'Falha de canal nao classificada.',
};

function findGamePid() {
  try {
    const output = execSync(
      'powershell -NoProfile -Command "Get-Process PokeAlliance_dx -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"',
      { encoding: 'utf8' }).trim();
    const pids = output.split(/\r?\n/).map(row => Number(row.trim()))
      .filter(value => Number.isInteger(value) && value > 0);
    return pids[0] || null;
  } catch {
    return null;
  }
}

function loadConfig(file) {
  const configPath = file ? path.resolve(file) : path.resolve(__dirname, 'config/default-profile.json');
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function keyFromFile(file, pid) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.pid !== pid) throw Error('Arquivo de chave pertence a outro PID (' + record.pid + ' != ' + pid + ').');
  if (typeof record.key !== 'string' || !record.key) throw Error('Arquivo de chave sem campo key.');
  return record.key;
}

function parseArgs(argv) {
  const options = {
    pid: null, key: null, keyFile: null, config: null,
    transport: 'native', probe: false, rpm: false, version: false,
    seconds: 0, tickMs: undefined,
    auto: null, autoLease: false, autoBoot: false, autoWaitMs: 0,
    engine: true, walk: null, walkSteps: 1, walkVerifyMs: 1200, startModule: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pid') options.pid = Number(argv[++index]);
    else if (arg === '--key') options.key = argv[++index];
    else if (arg === '--key-file') options.keyFile = argv[++index];
    else if (arg === '--config') options.config = argv[++index];
    else if (arg.startsWith('--transport=')) options.transport = arg.split('=')[1];
    else if (arg === '--transport') options.transport = argv[++index];
    else if (arg === '--probe') options.probe = true;
    else if (arg === '--rpm') options.rpm = true;
    else if (arg === '--version') options.version = true;
    else if (arg === '--seconds') options.seconds = Number(argv[++index]);
    else if (arg === '--tick-ms') options.tickMs = Number(argv[++index]);
    else if (arg.startsWith('--auto=')) options.auto = arg.slice('--auto='.length);
    else if (arg === '--auto') options.auto = argv[++index];
    else if (arg === '--auto-lease') options.autoLease = true;
    else if (arg === '--auto-require-boot') options.autoBoot = true;
    else if (arg === '--auto-boot-wait') options.autoWaitMs = Number(argv[++index]) || 0;
    else if (arg.startsWith('--walk=')) options.walk = arg.slice('--walk='.length);
    else if (arg === '--walk') options.walk = argv[++index];
    else if (arg === '--walk-steps') options.walkSteps = Number(argv[++index]);
    else if (arg === '--walk-verify-ms') options.walkVerifyMs = Number(argv[++index]);
    else if (arg === '--no-engine') options.engine = false;
    else if (arg.startsWith('--start=')) options.startModule = arg.slice('--start='.length);
    else if (arg === '--start') options.startModule = argv[++index];
  }
  return options;
}


/**
 * Fatia vertical: um passo de caminhada pelo NOSSO executor, com verificacao
 * de efeito por coordenada.
 *
 *   --walk=north --walk-steps=1
 *
 * Cadeia exercitada:
 *   CLI -> WalkerEngine (decide direcao) -> CommandDispatcher (kind 9)
 *       -> Transport -> pka_native.dll execute_command -> PostMessageW(seta)
 *       -> telemetria do cliente -> posicao observada
 *
 * O que cada estagio prova:
 *   enfileirado/escrito  : chamada local
 *   recebido/aceito      : ACK status 0 do servidor
 *   executado            : NAO observavel pelo protocolo
 *   efeito               : posicao mudou no snapshot seguinte
 *
 * Sem mudanca de posicao, o resultado e' "efeito nao confirmado" — nunca
 * "funcionou".
 */
async function runWalk(options, transport) {
  const session = new NativeSession({ pid: transport.pid }).attach(transport);
  transport.on('error', () => {});

  const connected = await waitForSnapshot(session, 5000);
  if (!connected.ok) {
    console.error('[walk] sem state+telemetria: ' + connected.reason);
    await transport.close();
    return 2;
  }

  const before = session.snapshot();
  const startPos = before?.telemetry?.position;
  console.log('[walk] posicao inicial: ' + JSON.stringify(startPos));
  console.log('[walk] online=' + before.online + ' stale=' + before.stale
    + ' player=' + JSON.stringify(before.telemetry?.playerName ?? ''));

  if (!startPos || ![startPos.x, startPos.y, startPos.z].every(Number.isInteger)) {
    console.error('[walk] telemetria sem posicao inteira; nao ha como verificar efeito.');
    console.error('[walk] (a DLL devolve 0,0,0 quando nao resolve a entidade do jogador)');
    await transport.close();
    return 3;
  }

  const directions = { north: 0, east: 1, south: 2, west: 3,
    northeast: 4, southeast: 5, southwest: 6, northwest: 7 };
  const name = String(options.walk || 'north').toLowerCase();
  const direction = directions[name];
  if (!Number.isInteger(direction)) {
    console.error('[walk] direcao invalida: ' + options.walk
      + ' (use ' + Object.keys(directions).join('|') + ')');
    await transport.close();
    return 1;
  }

  const steps = Math.max(1, Math.min(Number(options.walkSteps) || 1, 10));
  const dispatcher = new CommandDispatcher({ transport, session, maxAgeMs: 3000 });
  const engine = new WalkerEngine({ walker: { enabled: true, waypoints: [] } });

  let verified = 0;
  let attempted = 0;
  const attempts = [];

  for (let index = 0; index < steps; index += 1) {
    attempted += 1;
    let record;
    try {
      /* O motor decide; o dispatcher executa e verifica. `verify: 'position'`
       * e' o unico criterio de efeito que temos hoje. */
      record = await dispatcher.send('walk', direction,
        { verify: 'position', verifyTimeoutMs: options.walkVerifyMs ?? 1200 });
    } catch (error) {
      attempts.push({ step: index + 1, ok: false, stage: 'dispatch',
        failure: error.code || 'error', message: error.message });
      console.log('[walk] passo ' + (index + 1) + ' recusado: '
        + (error.code || '?') + ' — ' + error.message);
      break;
    }
    const effect = record.effect || { changed: false };
    if (effect.changed) verified += 1;
    attempts.push({ step: index + 1, ok: record.effectVerified,
      delivery: record.delivery, effect });
    console.log('[walk] passo ' + (index + 1) + ': ack=' + record.delivery.accepted
      + ' efeito=' + (effect.changed ? 'SIM ' + JSON.stringify(effect.delta) : 'NAO')
      + (effect.reason ? ' (' + effect.reason + ')' : ''));
    /* Pausa entre passos: o motor tem cadencia natural (~280ms). */
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  /* Parada explicita: `stop` corta comandos novos no runtime. */
  let stopOk = null;
  try {
    const stopRecord = await dispatcher.send('stop', 0);
    stopOk = stopRecord.delivery.accepted;
    console.log('[walk] stop enviado (ack=' + stopOk + ')');
  } catch (error) {
    console.log('[walk] stop falhou: ' + error.message);
  }

  const after = session.snapshot();
  const endPos = after?.telemetry?.position;
  const summary = {
    at: new Date().toISOString(),
    pid: transport.pid,
    transport: options.transport,
    direction: name,
    stepsAttempted: attempted,
    stepsEffectVerified: verified,
    startPosition: startPos,
    endPosition: endPos,
    stopAccepted: stopOk,
    /* Honesto: sem posicao observada diferente, nada foi comprovado. */
    effectObserved: verified > 0,
    attempts,
  };
  console.log('[walk] RESUMO ' + JSON.stringify(summary));
  await transport.close();
  return verified > 0 ? 0 : 4;
}

/** Espera state+telemetria frescos. */
function waitForSnapshot(session, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const check = () => {
      const snap = session.snapshot();
      if (snap && snap.online && !snap.stale) { resolve({ ok: true }); return; }
      if (Date.now() >= deadline) {
        const last = session.snapshot();
        resolve({ ok: false, reason: last ? 'online=' + last.online + ' stale=' + last.stale
          : 'sem snapshot' });
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

/**
 * `--auto` envia UM comando kind 11 e sai.
 *
 *   --auto=start:target   --auto=stop:walker
 *   --auto=monitor:on     --auto=monitor:off
 *   --auto=pause:on       --auto=pause:off
 *
 * O kind 11 nao tem ACK: o resultado reportado e' `sent`, nunca `effect`.
 * Efeito so' se confirma no kind 6 / telemetria do cliente.
 */
async function runAutomation(options, transport) {
  const spec = String(options.auto || '');
  const [verb, arg] = spec.split(':');
  const control = new AutomationControl({
    transport,
    pid: transport.pid,
    withLease: options.autoLease,
    requireSessionBoot: options.autoBoot,
    bootWaitMs: options.autoWaitMs,
  });
  const connected = await control.connect({ timeoutMs: 5000 });
  if (!connected.ok) {
    console.error('[auto] connect falhou: ' + connected.failure + ' — ' + connected.message);
    await control.close();
    return 1;
  }
  console.log('[auto] pronto (boot=' + control.identity.boot
    + ' fonte=' + control.identity.bootSource + ')');

  let result;
  if (verb === 'start') result = await control.start(arg || 'target');
  else if (verb === 'stop') result = await control.stop(arg || 'target');
  else if (verb === 'monitor') result = await control.monitor(arg !== 'off');
  else if (verb === 'pause') result = await control.togglePause(arg === 'on');
  else {
    console.error('[auto] op invalido: ' + verb
      + ' (use start|stop|monitor|pause)');
    await control.close();
    return 1;
  }

  console.log('[auto] ' + JSON.stringify({
    ok: result.ok, op: result.op, seq: result.seq, bytes: result.bytes,
    module: result.module, bootSource: result.bootSource ?? null,
    sent: result.sent ?? false, effect: result.effect ?? null,
    failure: result.failure ?? null, message: result.message ?? null,
  }));
  await control.close();
  return result.ok ? 0 : 1;
}


function protocolVersion(config) {
  return {
    configSchema: config?.protocol?.schema ?? 2,
    pulseVersion: config?.protocol?.pulseVersion ?? 3,
    transport: config?.protocol?.transport ?? null,
  };
}

/**
 * Config efetiva do start.
 *
 * `--config` explicito vence. Sem ele, usa a config capturada do kind 11
 * (config/kind11/target-config.json), que tem os 23 waypoints e a combinacao
 * m5. O default-profile.json do bot nao tem waypoint nenhum e faria o walker
 * ser recusado pela validacao — o que seria correto, mas nao e' o que o
 * usuario pediu ao rodar `--start=walker`.
 */
function bridgeConfig(options, fallback) {
  if (options.config) return fallback;
  try {
    const base = require('./core/kind11-codec.cjs').baseConfig();
    /* Os motores esperam `enabled` para o arbitro escolher o estado. A config
     * capturada nao tem esse campo: ela existe no menu, nao no payload.
     * Preencher aqui e' adaptacao nossa ao nosso motor, nao invencao de
     * protocolo. */
    return {
      ...base,
      target: { ...base.target, enabled: true },
      walker: { ...base.walker, enabled: true },
      healer: { ...base.healer, enabled: base.healer?.enabled === true },
    };
  } catch {
    return fallback;
  }
}

function banner(text) {
  console.log('====================================================');
  console.log('  ' + text);
  console.log('====================================================');
}

function printProbeReport(report) {
  console.log('');
  console.log('[probe] transporte      : ' + report.mode);
  console.log('[probe] pid             : ' + report.pid);
  console.log('[probe] chave informada : ' + report.keyPresent);
  console.log('[probe] autenticado     : ' + report.authenticated);
  console.log('[probe] tempo           : ' + report.elapsedMs + ' ms');
  if (report.failure) {
    console.log('[probe] falha           : ' + report.failure.kind
      + (report.failure.code ? ' (' + report.failure.code + ')' : ''));
    console.log('[probe] detalhe         : ' + report.failure.message);
    console.log('[probe] leitura         : ' + (FAILURE_TEXT[report.failure.kind] || FAILURE_TEXT.unknown));
  }
  if (report.state) {
    console.log('[probe] state           : online=' + report.state.online
      + ' hp=' + report.state.healthPercent + ' targets=' + report.state.targetId);
  }
  if (report.telemetry) {
    const t = report.telemetry;
    console.log('[probe] telemetria      : tick=' + t.tick + ' jogador=' + JSON.stringify(t.playerName)
      + ' pos=' + JSON.stringify(t.position));
    console.log('[probe] criaturas       : ' + (t.creatures?.length ?? 0)
      + ' pet=' + (t.creatures?.filter(row => row.type === 3).map(row => row.name).join(',') || 'nenhum'));
  }
  console.log('[probe] resultado       : ' + (report.ok ? 'OK' : 'FALHOU (' + (report.reason || '?') + ')'));
}

async function runTransportMode(options, config) {
  const isMock = options.transport === 'mock';
  let pid = options.pid;
  if (!pid) {
    if (isMock) {
      pid = 45000 + (process.pid % 500);
      console.log('[*] Modo mock: pid simulado ' + pid);
    } else {
      console.log('[*] Buscando PokeAlliance_dx.exe...');
      pid = findGamePid();
      if (!pid) {
        console.error('[ERRO] PokeAlliance_dx.exe nao encontrado. Informe --pid.');
        return 1;
      }
    }
  }
  console.log('[+] Alvo: ' + (isMock ? 'mock local' : 'PokeAlliance_dx.exe') + ' (PID ' + pid + ')');

  let key = options.key || (isMock ? MOCK_KEY : process.env.PKA_CHANNEL_KEY || null);
  if (!key && options.keyFile) {
    try { key = keyFromFile(options.keyFile, pid); }
    catch (error) { console.error('[ERRO] ' + error.message); return 1; }
  }
  if (!key) {
    console.error('[ERRO] Chave ausente. Use --key, --key-file ou PKA_CHANNEL_KEY.');
    console.error('        Captura: python tools/find_channel_key.py --auto --write captures/channel-key.json');
    return 1;
  }

  const transportOptions = { pid, key, tickMs: options.tickMs };

  if (options.probe) {
    const { report } = await probeTransport(options.transport, { ...transportOptions, timeoutMs: 5000 });
    printProbeReport(report);
    return report.ok ? 0 : 1;
  }

  const transport = createTransport(options.transport, transportOptions);
  const session = new NativeSession({ pid }).attach(transport);
  transport.on('error', () => {});

  console.log('[*] Conectando (' + options.transport + ')...');
  try {
    await transport.connect();
  } catch (error) {
    const kind = error.failureKind || classify(error);
    console.error('[!] ' + (FAILURE_TEXT[kind] || FAILURE_TEXT.unknown));
    console.error('    ' + error.message);
    try { await transport.close(); } catch { /* ignore */ }
    return 1;
  }
  console.log('[+] Canal autenticado (HMAC-SHA256 nos dois sentidos).');

  /* kind 11: caminho de comando real do fornecedor. Um comando e sai. */
  if (options.auto) {
    const code = await runAutomation(options, transport);
    try { await transport.close(); } catch { /* ignore */ }
    return code;
  }

  /* Fatia vertical: um passo de caminhada pelo NOSSO executor. */
  if (options.walk) {
    const code = await runWalk(options, transport);
    return code;
  }

  /* Modo posse: mantem o canal sem deixar os motores despacharem kind 9. */
  if (!options.engine) {
    console.log('[RUN] Canal em posse, motores desligados (--no-engine). Ctrl+C para sair.');
    let done = false;
    const shutdown = async () => {
      if (done) return; done = true;
      try { await transport.close(); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGINT', () => { void shutdown(); });
    if (options.seconds > 0) setTimeout(() => { void shutdown(); }, options.seconds * 1000);
    return null;
  }

  const config2 = config;
  const arbiter = new StateArbiter(config2);
  const combat = new CombatEngine(config2);
  const walker = new WalkerEngine(config2);
  const healer = new HealerEngine(config2);
  const dispatcher = new CommandDispatcher({ transport, session, maxAgeMs: 3000 });
  const runtime = new BotRuntime({
    session, transport, config: config2, combat, walker, healer, arbiter, dispatcher,
  });

  /* Superficie de controle do NOSSO bot.
   *
   * NAO e' kind 11. Um cliente de named pipe nunca recebe o frame que ele
   * mesmo envia, e um segundo cliente (um menu) mandaria kind 11 para a MESMA
   * DLL, nao para este processo — os globais da DLL sao compartilhados entre
   * sessoes. Tentar escutar kind 11 aqui foi um erro de desenho: comprovado
   * com dois clientes no mesmo pipe em 2026-11-05 10:19.
   *
   * Quem arma os motores e' o nosso CLI/UI. O kind 11 continua sendo a
   * superficie de COMPATIBILIDADE com o menu do fornecedor, tratada na DLL.
   */
  const bridge = new ControlBridge({
    runtime, config: config2, combat, walker, healer, arbiter,
  });

  runtime.on('change', state => {
    const last = state.last;
    if (!last) return;
    process.stdout.write('\r[' + options.transport.toUpperCase() + '] ' + state.state + ' :: '
      + (last.status || '-') + (last.action ? '/' + last.action : '')
      + (last.reason ? ' (' + last.reason + ')' : '') + '            ');
  });

  /* Nada dispara no launch. `--start=<module>` arma o motor explicitamente,
   * com a config validada pelo bridge. Sem isso o runtime fica parado. */
  if (options.startModule) {
    const armed = await bridge.start(options.startModule, bridgeConfig(options, config2));
    console.log('[RUN] ' + JSON.stringify({ armed: armed.action, module: options.startModule,
      modules: bridge.state.modules, issues: armed.issues ?? null }));
    if (armed.action !== 'started') {
      try { await transport.close(); } catch { /* ignore */ }
      return 5;
    }
  } else {
    console.log('[RUN] Runtime conectado, motores PARADOS. Use --start=walker|target.');
  }
  console.log('[RUN] ' + options.transport + ' pronto. Ctrl+C para sair.');

  let finished = false;
  const shutdown = async code => {
    if (finished) return;
    finished = true;
    runtime.stop();
    try { await runtime.pause(); } catch { /* ignore */ }
    try { await transport.close(); } catch { /* ignore */ }
    const summary = {
      ticks: runtime.ticks, commands: dispatcher.log.length,
      lastState: runtime.state.state, last: runtime.last,
    };
    console.log('\n[FIM] ' + JSON.stringify(summary));
    process.exit(code ?? 0);
  };
  process.on('SIGINT', () => { void shutdown(0); });

  if (options.seconds > 0) {
    setTimeout(() => { void shutdown(0); }, options.seconds * 1000).unref?.();
  }
  return null;
}

async function runRpm(pid, config) {
  const scanner = new MemoryScanner(pid);
  const actuator = new UniversalActuator({ pid });
  const arbiter = new StateArbiter(config);
  const combat = new CombatEngine(config);
  const walker = new WalkerEngine(config);
  const probe = await actuator.start();
  if (probe?.hwnd) console.log('[+] Janela: ' + probe.title + ' (' + probe.hwnd + ')');
  console.log('[RUN] Modo RPM: leitura direta + PostMessageW.');
  console.log('[!] Este modo NAO usa o canal nativo; capture/hoenn ficam limitados.');

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const snapshot = await scanner.scan();
      if (!snapshot?.player) return;
      const telemetry = {
        position: snapshot.player.pos,
        playerName: snapshot.player.name,
        healthPercent: snapshot.player.healthPercent,
        creatures: snapshot.creatures,
        ownPokemon: snapshot.creatures.find(row => row.isOwnPokemon || row.creatureType === 3) || null,
      };
      const candidates = combat.filterValidTargets(telemetry);
      const state = arbiter.evaluate(telemetry, {
        inCombat: combat.targetId !== null,
        validTargets: candidates,
        isLureReady: combat.isLureConditionMet(telemetry, candidates),
        isRevivePending: false,
      });
      if (state === BOT_STATES.COMBAT) {
        walker.pause();
        await combat.tick(telemetry, actuator);
      } else if (state === BOT_STATES.WALKING) {
        combat.clearTarget();
        walker.resume();
        await walker.tick(telemetry, actuator);
      }
    } catch {
      // Leitura pode falhar entre snapshots.
    } finally {
      busy = false;
    }
  }, 100);
  return null;
}

async function main() {
  banner('BOT FINAL - DUAL-TRANSPORT');
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.config);

  console.log('[cfg] protocolo: schema=' + protocolVersion(config).configSchema
    + ' pulse=' + protocolVersion(config).pulseVersion);
  console.log('[cfg] transporte: ' + options.transport);

  if (options.version) {
    console.log(JSON.stringify(protocolVersion(config)));
    return 0;
  }

  if (options.rpm) {
    let pid = options.pid;
    if (!pid) {
      pid = findGamePid();
      if (!pid) { console.error('[ERRO] PokeAlliance_dx.exe nao encontrado.'); return 1; }
    }
    await runRpm(pid, config);
    return null;
  }

  return runTransportMode(options, config);
}

main().then(code => {
  if (typeof code === 'number') process.exit(code);
}).catch(error => {
  console.error('[FATAL] ' + (error.stack || error.message));
  process.exit(1);
});
