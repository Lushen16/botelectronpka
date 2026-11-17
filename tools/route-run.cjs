#!/usr/bin/env node
'use strict';

/**
 * Roda uma ROTA REAL do Shiba com a nossa DLL.
 *
 *   node tools/route-run.cjs --pid 16048 --route-analysis wk_digglet
 *   node tools/route-run.cjs --pid 16048 --route analysis/rotas/minha.lua --minutes 5
 *   node tools/route-run.cjs --pid 16048 --nearest          (so' lista a rota mais perto)
 *
 * POR QUE ESTE TOOL EXISTE
 * ------------------------
 * `route-cycle.cjs` e' um STUB de navegacao: anda em ciclo fixo `0,1,2,3`.
 * Ele provou walk, attack e combo (adendo 7/9), mas nao e' uma rota — bate em
 * parede e nao progride. Medido: 44 de 87 walks com status 0 e zero tile
 * (obstaculo), e 38 tentativas de oeste no mesmo beco.
 *
 * Este tool consome o MESMO formato que o Shiba usa
 * (`analysis/shiba-live-config/wk_*.lua`):
 *
 *     return { waypoints = {
 *       {pos={x=1191,y=1415,z=7}, action="walk", param=""},
 *       ...
 *     }}
 *
 * Nao inventa waypoint: se a rota nao existir, recusa.
 *
 * O QUE ELE PROVA
 *   - walk nativo dirigido a um alvo real (nao ciclo cego)
 *   - chegada por waypoint (distancia Chebyshev <= --arrive)
 *   - retomada apos combate (mata e volta para o proximo waypoint)
 *
 * O QUE ELE NAO PROMETE
 *   - pathfinding. A rota tem que ser andavel: o Shiba a desenhou andando.
 *     Se um passo bloquear, ele tenta a direcao alternativa do eixo e conta
 *     `blocked`.
 *   - efeito de ataque. Isso e' do handler; aqui so' registramos o que a
 *     telemetria mostra (mesmo criterio do route-cycle: `dz===0`).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));

function arg(flag, def = null) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return def;
  const value = process.argv[index + 1];
  return (value === undefined || value.startsWith('--')) ? true : value;
}

const CONFIG_DIR = path.join(ROOT, 'analysis', 'shiba-live-config');

/* Direcoes do cliente: 0=N(y-1) 1=E(x+1) 2=S(y+1) 3=W(x-1). */
const DELTA = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0] };

/** Le um arquivo .lua de rota e devolve os waypoints. Nao interpreta Lua:
 *  o formato e' `{pos={x=..,y=..,z=..}, action="..", param=".."}` e e' estavel
 *  em todas as 35 rotas do Shiba. Recusa se nao casar nada. */
function parseRoute(file) {
  if (!fs.existsSync(file)) throw Error('rota nao existe: ' + file);
  const text = fs.readFileSync(file, 'utf8');
  const points = [];
  const pattern = /\{pos=\{x=(\d+)\s*,\s*y=(\d+)\s*,\s*z=(\d+)\}\s*,\s*action="([^"]*)"\s*,\s*param="([^"]*)"\}/gu;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    points.push({
      pos: { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) },
      action: match[4],
      param: match[5],
    });
  }
  if (points.length === 0) {
    throw Error('nenhum waypoint reconhecido em ' + file
      + ' (formato esperado: {pos={x=,y=,z=}, action="", param=""})');
  }
  return points;
}

/** Lista as rotas do Shiba ordenadas pela distancia ate' a posicao dada. */
function nearestRoutes(pos, limit = 5) {
  const files = fs.existsSync(CONFIG_DIR)
    ? fs.readdirSync(CONFIG_DIR).filter(name => name.startsWith('wk_') && name.endsWith('.lua'))
    : [];
  const rows = [];
  for (const name of files) {
    let points;
    try { points = parseRoute(path.join(CONFIG_DIR, name)); } catch { continue; }
    let min = Infinity;
    for (const point of points) {
      const dist = Math.max(Math.abs(point.pos.x - pos.x), Math.abs(point.pos.y - pos.y));
      if (dist < min) min = dist;
    }
    rows.push({ name, waypoints: points.length, distance: min,
      zones: [...new Set(points.map(point => point.pos.z))] });
  }
  return rows.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const pid = Number(arg('--pid', 0));
  if (!pid) { console.error('faltou --pid'); process.exit(2); }

  const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
  const fallbackKey = path.join(ROOT, 'native', 'pka_channel_key.txt');
  const key = fs.existsSync(keyFile)
    ? JSON.parse(fs.readFileSync(keyFile, 'utf8')).key
    : (fs.existsSync(fallbackKey) ? fs.readFileSync(fallbackKey, 'utf8').trim() : null);
  if (!key) { console.error('sem chave em ' + keyFile); process.exit(2); }

  /* Valida argumentos ANTES de conectar: argumento errado nao deve depender
   * de o jogo estar vivo, e falhar depois de abrir o canal confunde o
   * diagnostico ("erro de pipe" quando o problema era a linha de comando). */
  const discovery = Boolean(arg('--nearest', false));
  const routeName = arg('--route-analysis', null);
  const routeArg = arg('--route', null);
  const routeFile = routeArg
    || (routeName ? path.join(CONFIG_DIR, routeName.endsWith('.lua') ? routeName : routeName + '.lua') : null);
  if (!discovery && !routeFile) {
    console.error('informe --route <arquivo.lua>, --route-analysis <nome> ou --nearest');
    process.exit(2);
  }
  /* Le a rota antes de conectar: rota inexistente/invalida e' erro de
   * argumento, nao de canal. */
  const waypoints = discovery ? null : parseRoute(String(routeFile));

  const transport = new NativeTransport({ pid, key });
  let snap = null;
  let ready = null;
  transport.on('telemetry', value => { snap = value; ready = value.runtimeReady; });
  transport.on('error', () => {});

  await transport.connect();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !snap) await sleep(100);
  if (!snap) { console.error('sem telemetria'); transport.close(); process.exit(1); }

  if (ready === false) {
    console.error('BLOQUEADO: runtimeReady=false (personagem no menu).');
    console.error('Entre no mundo e rode de novo. Nada foi enviado.');
    transport.close();
    process.exit(3);
  }

  /* Modo descoberta: so' lista rotas proximas. */
  if (discovery) {
    console.log(`posicao: (${snap.position.x},${snap.position.y},${snap.position.z})`);
    console.log('rotas mais proximas (analysis/shiba-live-config):\n');
    for (const row of nearestRoutes(snap.position)) {
      console.log(`  ${row.name.padEnd(30)} wps=${String(row.waypoints).padStart(3)}`
        + `  distMin=${String(row.distance).padStart(4)}  z=${row.zones.join(',')}`);
    }
    console.log('\nnenhuma cobre a area atual se distMin for grande; desenhe uma rota'
      + ' andando ou mova o personagem para a area da rota.');
    transport.close();
    process.exit(0);
  }

  const arriveRadius = Number(arg('--arrive', 1));
  const maxMinutes = Number(arg('--minutes', 5));
  const maxStepsPerWaypoint = Number(arg('--max-steps', 40));
  const outBase = String(arg('--out', path.join(ROOT, 'captures', 'routes',
    `run-${pid}-${path.basename(String(routeFile), '.lua')}`)));

  console.log(`rota      : ${path.basename(String(routeFile))} (${waypoints.length} waypoints)`);
  console.log(`posicao   : (${snap.position.x},${snap.position.y},${snap.position.z})`);
  console.log(`chegada   : <= ${arriveRadius} tile(s)`);
  console.log('');

  const started = Date.now();
  const deadlineAt = started + maxMinutes * 60000;
  const progress = [];
  let blocked = 0;
  let moves = 0;

  const distance = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  for (let index = 0; index < waypoints.length && Date.now() < deadlineAt; index++) {
    const waypoint = waypoints[index];
    const record = { index, target: waypoint.pos, action: waypoint.action, steps: 0, blocked: 0, reached: false };
    let steps = 0;

    while (steps < maxStepsPerWaypoint && Date.now() < deadlineAt) {
      const me = snap.position;
      if (!me) break;
      if (waypoint.pos.z !== me.z) {
        /* Trocar de andar exige stairs/teleport, que nao implementamos.
         * Reportar e pular e' honesto — inventar direcao seria pior. */
        record.skipped = 'z diferente (precisa stairs/teleport)';
        break;
      }
      if (distance(me, waypoint.pos) <= arriveRadius) { record.reached = true; break; }

      const dx = waypoint.pos.x - me.x;
      const dy = waypoint.pos.y - me.y;
      /* Eixo dominante primeiro, mas alterna se bloqueou: uma rota do Shiba
       * assume piso andavel, e obstaculo pontual pede o outro eixo. */
      let dir;
      if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? 1 : 3;
      else dir = dy > 0 ? 2 : 0;
      if (record.blocked > 0 && record.blocked % 2 === 1) {
        dir = Math.abs(dx) >= Math.abs(dy) ? (dy > 0 ? 2 : 0) : (dx > 0 ? 1 : 3);
      }

      const before = { ...me };
      let ack = null;
      try { ack = await transport.sendCommand('walk', dir); }
      catch (error) { record.error = error.message; break; }
      await sleep(700);

      const after = snap.position ? { ...snap.position } : null;
      const moved = Boolean(after) && (after.x !== before.x || after.y !== before.y);
      if (!moved) {
        record.blocked += 1;
        blocked += 1;
        if (record.blocked >= 6) break;   // beco: desiste deste waypoint
      } else {
        moves += 1;
      }
      steps += 1;
      record.steps = steps;
      record.lastStatus = ack ? ack.status : null;
    }

    progress.push(record);
    const mark = record.reached ? 'OK ' : (record.skipped ? 'SKIP' : 'FAIL');
    console.log(`  ${String(index + 1).padStart(3)}/${waypoints.length} ${mark}`
      + ` (${waypoint.pos.x},${waypoint.pos.y},${waypoint.pos.z})`
      + ` passos=${record.steps} bloqueios=${record.blocked}`
      + (record.skipped ? ` — ${record.skipped}` : ''));
  }

  const reached = progress.filter(row => row.reached).length;
  const summary = {
    pid, route: path.basename(String(routeFile)), waypoints: waypoints.length,
    reached, skipped: progress.filter(row => row.skipped).length,
    blockedSteps: blocked, movedSteps: moves,
    elapsedMs: Date.now() - started,
    progress,
  };
  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(outBase + '.json', JSON.stringify(summary, null, 1));

  console.log('');
  console.log(`=== ROTA ===`);
  console.log(`waypoints alcancados : ${reached}/${waypoints.length}`);
  console.log(`passos que moveram   : ${moves}`);
  console.log(`passos bloqueados    : ${blocked}`);
  console.log(`tempo                : ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`Escrito: ${outBase}.json`);

  transport.close();
  process.exit(reached === waypoints.length ? 0 : 1);
}

main().catch(error => { console.error('erro: ' + error.message); process.exit(1); });
