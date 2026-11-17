'use strict';

/**
 * Decodifica o log do pka_tap.dll num timeline legivel do protocolo.
 *
 *   node tools/tap_decode.cjs                       # %TEMP%\pka_tap.jsonl
 *   node tools/tap_decode.cjs --in captures\tap-1.jsonl
 *   node tools/tap_decode.cjs --in x.jsonl --raw    # inclui hex dos payloads
 *   node tools/tap_decode.cjs --in x.jsonl --json   # timeline em JSON
 *
 * readonly: so le o arquivo do tap. Nao fala com o jogo.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KIND = {
  1: 'challenge', 2: 'authenticate', 3: 'welcome', 4: 'state',
  5: 'telemetry', 6: 'kind6', 7: 'kind7', 8: 'automation_revoked',
  9: 'manual', 10: 'ack', 11: 'kind11', 12: 'kind12',
};

const COMMANDS = {
  1: 'walk', 2: 'attack', 3: 'follow', 4: 'stop', 5: 'focus', 6: 'talk',
  7: 'combo', 8: 'switchPokemon', 9: 'action', 10: 'kind10cmd', 11: 'fight',
  12: 'potion', 13: 'revive', 14: 'useWith', 15: 'recallPokemon',
  16: 'order', 17: 'turn', 18: 'refreshCombo', 19: 'chase', 20: 'hotkey',
  21: 'orderGround', 25: 'guildDaily',
};

const STATUS = {
  0: 'enviado', 1: 'invalido', 2: 'cliente offline',
  3: 'funcoes do jogo indisponiveis', 4: 'identidade do pokemon mudou',
  5: 'cooldown', 6: 'hotkey sem acao esperada',
};

const DIRECTION = { c2s: 'cliente->servidor', s2c: 'servidor->cliente' };

function parseArgs(argv) {
  const options = { input: null, raw: false, json: false, limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--in') options.input = argv[++i];
    else if (argv[i] === '--raw') options.raw = true;
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--limit') options.limit = Number(argv[++i]);
  }
  if (!options.input) options.input = path.join(os.tmpdir(), 'pka_tap.jsonl');
  return options;
}

function readRecords(file) {
  if (!fs.existsSync(file)) throw Error('log do tap nao encontrado: ' + file +
    '\nrode o jogo com pka_tap.dll injetada primeiro.');
  const text = fs.readFileSync(file, 'utf8');
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* linha truncada na saida */ }
  }
  return records;
}

/**
 * Reconstroi o stream de cada direcao. O tap pode gravar:
 *  - um frame inteiro por WriteFile/ReadFile  -> 1 registro = 1 frame
 *  - varios frames num buffer                 -> split interno
 *  - um frame partido em varias chamadas      -> junta por direcao
 */
/**
 * Corrige o papel do processo que gerou o log.
 *
 * O tap marca 'c2s' quando ve ReadFile e 's2c' quando ve WriteFile. Isso esta
 * certo quando o tap roda no SERVIDOR (a DLL dentro do jogo): ReadFile = recebe
 * do cliente, WriteFile = manda para o cliente.
 *
 * Rodando no CLIENTE (menu Electron), inverte: ReadFile = recebe do servidor
 * (s2c) e WriteFile = manda para o servidor (c2s). Sem corrigir, todo o
 * arquivo do menu sai marcado como c2s - foi o que aconteceu (67.888 c2s,
 * 0 s2c).
 *
 * Como saber o papel: `challenge` (kind 1) e SEMPRE enviado pelo servidor.
 *   - se o tap viu challenge em WriteFile (rotulo 's2c')  -> tap no servidor
 *   - se o tap viu challenge em ReadFile  (rotulo 'c2s')  -> tap no cliente
 * A presenca do kind nao basta (os dois lados veem); o que decide e' o rotulo.
 */
function detectRole(records) {
  for (const record of records) {
    if (record.kind === 1) return record.dir === 's2c' ? 'server' : 'client';
    if (record.kind === 3) return record.dir === 's2c' ? 'server' : 'client';
  }
  /* sem challenge nem welcome (captura truncada): assume cliente, que e' onde
   * o log costuma ser grande e a maioria dos frames e' recebida. */
  let c2s = 0, s2c = 0;
  for (const record of records) {
    if (record.dir === 'c2s') c2s++; else if (record.dir === 's2c') s2c++;
  }
  return c2s >= s2c ? 'client' : 'server';
}

function framesByDirection(records) {
  const pending = { c2s: Buffer.alloc(0), s2c: Buffer.alloc(0) };
  const frames = { c2s: [], s2c: [] };

  /* Papel do processo e' por arquivo, nao por frame. */
  const role = detectRole(records);
  const flip = role === 'client';
  /* No role 'client', o 'dir' gravado e' o oposto do real. */
  const map = dir => (flip ? (dir === 'c2s' ? 's2c' : 'c2s') : dir);

  for (const record of records) {
    const dir = map(record.dir);
    if (!pending[dir]) continue;

    /* Formato novo: o tap ja entrega um FRAME COMPLETO por registro (ele monta
     * o stream por handle+direcao, porque WriteFile pode partir o frame em
     * duas chamadas). Formato antigo: 'd' era um chunk cru. Aceita os dois. */
    if (Number.isInteger(record.kind)) {
      const payload = record.d ? Buffer.from(record.d, 'hex') : Buffer.alloc(0);
      const expected = Number.isInteger(record.n) ? record.n : payload.length;
      const full = record.trunc
        ? payload
        : payload.subarray(0, Math.min(expected, payload.length));
      frames[dir].push({ t: record.t, kind: record.kind, payload: full,
        truncated: Boolean(record.trunc) });
      continue;
    }

    if (!record.d) continue;
    const chunk = Buffer.from(record.d, 'hex');
    pending[dir] = Buffer.concat([pending[dir], chunk]);

    for (;;) {
      const buffer = pending[dir];
      if (buffer.length < 8) break;
      const len = buffer.readUInt32LE(0);
      const kind = buffer.readUInt32LE(4);
      if (len > 2105344) {
        pending[dir] = buffer.subarray(1);
        continue;
      }
      if (buffer.length < 8 + len) break;
      frames[dir].push({
        t: record.t, kind, payload: buffer.subarray(8, 8 + len),
      });
      pending[dir] = buffer.subarray(8 + len);
    }
  }

  frames.role = role;
  frames.flipped = flip;
  return frames;
}

/**
 * State de 48 bytes.
 *
 * Os offsets abaixo foram CONFERIDOS contra 49.753 amostras reais capturadas
 * do servidor do fornecedor (2026-11-04). O campo em +0 nao e' "version": ele
 * anda com o relogio do jogo (GetTickCount), e o +44 nao e' 1 como o
 * reconstruction/protocol.cjs assumia - vale 854 neste build.
 *
 *   +0   tick/counter   sobe a cada publicacao
 *   +4   isOnline       1 quando o personagem esta no mapa
 *   +8   healthPercent  0..100
 *   +12  hp      double
 *   +20  mana    double  (-1 quando desconhecido)
 *   +28  cap     double
 *   +36  targetId
 *   +40  attackSeqNum   incrementa a cada ataque
 *   +44  protoVersion   854
 */
const STATE_LAYOUT = Object.freeze({
  tick: { offset: 0, read: 'u32' },
  online: { offset: 4, read: 'u32' },
  healthPercent: { offset: 8, read: 'u32' },
  hp: { offset: 12, read: 'f64' },
  mana: { offset: 20, read: 'f64' },
  cap: { offset: 28, read: 'f64' },
  targetId: { offset: 36, read: 'u32' },
  attackSeqNum: { offset: 40, read: 'u32' },
  protoVersion: { offset: 44, read: 'u32' },
});

function describeState(payload) {
  if (payload.length !== 48) {
    return { error: 'state com ' + payload.length + ' bytes (esperado 48)' };
  }
  const state = {};
  for (const [name, field] of Object.entries(STATE_LAYOUT)) {
    state[name] = field.read === 'f64'
      ? payload.readDoubleLE(field.offset)
      : payload.readUInt32LE(field.offset);
  }
  if (state.healthPercent > 100) {
    state.warning = 'healthPercent > 100: offsets podem ter mudado neste build';
  }
  return state;
}

function describeManual(payload) {
  if (payload.length < 8) return { error: 'manual com ' + payload.length + ' bytes' };
  const commandId = payload.readUInt32LE(0);
  const type = payload.readUInt32LE(4);
  const param = payload.length >= 12 ? payload.readUInt32LE(8) : null;
  const identity = payload.length >= 16 ? payload.readUInt32LE(12) : null;
  const action = payload.length >= 20 ? payload.readUInt32LE(16) : null;
  const extra = payload.length >= 24 ? payload.readUInt32LE(20) : null;
  const tail = payload.length > 24 ? payload.subarray(24).toString('utf8') : '';
  return {
    commandId, type, command: COMMANDS[type] || 'type' + type,
    param, identity, action, extra, text: tail || undefined,
    size: payload.length,
  };
}

function describeAck(payload) {
  if (payload.length < 12) return { error: 'ack com ' + payload.length + ' bytes' };
  const commandId = payload.readUInt32LE(0);
  const type = payload.readUInt32LE(4);
  const status = payload.readUInt32LE(8);
  return { commandId, type, command: COMMANDS[type] || 'type' + type,
    status, meaning: STATUS[status] || 'desconhecido' };
}

function describeTelemetry(payload) {
  const text = payload.toString('utf8').replace(/^\uFEFF/, '');
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    return { error: 'telemetry nao e JSON valido', size: payload.length,
      head: text.slice(0, 120) };
  }
  const summary = {
    size: payload.length,
    schema: parsed.schema,
    pulseVersion: parsed.pulseVersion,
    nativeVerified: parsed.nativeVerified,
    tick: parsed.tick,
    playerName: parsed.playerName,
    playerId: parsed.playerId,
    position: parsed.position,
    healthPercent: parsed.healthPercent,
    pokemonName: parsed.pokemonName,
    creatures: Array.isArray(parsed.creatures) ? parsed.creatures.length : undefined,
    items: Array.isArray(parsed.items) ? parsed.items.length : undefined,
    movelist: Array.isArray(parsed.moves) ? parsed.moves.length : undefined,
    roster: Array.isArray(parsed.roster) ? parsed.roster.length : undefined,
  };
  const keys = Object.keys(parsed).sort();
  summary.fieldCount = keys.length;
  summary.fields = keys;
  return summary;
}

function describe(frame) {
  const payload = frame.payload;
  const base = { kind: frame.kind, name: KIND[frame.kind] || 'kind' + frame.kind,
    size: payload.length };
  if (frame.kind === 4) base.state = describeState(payload);
  else if (frame.kind === 9) base.manual = describeManual(payload);
  else if (frame.kind === 10) base.ack = describeAck(payload);
  else if (frame.kind === 5) base.telemetry = describeTelemetry(payload);
  else if (frame.kind === 1) base.nonce = payload.length + ' bytes';
  else if (frame.kind === 3) {
    base.pid = payload.length >= 4 ? payload.readUInt32LE(0) : null;
    base.proof = payload.length >= 36 ? payload.subarray(4, 36).toString('hex').slice(0, 16) + '...' : null;
  }
  return base;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const records = readRecords(options.input);
  const frames = framesByDirection(records);

  const timeline = [];
  for (const dir of ['c2s', 's2c']) {
    for (const frame of frames[dir]) timeline.push({ dir, ...describe(frame), t: frame.t });
  }
  timeline.sort((a, b) => a.t - b.t);
  const limited = options.limit ? timeline.slice(0, options.limit) : timeline;

  if (options.json) {
    console.log(JSON.stringify({ input: options.input, records: records.length,
      frames: { c2s: frames.c2s.length, s2c: frames.s2c.length }, timeline: limited }, null, 2));
    return;
  }

  console.log('tap     : ' + options.input);
  console.log('processo: ' + (frames.role === 'client'
    ? 'CLIENTE (menu) - direcoes invertidas de proposito'
    : 'SERVIDOR (jogo) - direcoes como gravadas'));
  console.log('registros: ' + records.length + '  frames c2s=' + frames.c2s.length +
    ' s2c=' + frames.s2c.length);

  const counts = {};
  for (const item of timeline) {
    const key = item.dir + ':' + item.name;
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log('\n-- contagem --');
  for (const key of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) {
    console.log('  ' + key.padEnd(28) + counts[key]);
  }

  console.log('\n-- timeline --');
  for (const item of limited) {
    const tag = (DIRECTION[item.dir] || item.dir).padEnd(18);
    let detail = '';
    if (item.manual) {
      detail = item.manual.command + '(' + item.manual.param + ')';
      if (item.manual.text) detail += ' text="' + item.manual.text.replace(/[\r\n]/g, '\\n') + '"';
      detail += ' cmdId=' + item.manual.commandId + ' len=' + item.manual.size;
    } else if (item.ack) {
      detail = item.ack.command + ' status=' + item.ack.status + ' (' + item.ack.meaning + ')';
    } else if (item.state) {
      detail = item.state.error || ('online=' + item.state.online + ' hp=' + item.state.hp +
        ' hp%=' + item.state.healthPercent + ' target=' + item.state.targetId);
    } else if (item.telemetry) {
      const tel = item.telemetry;
      detail = tel.error || ('tick=' + tel.tick + ' player="' + tel.playerName + '" pos=' +
        JSON.stringify(tel.position) + ' creatures=' + tel.creatures + ' items=' + tel.items +
        ' campos=' + tel.fieldCount);
    } else if (item.name === 'welcome') {
      detail = 'pid=' + item.pid;
    } else if (item.name === 'challenge') {
      detail = 'nonce ' + item.nonce;
    } else {
      detail = item.size + ' bytes';
    }
    console.log('  ' + String(item.t).padStart(8) + '  ' + tag + item.name.padEnd(20) + detail);
    if (options.raw) {
      const source = [...frames.c2s, ...frames.s2c].find(f => f.t === item.t &&
        f.kind === item.kind);
      if (source) console.log('            ' + source.payload.subarray(0, 96).toString('hex'));
    }
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { framesByDirection, describe, describeState, describeManual,
  describeAck, describeTelemetry, KIND, COMMANDS, STATUS };
