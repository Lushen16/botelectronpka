'use strict';

/**
 * Sessao de captura contra o Shiba Bot validado.
 *
 *   node tools/tap_session.cjs --inject           # injeta o tap no jogo atual
 *   node tools/tap_session.cjs --watch            # so acompanha o log crescendo
 *   node tools/tap_session.cjs --report           # decodifica a ultima sessao
 *   node tools/tap_session.cjs --compare <arq>    # diff contra outra captura
 *
 * Fluxo recomendado (o bot deles precisa funcionar normalmente):
 *   1. feche o jogo
 *   2. node tools\tap_session.cjs --inject        (espera o jogo, injeta o tap)
 *   3. abra o launcher, autentique, clique em ENTRAR -> menu deles injeta a DLL
 *   4. deixe o bot rodando o que voce quer reconstruir (combo, lure, walker)
 *   5. node tools\tap_session.cjs --report
 *
 * O tap nao cria pipe nem fala o protocolo: so registra. O menu deles segue
 * dono da instancia unica.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const decoder = require('./tap_decode.cjs');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const INJECTOR = path.join(NATIVE, 'pka_inject.exe');
const CAPTURES = path.join(ROOT, 'captures');
const GAME = 'PokeAlliance_dx.exe';

/**
 * A DLL do tap a usar. Se native\pka_tap.dll estiver travada por um jogo aberto,
 * o build grava pka_tap_new.dll. Escolhemos sempre a mais NOVA, senao o teste
 * roda a versao velha e da um FAIL que nao e do codigo.
 */
function pickTap() {
  const candidates = [path.join(NATIVE, 'pka_tap.dll'), path.join(NATIVE, 'pka_tap_new.dll')]
    .filter(file => fs.existsSync(file))
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file || path.join(NATIVE, 'pka_tap.dll');
}

const TAP_DLL = pickTap();

function args(argv) {
  const options = { inject: false, watch: false, report: false, compare: null,
    out: null, wait: 0, seconds: 0, pid: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--inject') options.inject = true;
    else if (argv[i] === '--watch') options.watch = true;
    else if (argv[i] === '--report') options.report = true;
    else if (argv[i] === '--compare') options.compare = argv[++i];
    else if (argv[i] === '--out') options.out = argv[++i];
    else if (argv[i] === '--wait') options.wait = Number(argv[++i]);
    else if (argv[i] === '--seconds') options.seconds = Number(argv[++i]);
    else if (argv[i] === '--pid') options.pid = Number(argv[++i]);
  }
  return options;
}

function stamp() {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function findGame() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-Process ' + GAME.replace('.exe', '') + ' -ErrorAction SilentlyContinue | ' +
      'Select-Object -First 1 -ExpandProperty Id)'], { encoding: 'utf8' }).trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function waitForGame(timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  process.stdout.write('esperando ' + GAME);
  while (Date.now() < deadline) {
    const pid = findGame();
    if (pid) { console.log('\n' + GAME + ' aberto: pid=' + pid); return pid; }
    process.stdout.write('.');
    execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'],
      { stdio: 'ignore' });
  }
  console.log('');
  return null;
}

function inject(pid, tapOut) {
  for (const file of [TAP_DLL, INJECTOR]) {
    if (!fs.existsSync(file)) {
      throw Error('faltando ' + file + '\nrode: node tools\\build_native.cjs');
    }
  }
  /* Copia a DLL para um nome unico antes de injetar.
   *
   * Motivo: Windows trava o arquivo enquanto ele esta mapeado em um processo.
   * Se injetarmos native\pka_tap.dll direto, o proximo build morre com
   * "Permission denied" (lld-link) enquanto o jogo estiver aberto - foi o que
   * aconteceu. Com copia por injecao, o build sempre pode sobrescrever o
   * original. O nome unico tambem deixa o tap derivar pka_tap_<pid>.jsonl
   * ao lado da copia sem colidir. */
  const staged = path.join(NATIVE, `staged_${pid}_${Date.now()}.dll`);
  fs.copyFileSync(TAP_DLL, staged);
  const env = { ...process.env, PKA_TAP_OUT: tapOut, PKA_TAP_ALL: '1' };
  try {
    const output = execFileSync(INJECTOR, ['--pid', String(pid), '--dll', staged],
      { env, encoding: 'utf8', timeout: 30000 });
    process.stdout.write(output);
  } finally {
    /* a copia pode ficar travada se o LoadLibrary deu certo; tenta limpar
     * depois que o processo morrer, sem quebrar a injecao se falhar */
    setTimeout(() => { try { fs.unlinkSync(staged); } catch { /* ainda mapeada */ } }, 500).unref?.();
  }
}

/** O arquivo onde o tap daquele PID realmente escreveu. */
function tapFileFor(pid) {
  const beside = path.join(NATIVE, 'pka_tap_' + pid + '.jsonl');
  const temp = path.join(os.tmpdir(), 'pka_tap_' + pid + '.jsonl');
  if (fs.existsSync(beside)) return beside;
  if (fs.existsSync(temp)) return temp;
  return null;
}

function bootLogTail(lines = 4) {
  const file = path.join(os.tmpdir(), 'pka_tap_boot.log');
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

/** O menu do fornecedor: Electron com --client-pid=<pid do jogo>. */
function findMenu(gamePid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process -Filter "Name=\'electron.exe\' or Name like \'%.tmp\'" | ' +
      'Where-Object { $_.CommandLine -match \'--client-pid=' + gamePid + '\' } | ' +
      'Select-Object -First 1 -ExpandProperty ProcessId'], { encoding: 'utf8' }).trim();
    const pid = Number(out);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function doInject(options) {
  fs.mkdirSync(CAPTURES, { recursive: true });

  let pid = options.pid || findGame();
  if (!pid && options.wait > 0) pid = waitForGame(options.wait);
  if (!pid) {
    throw Error(GAME + ' nao esta rodando. Abra o jogo, ou use --wait 300.');
  }

  console.log('tap no jogo (pid=' + pid + ')');
  inject(pid, path.join(CAPTURES, 'tap-game-' + pid + '.jsonl'));

  /* A DLL deles roda DENTRO do jogo (server do pipe). O menu Electron e o
   * cliente. Tem que tapar os dois, senao so vemos metade da conversa. */
  const menuPid = findMenu(pid);
  if (menuPid) {
    console.log('tap no menu (pid=' + menuPid + ')');
    try {
      inject(menuPid, path.join(CAPTURES, 'tap-menu-' + menuPid + '.jsonl'));
    } catch (error) {
      console.log('  aviso: tap no menu falhou: ' + error.message.split('\n')[0]);
    }
  } else {
    console.log('\nmenu do fornecedor ainda nao esta aberto neste jogo.');
    console.log('rode de novo com --inject depois que o menu abrir, ou');
    console.log('inje te manualmente: native\\pka_inject.exe --name electron.exe --dll native\\pka_tap.dll');
  }

  const boot = bootLogTail();
  if (boot) console.log('\nboot log:\n' + boot);

  const gameFile = tapFileFor(pid);
  console.log('\ntap ativo. arquivos:');
  if (gameFile) console.log('  jogo: ' + gameFile);
  if (menuPid) {
    const menuFile = tapFileFor(menuPid);
    if (menuFile) console.log('  menu: ' + menuFile);
  }
  console.log('\nagora use o bot deles normalmente.');
  console.log('quando terminar: node tools\\tap_session.cjs --report');
}

function doReport() {
  /* Agrega todos os taps da sessao (jogo + menu). */
  if (!fs.existsSync(CAPTURES)) throw Error('nenhuma captura em ' + CAPTURES);
  const files = fs.readdirSync(CAPTURES)
    .filter(name => /^tap-.*\.jsonl$/.test(name) || /^pka_tap_\d+\.jsonl$/.test(name))
    .map(name => path.join(CAPTURES, name))
    .filter(file => fs.statSync(file).size > 0)
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  if (!files.length) throw Error('nenhum tap com conteudo em ' + CAPTURES);
  for (const file of files) {
    console.log('\n' + '='.repeat(70));
    execFileSync(process.execPath, [path.join(__dirname, 'tap_decode.cjs'), '--in', file],
      { stdio: 'inherit' });
  }
}

function doWatch(options) {
  const file = options.out || latestCapture();
  if (!file) throw Error('nenhuma captura em ' + CAPTURES);
  console.log('acompanhando ' + file + ' (Ctrl+C para sair)');
  let seen = 0;
  const deadline = options.seconds ? Date.now() + options.seconds * 1000 : Infinity;
  const timer = setInterval(() => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size === seen) return;
    seen = size;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    const records = lines.map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    const frames = decoder.framesByDirection(records);
    const counts = {};
    for (const dir of ['c2s', 's2c']) {
      for (const frame of frames[dir]) {
        const key = dir + ':' + (decoder.KIND[frame.kind] || 'kind' + frame.kind);
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    const summary = Object.keys(counts).sort((a, b) => counts[b] - counts[a])
      .slice(0, 8).map(key => key + '=' + counts[key]).join('  ');
    console.log(size + 'b  ' + records.length + ' reg  ' + summary);
    if (Date.now() > deadline) { clearInterval(timer); }
  }, 3000);
}

function latestCapture() {
  if (!fs.existsSync(CAPTURES)) return null;
  const files = fs.readdirSync(CAPTURES).filter(name => /^tap-.*\.jsonl$/.test(name))
    .map(name => path.join(CAPTURES, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function report(file) {
  const target = file || latestCapture();
  if (!target) throw Error('nenhuma captura em ' + CAPTURES);
  execFileSync(process.execPath, [path.join(__dirname, 'tap_decode.cjs'), '--in', target],
    { stdio: 'inherit' });
}

/**
 * Diff de vocabulario: quais comandos/tipos o Shiba usa e o nosso botfinal ainda
 * nao emite, e quais campos de telemetria eles publicam e nos nao modelamos.
 */
function compare(ours, theirs) {
  const load = file => decoder.framesByDirection(
    fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean));

  const summarize = frames => {
    const commands = {};
    const kinds = {};
    const fields = new Set();
    for (const dir of ['c2s', 's2c']) {
      for (const frame of frames[dir]) {
        const name = decoder.KIND[frame.kind] || 'kind' + frame.kind;
        kinds[dir + ':' + name] = (kinds[dir + ':' + name] || 0) + 1;
        if (frame.kind === 9) {
          const manual = decoder.describeManual(frame.payload);
          commands[manual.command] = (commands[manual.command] || 0) + 1;
        }
        if (frame.kind === 5) {
          const tel = decoder.describeTelemetry(frame.payload);
          if (tel.fields) for (const field of tel.fields) fields.add(field);
        }
      }
    }
    return { commands, kinds, fields };
  };

  const mine = summarize(load(ours));
  const shiba = summarize(load(theirs));

  console.log('nosso : ' + ours);
  console.log('shiba : ' + theirs);

  const onlyTheirs = Object.keys(shiba.commands).filter(c => !mine.commands[c]);
  const onlyMine = Object.keys(mine.commands).filter(c => !shiba.commands[c]);
  console.log('\n-- comandos que o Shiba usa e nos nao --');
  for (const command of onlyTheirs.sort()) {
    console.log('  ' + command.padEnd(18) + 'x' + shiba.commands[command]);
  }
  if (!onlyTheirs.length) console.log('  (nenhum)');

  console.log('\n-- comandos nossos que o Shiba nao usou na captura --');
  for (const command of onlyMine.sort()) {
    console.log('  ' + command.padEnd(18) + 'x' + mine.commands[command]);
  }
  if (!onlyMine.length) console.log('  (nenhum)');

  const missingFields = [...shiba.fields].filter(f => !mine.fields.has(f)).sort();
  console.log('\n-- campos de telemetria que eles publicam e nao modelamos --');
  if (missingFields.length) for (const field of missingFields) console.log('  ' + field);
  else console.log('  (nenhum)');

  const extraFields = [...mine.fields].filter(f => !shiba.fields.has(f)).sort();
  console.log('\n-- campos nossos que eles nao publicam --');
  if (extraFields.length) for (const field of extraFields) console.log('  ' + field);
  else console.log('  (nenhum)');

  console.log('\n-- contagem de frames --');
  const keys = new Set([...Object.keys(mine.kinds), ...Object.keys(shiba.kinds)]);
  for (const key of [...keys].sort()) {
    console.log('  ' + key.padEnd(26) + 'nos=' + (mine.kinds[key] || 0) +
      '  shiba=' + (shiba.kinds[key] || 0));
  }
}

function main() {
  const options = args(process.argv.slice(2));
  if (options.compare) {
    const ours = options.out || latestCapture();
    if (!ours) throw Error('informe nossa captura com --out');
    return compare(ours, options.compare);
  }
  if (options.inject) return doInject(options);
  if (options.watch) return doWatch(options);
  if (options.report && options.out) return report(options.out);
  if (options.report) return doReport();
  if (options.out) return report(options.out);

  console.log('uso:');
  console.log('  node tools\\tap_session.cjs --inject [--wait 300] [--out arq]');
  console.log('  node tools\\tap_session.cjs --watch  [--seconds 120]');
  console.log('  node tools\\tap_session.cjs --report [--out arq]');
  console.log('  node tools\\tap_session.cjs --compare captura-shiba.jsonl [--out nossa.jsonl]');
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
