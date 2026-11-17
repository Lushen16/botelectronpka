'use strict';

/**
 * Servidor de desenho de rota + teste de combate.
 *
 *   node tools/rota/servidor.cjs --pid 16260 [--port 7788]
 *
 * abre http://127.0.0.1:7788 e serve a UI.
 *
 * ARQUITETURA (por que assim)
 *
 * Sem `ws`, sem `express`. O repo nao tem esses pacotes e adicionar dependencia
 * para uma ferramenta de teste e' custo sem retorno. Node puro resolve:
 *
 *   - HTTP GET  /            -> HTML da UI
 *   - HTTP GET  /eventos     -> SSE (server-sent events): telemetria 1x/s
 *   - HTTP POST /comando     -> despacha walk/attack/combo/potion
 *   - HTTP POST /rota        -> salva waypoints desenhados
 *   - HTTP GET  /estado      -> snapshot atual (para o primeiro paint)
 *
 * SSE e' melhor que WebSocket aqui: fluxo e' unidirecional (servidor ->
 * navegador) e reconecta sozinho. Nenhum handshake para escrever.
 *
 * O servidor NAO tem logica de decisao. Ele so':
 *   1. conecta no canal nativo (NativeTransport);
 *   2. repassa telemetria para o navegador;
 *   3. executa o comando que o navegador pedir.
 *
 * Quem decide e' o humano olhando o mapa. E' ferramenta de teste, nao bot.
 *
 * SEGURANCA: escuta em 127.0.0.1 apenas. Nao expor na rede — o endpoint
 * /comando move o personagem.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { NativeTransport } = require(path.resolve(__dirname, '..', '..', 'botfinal', 'core', 'pipe-transport.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const pid = Number(arg('--pid', 0));
const port = Number(arg('--port', 7788));
if (!pid) { console.error('faltou --pid <pid do jogo>'); process.exit(2); }

const ROOT = path.resolve(__dirname, '..', '..');
const KEY_FILE = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
if (!fs.existsSync(KEY_FILE)) {
  console.error('sem chave em ' + KEY_FILE);
  console.error('gere com: node tools/rota/gerar_chave.cjs --pid ' + pid);
  process.exit(2);
}
const key = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).key;

/* ─────────── estado em memoria (uma sessao, um cliente) ─────────── */

const state = {
  telemetry: null,
  channel: null,
  clients: new Set(),      // respostas SSE abertas
  routeFile: path.join(ROOT, 'captures', 'routes', `desenho-${pid}.json`),
  route: null,
  commandsSent: 0,
  lastCommand: null,
};

function loadRoute() {
  try {
    state.route = JSON.parse(fs.readFileSync(state.routeFile, 'utf8'));
  } catch {
    state.route = { pid, waypoints: [], updatedAt: null };
  }
}

function saveRoute(waypoints) {
  state.route = { pid, waypoints, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(state.routeFile), { recursive: true });
  fs.writeFileSync(state.routeFile, JSON.stringify(state.route, null, 2));
  return state.route;
}

/* ─────────── SSE ─────────── */

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch { /* cliente caiu; o close handler limpa */ }
}

function broadcast(event, data) {
  for (const res of state.clients) sseSend(res, event, data);
}

/* ─────────── canal nativo ─────────── */

/* Conecta com retry.
 *
 * MEDIDO (2026-11-13): o canal nativo aceita UM handshake por vez e a sessao
 * anterior pode demorar a expirar no lado do jogo. Consequencia pratica: se
 * voce acabou de rodar `route-cycle.cjs`, um script solto, ou reabriu a UI,
 * o primeiro connect devolve `Handshake expirou.` — mesmo com tudo certo.
 *
 * Antes eu subia a UI com "sem canal" e o usuario tinha que adivinhar. Agora
 * tentamos de novo com backoff. O erro so' aparece depois de ~4 tentativas
 * (~20 s), tempo suficiente para a sessao velha cair.
 *
 * NAO mascara problema real: se a DLL nao estiver injetada, o erro e'
 * ENOENT (pipe inexistente) e o retry nao resolve — a mensagem final diz
 * exatamente isso. */
async function connectChannel(retries = 4) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    const t = new NativeTransport({ pid, key });
    t.on('telemetry', v => {
      state.telemetry = v;
      broadcast('telemetry', v);
    });
    t.on('state', v => broadcast('state', v));
    t.on('error', e => {
      state.channel = 'erro: ' + e.message;
      broadcast('channel', { status: state.channel });
    });
    t.on('close', () => {
      state.channel = 'fechado';
      broadcast('channel', { status: state.channel });
    });
    try {
      await t.connect();
      state.channel = 'conectado';
      broadcast('channel', { status: state.channel });
      return t;
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      const busy = /Handshake expirou|busy|EAGAIN|EBUSY/iu.test(msg);
      const missing = /ENOENT|no such file|missing/iu.test(msg);
      if (missing) {
        // nao adianta insistir: o pipe nao existe
        throw Error('canal inexistente — a DLL esta injetada? (' + msg + ')');
      }
      if (!busy) throw e;
      const espera = 1500 * (i + 1);
      state.channel = `aguardando canal (tentativa ${i + 1}/${retries})`;
      broadcast('channel', { status: state.channel });
      console.log(`canal ocupado; tentando de novo em ${espera} ms`);
      await new Promise(r => setTimeout(r, espera));
    }
  }
  throw Error('canal continua ocupado depois de ' + retries + ' tentativas: '
    + (lastErr ? lastErr.message : 'motivo desconhecido'));
}

/* ─────────── HTTP ─────────── */

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > 1_000_000) { reject(Error('body grande demais')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Error('JSON invalido: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

const ALLOWED = new Set(['walk', 'attack', 'combo', 'potion', 'hotkey', 'stop', 'switchPokemon']);

async function handleCommand(transport, body) {
  const name = String(body.name || '');
  if (!ALLOWED.has(name)) {
    return { ok: false, error: `comando "${name}" nao permitido. Use: ${[...ALLOWED].join(', ')}` };
  }
  const param = body.parameter;
  const opts = body.options || undefined;
  const ack = await transport.sendCommand(name, param, opts);
  state.commandsSent++;
  state.lastCommand = { name, parameter: param, status: ack?.status ?? null, at: Date.now() };
  return { ok: true, ack };
}

/* ─────────── bootstrap ─────────── */

(async () => {
  loadRoute();
  let transport;
  try {
    transport = await connectChannel();
  } catch (e) {
    console.error('falha ao conectar no canal: ' + e.message);
    console.error('o servidor sobe mesmo assim; a UI mostra "sem canal".');
    state.channel = 'falha: ' + e.message;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'ui.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/eventos') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      state.clients.add(res);
      if (state.telemetry) sseSend(res, 'telemetry', state.telemetry);
      sseSend(res, 'channel', { status: state.channel });
      sseSend(res, 'route', state.route);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      req.on('close', () => { clearInterval(ping); state.clients.delete(res); });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/estado') {
      return json(res, 200, {
        pid, channel: state.channel,
        telemetry: state.telemetry, route: state.route,
        commandsSent: state.commandsSent, lastCommand: state.lastCommand,
      });
    }

    if (req.method === 'POST' && url.pathname === '/comando') {
      if (!transport) return json(res, 503, { ok: false, error: 'sem canal' });
      try {
        const body = await readBody(req);
        const out = await handleCommand(transport, body);
        return json(res, out.ok ? 200 : 400, out);
      } catch (e) {
        return json(res, 500, { ok: false, error: e.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/rota') {
      try {
        const body = await readBody(req);
        const wps = Array.isArray(body.waypoints) ? body.waypoints : [];
        // valida: todo waypoint precisa de pos inteira
        const clean = wps.map((w, i) => {
          const p = w.pos || {};
          if (![p.x, p.y, p.z].every(Number.isInteger)) {
            throw Error(`waypoint ${i} sem pos.x/y/z inteiros`);
          }
          return {
            action: typeof w.action === 'string' ? w.action : 'walk',
            pos: { x: p.x, y: p.y, z: p.z },
            param: w.param == null ? '' : String(w.param),
          };
        });
        const saved = saveRoute(clean);
        broadcast('route', saved);
        return json(res, 200, { ok: true, route: saved });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }

    json(res, 404, { error: 'rota nao encontrada' });
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`rota UI em http://127.0.0.1:${port}`);
    console.log(`pid ${pid} | canal: ${state.channel}`);
  });

  const shutdown = () => {
    try { transport?.close?.(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
