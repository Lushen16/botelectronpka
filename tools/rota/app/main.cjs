'use strict';

/**
 * PKA Rota — app Electron com a interface de rota e combate.
 *
 * Este main NAO sobe servidor HTTP: a UI e' carregada direto de arquivo e fala
 * com o processo principal por IPC (preload + contextBridge). Diferente da
 * versao de navegador em tools/rota/servidor.cjs, aqui nao ha porta aberta —
 * mais seguro para um executavel que o usuario roda na maquina dele.
 *
 * O QUE ELE FAZ
 *   1. acha o PokeAlliance_dx.exe com personagem
 *   2. injeta native/pka_native.dll se ainda nao estiver carregada
 *   3. espera o pipe subir e gera captures/channel-key-<pid>.json
 *   4. conecta no canal nativo e repassa telemetria para a UI
 *   5. executa walk/attack/combo/potion/revive/hotkey que a UI pedir
 *
 * ORQUESTRACAO (autopilot): a UI desenha a rota; o loop de decisao fica AQUI,
 * no processo principal, e nao no renderer. Motivo: o renderer pode ser
 * suspenso pelo Electron quando a janela perde foco (throttling de timers de
 * background), e um bot que para de andar quando o usuario troca de janela
 * nao serve. O main continua rodando com a janela minimizada.
 */

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

/* __dirname = <raiz>/tools/rota/app quando rodando do repo.
 * Empacotado, o layout e' dist/PKA-Rota/resources/app/app/... — por isso a
 * raiz e' resolvida subindo ate' achar `native/pka_native.dll`. */
function findRoot(start) {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'native', 'pka_native.dll'))) return d;
    if (fs.existsSync(path.join(d, 'native', 'pka_native.c'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(start, '..', '..', '..');
}

const ROOT = findRoot(__dirname);
const LOG = msg => {
  const line = `[${new Date().toLocaleTimeString('pt-BR', { hour12: false })}] ${msg}`;
  console.log(line);
  if (win && !win.isDestroyed()) win.webContents.send('log', line);
};

let win = null;
let transport = null;
let lastTelemetry = null;
let connected = null;      // { pid, key }
let injecting = false;
let mapReader = null;      // OtmmReader do minimapa do jogo
let mapFile = null;
let lure = null;           // DynamicLure (perfect lure do Shiba)
let lureConfig = null;

/* ───────────── perfect lure ───────────── */

/* O DynamicLure existe em botfinal/engines/dynamic-lure.cjs e foi extraido da
 * captura real do Shiba (6.616 frames, PID 17748). Ele NAO planeja o arco
 * otimo — reproduz os micro-ajustes medidos:
 *
 *   travel      anda (rota normal)      ~3.672 ms
 *   arc         micro-ajuste ±1 tile       32 ms
 *   stationary  parado agrupando          234 ms
 *   wait        espera curta            1.406 ms
 *
 * Regra de saida: formacao fechou (boxed >= minWilds) OU hp do tank baixo
 * OU timeout. So' entao o combo pode sair.
 *
 * WHY roda no main: o renderer tem contextIsolation e nao tem `require`.
 * Alem disso o lure precisa continuar decidindo com a janela atras. */
function ensureLure() {
  if (lure) return lure;
  const { DynamicLure } = require(path.join(ROOT, 'botfinal', 'engines', 'dynamic-lure.cjs'));
  lureConfig = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'botfinal', 'config', 'kind11', 'target-config.json'), 'utf8'
  ).replace(/^\uFEFF/u, ''));
  lure = new DynamicLure(lureConfig);
  /* Loga o valor EFETIVO (lureConfig do engine), nao os campos crus do
   * arquivo. Antes lia hoenn.bestTileRange, que e' o raio de "melhor tile",
   * nao o raio do lure — o log dizia range=4 quando o valor real era 3. */
  const c = lure.lureConfig;
  LOG(`perfect lure carregado: min ${c.minWilds} selvagens em ${c.range} tiles, `
    + `hp emergencia ${c.minHpPercent}%, timeout ${c.timeoutMs} ms`);
  return lure;
}

/* ───────────── mapa (OTMM) ───────────── */

/* O mapa de verdade esta' no perfil do jogador, nao no repositorio:
 *
 *   %APPDATA%\PokeAlliance\PokeAllianceV3\minimap854.otmm
 *
 * O arquivo do repo (analysis/shiba_asar/assets/minimap.otmm) e' uma copia do
 * fornecedor e pode estar desatualizado. O do perfil e' o que o JOGO gravou —
 * logo tem exatamente as areas que o personagem ja' viu. Preferir sempre ele,
 * e cair no do repo so' como ultimo recurso.
 *
 * Formato OTMM documentado em reconstruction/REPORT_OTMM_MINIMAP.md:
 * blocos de 64x64, zlib, 3 bytes por tile (flags, color, speed).
 * Leitor pronto: reconstruction/otmm.cjs (testado, 34k blocos, 16 andares). */
function findMapFile() {
  const roaming = process.env.APPDATA
    || path.join(os.homedir(), 'AppData', 'Roaming');
  const candidatos = [
    path.join(roaming, 'PokeAlliance', 'PokeAllianceV3', 'minimap854.otmm'),
    path.join(ROOT, 'analysis', 'shiba_asar', 'assets', 'minimap.otmm'),
    path.join(ROOT, 'extracted_v3.3.1', 'assets', 'minimap.otmm'),
  ];
  for (const c of candidatos) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function openMap() {
  if (mapReader) return { ok: true, file: mapFile, reused: true };
  const f = findMapFile();
  if (!f) return { ok: false, error: 'nenhum minimap .otmm encontrado' };
  try {
    const { OtmmReader } = require(path.join(ROOT, 'reconstruction', 'otmm.cjs'));
    const t0 = Date.now();
    mapReader = new OtmmReader(f);
    mapFile = f;
    LOG(`mapa carregado em ${Date.now() - t0} ms: ${mapReader.index.size} blocos, `
      + `${mapReader.floors.size} andares`);
    LOG('arquivo: ' + f);
    return {
      ok: true, file: f, filename: mapReader.filename,
      blocks: mapReader.index.size, floors: [...mapReader.floors].sort((a, b) => a - b),
    };
  } catch (e) {
    return { ok: false, error: 'falha ao abrir o mapa: ' + e.message };
  }
}

/* Regiao do mapa como PNG cru (RGBA) + flags, para o renderer desenhar.
 * Devolve os pixels em base64 em vez de JSON de numeros: 60x50 tiles = 3000
 * pixels = 12 KB binario, ~16 KB em base64 — JSON de array seria ~30 KB. */
function mapRegion(x, y, z, w, h) {
  if (!mapReader) {
    const r = openMap();
    if (!r.ok) return { ok: false, error: r.error };
  }
  try {
    const reg = mapReader.getRegion(x, y, z, w, h);
    return {
      ok: true, x, y, z, width: w, height: h,
      pixelsBase64: Buffer.from(reg.pixels.buffer, reg.pixels.byteOffset, reg.pixels.byteLength).toString('base64'),
      flagsBase64: Buffer.from(reg.flags.buffer, reg.flags.byteOffset, reg.flags.byteLength).toString('base64'),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ───────────── descoberta do processo ───────────── */

function psJson(script) {
  const out = execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true }).trim();
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

function findGameProcesses() {
  let list = psJson(
    'Get-Process PokeAlliance_dx -ErrorAction SilentlyContinue | '
    + 'Select-Object Id,MainWindowTitle | ConvertTo-Json -Compress'
  );
  if (!list) return [];
  if (!Array.isArray(list)) list = [list];
  return list.map(p => ({
    pid: p.Id,
    title: String(p.MainWindowTitle || '').trim(),
    hasChar: !/crashed/iu.test(String(p.MainWindowTitle || ''))
      && /^PokeAlliance\s+-\s+\S/u.test(String(p.MainWindowTitle || '').trim()),
  }));
}

function dllLoaded(pid) {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Modules | `
      + "Where-Object { $_.ModuleName -eq 'pka_native.dll' } | "
      + 'Select-Object -ExpandProperty ModuleName',
    ], { encoding: 'utf8', windowsHide: true }).trim();
    return out.includes('pka_native.dll');
  } catch { return false; }
}

function pipeExists(pid) {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | `
      + `Where-Object { $_ -match 'pka-runtime-2-${pid}$' }`,
    ], { encoding: 'utf8', windowsHide: true }).trim();
    return out.length > 0;
  } catch { return false; }
}

function genKey(pid) {
  const src = path.join(ROOT, 'native', 'pka_channel_key.txt');
  if (!fs.existsSync(src)) throw Error('sem native/pka_channel_key.txt (a DLL escreve ao iniciar)');
  const key = fs.readFileSync(src, 'utf8').trim();
  if (!/^[0-9a-f]{32}$/iu.test(key)) throw Error('chave invalida em pka_channel_key.txt');
  const out = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    capturedAt: new Date().toISOString(), pid, key, source: 'native-file',
  }, null, 1) + '\n');
  return key;
}

/* ───────────── injecao ───────────── */

async function ensureInjected(pid) {
  if (dllLoaded(pid)) { LOG(`dll ja carregada no pid ${pid}`); return; }
  const inj = path.join(ROOT, 'native', 'pka_inject.exe');
  const dll = path.join(ROOT, 'native', 'pka_native.dll');
  if (!fs.existsSync(inj)) throw Error('sem native/pka_inject.exe — rode: node tools/build_native.cjs');
  if (!fs.existsSync(dll)) throw Error('sem native/pka_native.dll — rode: node tools/build_native.cjs');
  LOG('injetando pka_native.dll...');
  const r = execFileSync(inj, ['--pid', String(pid), '--dll', dll], {
    encoding: 'utf8', windowsHide: true,
  });
  r.trim().split('\n').forEach(l => LOG('  ' + l));
}

async function waitPipe(pid, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pipeExists(pid)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/* ───────────── canal ───────────── */

async function connect(pid, { inject = true } = {}) {
  if (connected && connected.pid === pid && transport) {
    return { ok: true, pid, reused: true };
  }
  if (transport) { try { transport.close(); } catch {} transport = null; }

  if (inject) await ensureInjected(pid);
  LOG(`aguardando canal do pid ${pid}...`);
  if (!await waitPipe(pid)) throw Error(`pipe pka-runtime-2-${pid} nao apareceu`);
  LOG('canal no ar');

  const key = genKey(pid);
  const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));

  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    const t = new NativeTransport({ pid, key });
    t.on('telemetry', v => {
      lastTelemetry = v;
      if (win && !win.isDestroyed()) win.webContents.send('telemetry', v);
    });
    t.on('state', v => { if (win && !win.isDestroyed()) win.webContents.send('state', v); });
    t.on('error', e => LOG('canal erro: ' + e.message));
    t.on('close', () => LOG('canal fechado'));
    try {
      await t.connect();
      transport = t;
      connected = { pid, key };
      LOG(`conectado ao pid ${pid}`);
      return { ok: true, pid };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      if (/ENOENT|no such file|inexistente/iu.test(msg)) {
        throw Error('canal inexistente — a DLL esta injetada? (' + msg + ')');
      }
      if (!/Handshake expirou|busy|EAGAIN|EBUSY/iu.test(msg)) throw e;
      LOG(`canal ocupado (${i + 1}/4); nova tentativa...`);
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw Error('canal continua ocupado: ' + (lastErr ? lastErr.message : '?'));
}

/* ───────────── comandos ───────────── */

const ALLOWED = new Set(['walk', 'attack', 'combo', 'potion', 'revive', 'hotkey', 'stop', 'switchPokemon']);

async function sendCommand(name, parameter, options) {
  if (!ALLOWED.has(name)) throw Error(`comando "${name}" nao permitido`);
  if (!transport) throw Error('sem canal');
  const ack = await transport.sendCommand(name, parameter, options);
  return ack;
}

/* ───────────── IPC ───────────── */

function registerIpc() {
  ipcMain.handle('scan', async () => {
    const procs = findGameProcesses();
    return procs.map(p => ({ ...p, dll: dllLoaded(p.pid), pipe: pipeExists(p.pid) }));
  });

  ipcMain.handle('connect', async (_e, pid, opts) => {
    if (injecting) return { ok: false, error: 'ja injetando' };
    injecting = true;
    try {
      return await connect(Number(pid), opts || {});
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      injecting = false;
    }
  });

  ipcMain.handle('disconnect', async () => {
    if (transport) { try { transport.close(); } catch {} }
    transport = null; connected = null; lastTelemetry = null;
    return { ok: true };
  });

  ipcMain.handle('command', async (_e, name, parameter, options) => {
    try { return { ok: true, ack: await sendCommand(name, parameter, options) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('status', async () => ({
    connected, hasTransport: Boolean(transport),
    telemetry: lastTelemetry,
    root: ROOT,
  }));

  ipcMain.handle('save-route', async (_e, pid, waypoints) => {
    try {
      const clean = (waypoints || []).map((w, i) => {
        const p = w.pos || {};
        if (![p.x, p.y, p.z].every(Number.isInteger)) throw Error(`waypoint ${i} invalido`);
        return {
          action: typeof w.action === 'string' ? w.action : 'walk',
          pos: { x: p.x, y: p.y, z: p.z },
          param: w.param == null ? '' : String(w.param),
        };
      });
      const file = path.join(ROOT, 'captures', 'routes', `desenho-${pid}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        pid, waypoints: clean, updatedAt: new Date().toISOString(),
      }, null, 2));
      return { ok: true, file };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('load-route', async (_e, pid) => {
    try {
      const file = path.join(ROOT, 'captures', 'routes', `desenho-${pid}.json`);
      if (!fs.existsSync(file)) return { ok: true, route: null };
      return { ok: true, route: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('open-folder', async (_e, which) => {
    const map = {
      routes: path.join(ROOT, 'captures', 'routes'),
      root: ROOT,
      log: path.join(process.env.TEMP || '.', 'pka_native.log'),
    };
    const target = map[which];
    if (target) shell.showItemInFolder(target);
    return { ok: Boolean(target) };
  });

  /* ── mapa ── */
  ipcMain.handle('map-open', async () => openMap());
  ipcMain.handle('map-region', async (_e, x, y, z, w, h) => mapRegion(x, y, z, w, h));

  /* ── perfect lure ── */
  ipcMain.handle('lure-decide', async (_e, ctx) => {
    try {
      const l = ensureLure();
      const tel = lastTelemetry;
      if (!tel) return { ok: false, error: 'sem telemetria' };
      const r = l.decide(tel, {
        now: Date.now(),
        comboReady: Boolean(ctx && ctx.comboReady),
        walkerMoving: Boolean(ctx && ctx.walkerMoving),
      });
      return { ok: true, ...r, config: l.lureConfig };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('lure-config', async () => {
    try {
      const l = ensureLure();
      return { ok: true, config: l.lureConfig, raw: lureConfig };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* Ajuste ao vivo dos tres numeros do perfect lure:
   *   minWilds      quantos selvagens no raio para soltar o combo
   *   range         raio em tiles ao redor do POKEMON
   *   minHpPercent  HP de emergencia (comba mesmo sem fechar a formacao)
   * Nao reescreve arquivo: vale para a sessao. */
  ipcMain.handle('lure-set', async (_e, overrides) => {
    try {
      const l = ensureLure();
      const cfg = l.setOverrides(overrides || {});
      LOG(`lure ajustado: min=${cfg.minWilds} range=${cfg.range} hp=${cfg.minHpPercent}%`);
      return { ok: true, config: cfg };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /* Roster da config real: fonte do UUID que o combo por `talk` exige.
   * A DLL nao publica uuid; a config do Shiba tem (hoenn.roster). */
  ipcMain.handle('roster', async () => {
    try {
      ensureLure();  // garante lureConfig carregado
      const roster = (lureConfig && lureConfig.hoenn && lureConfig.hoenn.roster) || [];
      const combo = (lureConfig && lureConfig.target && lureConfig.target.combo) || {};
      const hoenn = (lureConfig && lureConfig.hoenn) || {};
      return {
        ok: true,
        roster: roster.map(r => ({ name: r.name, uuid: r.uuid || r.key, role: r.role })),
        comboText: combo.sequenceText || 'm5',
        potionSlot: hoenn.potionActionBar || 3,
        potionHpPercent: hoenn.potionHpPercent || 60,
        reviveKey: (lureConfig && lureConfig.target && lureConfig.target.autoRevive
          && lureConfig.target.autoRevive.hotkey) || 'f',
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

/* ───────────── janela ───────────── */

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'PKA Rota — Combate',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // nao segurar timers com a janela atras
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer.html'));
  win.on('closed', () => { win = null; });
  LOG('interface pronta');
  LOG('raiz do projeto: ' + ROOT);
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (transport) { try { transport.close(); } catch {} }
  app.quit();
});
