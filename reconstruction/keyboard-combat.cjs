'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createLineWorker } = require('./actuator-worker.cjs');

const ACTUATOR_SCRIPT = path.resolve(__dirname, '../tools/combat_actuator.py');
const KINDS = new Set(['key', 'attack', 'click', 'useWith', 'probe']);
const DAEMON_DISABLED = () => process.env.PKA_COMBAT_DAEMON === '0';

function readBindings(filename) {
  const text = fs.readFileSync(filename, 'utf8');
  const profiles = text.match(/^  hotkeyProfile_\d+:/gm) || [];
  if (profiles.length !== 1) throw Error('Selecao de perfil de hotkeys ambigua no cliente.');
  const bindings = {};
  for (const match of text.matchAll(/^      (ACTION_\d+|ACTION_BAR_AUTOCOMBO):\r?\n([\s\S]*?)(?=^      \S|^    \S|^\S|$(?![\s\S]))/gm)) {
    const keys = [...match[2].matchAll(/^              key: ([^\r\n]+)/gm)].map(value => value[1].trim());
    const key = keys.find(value => /^(?:F(?:[1-9]|1[0-2])|[A-Z0-9])$/iu.test(value));
    if (key) bindings[match[1] === 'ACTION_BAR_AUTOCOMBO' ? '!autocombo' : 'm' + match[1].slice(7)] = key;
  }
  return bindings;
}

function projectTarget(view, player, creature) {
  if (!view || ![view.width, view.height, view.centerX, view.centerY, view.tileSize].every(Number.isFinite)
      || view.width <= 0 || view.height <= 0 || view.tileSize <= 0 || player.z !== creature.pos.z) {
    throw Error('Calibracao do viewport ausente ou invalida.');
  }
  const x = Math.round(view.centerX + (creature.pos.x - player.x) * view.tileSize);
  const y = Math.round(view.centerY + (creature.pos.y - player.y) * view.tileSize);
  if (!view.map || x < view.map.left || x >= view.map.right || y < view.map.top || y >= view.map.bottom) {
    throw Error('Alvo fora do viewport calibrado.');
  }
  return { kind: 'attack', x, y, width: view.width, height: view.height };
}

function expectedEvents(kind) {
  return kind === 'useWith' ? 4 : kind === 'probe' ? 0 : 2;
}

function isValidRequest(pid, request) {
  return Number.isInteger(pid) && pid > 0 && request !== null && typeof request === 'object'
    && !Array.isArray(request) && KINDS.has(request.kind || 'key');
}

function verifyResponse(pid, request, output, failureDetail, transportError) {
  let result;
  if (output !== null && typeof output === 'object' && !(output instanceof Error)) {
    result = output;
  } else {
    try {
      result = JSON.parse(output);
    } catch {
      const detail = String(failureDetail || '').trim().split(/\r?\n/).filter(Boolean).pop();
      const failure = Error('Atuador de combate sem resposta JSON valida.' + (detail ? ' ' + detail : ''));
      failure.retrySafe = false;
      failure.uncertain = true;
      throw failure;
    }
  }
  if (transportError || !result || result.success !== true || result.pid !== pid
      || result.eventsSent !== expectedEvents(request.kind || 'key')
      || result.transport !== 'PostMessageW' || result.effectVerified !== false) {
    const failure = Error(result?.error || 'Atuador de combate rejeitou o envio.');
    failure.result = result;
    failure.retrySafe = false;
    failure.uncertain = true;
    if (result?.success === false && result.pid === pid && result.errorCode === 'COMBAT_TARGET_MOVED'
        && result.eventsSent === 0 && (result.pointerEventsSent || 0) === 0) failure.code = 'COMBAT_TARGET_MOVED';
    throw failure;
  }
  return result;
}

function createCombatInput(options = {}) {
  const python = options.python || process.env.PKA_PYTHON || 'python';
  const script = options.script ? path.resolve(options.script) : ACTUATOR_SCRIPT;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 3000;
  const legacy = options.execFile || execFile;
  const daemon = options.daemon === true
    || (!options.execFile && options.daemon !== false && !DAEMON_DISABLED());
  let worker = null;
  let workerUnavailable = !daemon;

  function legacyInput(pid, request) {
    return new Promise((resolve, reject) => {
      legacy(python, [script, String(pid), '--request', JSON.stringify(request)],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 16384 }, (error, stdout, stderr) => {
          try {
            resolve(verifyResponse(pid, request, stdout, stderr || error?.message, error));
          } catch (failure) {
            reject(failure);
          }
        });
    });
  }

  function ensureWorker() {
    if (!worker) {
      worker = createLineWorker({
        python,
        args: options.args || [script, '--serve'],
        spawn: options.spawn,
        env: options.env,
        timeoutMs,
        name: 'combat',
      });
    }
    return worker;
  }

  function abandonWorker() {
    workerUnavailable = true;
    if (worker) { try { worker.close(); } catch { /* nothing to close */ } }
    worker = null;
  }

  async function prewarm() {
    if (workerUnavailable) return false;
    try {
      await ensureWorker().warm();
      return true;
    } catch (failure) {
      if (failure && failure.startFailed) abandonWorker();
      return false;
    }
  }

  async function input(pid, request) {
    if (!isValidRequest(pid, request)) throw Error('PID ou request de combate invalido.');
    if (workerUnavailable) return legacyInput(pid, request);
    const channel = ensureWorker();
    let response;
    try {
      response = await channel.request({ pid, request });
    } catch (failure) {
      if (failure && failure.startFailed) {
        abandonWorker();
        return legacyInput(pid, request);
      }
      throw failure;
    }
    return verifyResponse(pid, request, response, channel.lastStderr);
  }

  input.prewarm = prewarm;
  input.close = () => {
    if (worker) { worker.close(); worker = null; }
  };
  input.mode = () => (workerUnavailable ? 'process' : 'daemon');
  return input;
}

module.exports = { readBindings, projectTarget, createCombatInput };
