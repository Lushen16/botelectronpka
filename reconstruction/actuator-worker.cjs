'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');

const MAX_STDERR = 2048;

function spawnFailure(error) {
  const failure = Error('Nao foi possivel iniciar o atuador persistente: '
    + (error && error.message ? error.message : String(error)));
  failure.startFailed = true;
  failure.retrySafe = false;
  failure.uncertain = false;
  failure.cause = error;
  return failure;
}

function channelFailure(message, detail) {
  const failure = Error(message + (detail ? ': ' + detail : ''));
  failure.retrySafe = false;
  failure.uncertain = true;
  failure.channel = true;
  return failure;
}

function createLineWorker(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const python = options.python || process.env.PKA_PYTHON || 'python';
  const args = Array.isArray(options.args) ? options.args : [];
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 3000;
  const label = options.name || 'actuator';
  const spawnOptions = { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  if (options.env) spawnOptions.env = options.env;

  const pending = new Map();
  let child = null;
  let reader = null;
  let starting = null;
  let startError = null;
  let sequence = 0;
  let lastStderr = '';
  let closed = false;

  function rejectAll(detail) {
    if (!pending.size) return;
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(channelFailure(`Atuador ${label} encerrou o canal persistente sem resposta`, detail));
    }
  }

  function settle(message) {
    const id = message && message.id;
    const entry = typeof id === 'number' ? pending.get(id) : undefined;
    if (!entry) {
      lastStderr = (lastStderr + '\n' + JSON.stringify(message)).slice(-MAX_STDERR);
      return;
    }
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(message);
  }

  function onLine(line) {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      lastStderr = (lastStderr + '\n' + text).slice(-MAX_STDERR);
      return;
    }
    settle(message);
  }

  function attach(proc) {
    child = proc;
    lastStderr = '';
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', chunk => { lastStderr = (lastStderr + chunk).slice(-MAX_STDERR); });
    }
    if (proc.stdin) proc.stdin.on('error', () => {});
    proc.on('error', () => {});
    reader = readline.createInterface({ input: proc.stdout });
    reader.on('line', onLine);
    proc.on('exit', (code, signal) => {
      // A replaced or already closed child must not disturb the live channel.
      if (child !== proc) return;
      child = null;
      starting = null;
      if (reader) { reader.close(); reader = null; }
      const detail = lastStderr.trim()
        || `codigo ${code}${signal ? ' (' + signal + ')' : ''}`;
      lastStderr = '';
      rejectAll(detail);
    });
    if (typeof proc.unref === 'function') proc.unref();
    for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
      if (stream && typeof stream.unref === 'function') stream.unref();
    }
  }

  function start() {
    if (child) return Promise.resolve();
    if (startError) return Promise.reject(startError);
    if (closed) return Promise.reject(channelFailure(`Atuador ${label} foi encerrado`));
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      let settled = false;
      let proc;
      try {
        proc = spawnImpl(python, args, spawnOptions);
      } catch (error) {
        settled = true;
        reject(spawnFailure(error));
        return;
      }
      proc.once('error', error => {
        if (settled) return;
        settled = true;
        reject(spawnFailure(error));
      });
      proc.once('spawn', () => {
        if (settled) return;
        settled = true;
        attach(proc);
        resolve();
      });
      proc.once('exit', () => {
        if (settled) return;
        settled = true;
        reject(spawnFailure(Error(`atuador ${label} encerrou durante a inicializacao`)));
      });
    }).catch(error => {
      starting = null;
      if (error && error.startFailed) startError = error;
      throw error;
    });
    starting.catch(() => {});
    return starting;
  }

  function terminate(reason) {
    const proc = child;
    child = null;
    starting = null;
    if (reader) { reader.close(); reader = null; }
    if (proc) { try { proc.kill(); } catch { /* already gone */ } }
    rejectAll(reason && reason.message ? reason.message : 'canal encerrado');
  }

  async function request(payload, requestTimeout = timeoutMs) {
    await start();
    if (!child || !child.stdin || child.stdin.destroyed) {
      throw channelFailure(`Atuador ${label} sem stdin utilizavel`, lastStderr.trim());
    }
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(channelFailure(`Atuador ${label} excedeu ${requestTimeout}ms no canal persistente`));
        terminate(Error('timeout'));
      }, requestTimeout);
      pending.set(id, { resolve, reject, timer });
      try {
        const message = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
          ? { ...payload, id }
          : { id, value: payload };
        child.stdin.write(JSON.stringify(message) + '\n');
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(channelFailure(`Falha ao escrever no canal do atuador ${label}`, error.message));
        terminate(error);
      }
    });
  }

  function close() {
    if (closed) return;
    closed = true;
    const proc = child;
    child = null;
    starting = null;
    if (reader) { reader.close(); reader = null; }
    if (!proc) return;
    try {
      if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
    } catch { /* ignore */ }
    rejectAll('canal encerrado pelo chamador');
    try { proc.kill(); } catch { /* already gone */ }
  }

  return {
    request,
    // Resolves only after the interpreter answered, so imports and the serve
    // loop are already paid for before the first real command.
    warm: () => request({ op: 'ping' }).then(() => true),
    close,
    get pid() { return child ? child.pid : null; },
    get alive() { return Boolean(child); },
    get spawnFailed() { return Boolean(startError); },
    get lastStderr() { return lastStderr.trim(); },
  };
}

module.exports = { createLineWorker };
