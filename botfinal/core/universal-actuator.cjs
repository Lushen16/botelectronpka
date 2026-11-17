'use strict';

/**
 * UniversalActuator: Atuador Win32 de alto desempenho para combate e movimentação.
 * Opera diretamente via PostMessageW direcionado ao HWND do PokeAlliance_dx.
 * Elimina as falhas do bot antigo:
 * 1. Mira direta via clique de mouse direito (0x0204/0x0205) ou Hotkey configurada.
 * 2. Sem concorrência entre Walker e Combate (gerenciado pelo StateArbiter).
 * 3. Envio síncrono ultra-rápido via processo Python residente.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

class UniversalActuator {
  constructor(options = {}) {
    this.pid = options.pid;
    this.pythonProcess = null;
    this.rl = null;
    this.pendingResolvers = [];
    this.scriptPath = path.resolve(__dirname, '../../tools/combat_actuator.py');
    this.ready = false;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.pythonProcess = spawn('python', [this.scriptPath, '--serve'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.rl = readline.createInterface({
        input: this.pythonProcess.stdout,
        crlfDelay: Infinity,
      });

      this.rl.on('line', line => {
        try {
          const json = JSON.parse(line);
          const resolver = this.pendingResolvers.shift();
          if (resolver) resolver.resolve(json);
        } catch (err) {
          const resolver = this.pendingResolvers.shift();
          if (resolver) resolver.reject(err);
        }
      });

      this.pythonProcess.stderr.on('data', data => {
        // Log interno de debug se necessário
      });

      this.pythonProcess.on('error', err => {
        reject(err);
      });

      this.pythonProcess.on('exit', () => {
        this.ready = false;
      });

      // Probe inicial para aquecer o HWND do cliente
      setTimeout(async () => {
        try {
          const probe = await this.dispatch({ kind: 'probe' });
          if (probe.hwnd) {
            this.ready = true;
            resolve(probe);
          } else {
            resolve(probe);
          }
        } catch (e) {
          resolve(null);
        }
      }, 100);
    });
  }

  async dispatch(request) {
    if (!this.pythonProcess || this.pythonProcess.killed) {
      await this.start();
    }

    return new Promise((resolve, reject) => {
      this.pendingResolvers.push({ resolve, reject });
      const payload = JSON.stringify({ pid: this.pid, request }) + '\n';
      this.pythonProcess.stdin.write(payload);
    });
  }

  async attackTarget(x, y, width = 1920, height = 1009) {
    return this.dispatch({
      kind: 'attack',
      x: Math.round(x),
      y: Math.round(y),
      width,
      height,
    });
  }

  async sendKey(key) {
    return this.dispatch({
      kind: 'key',
      key: String(key).toLowerCase(),
    });
  }

  close() {
    if (this.rl) this.rl.close();
    if (this.pythonProcess) this.pythonProcess.kill();
  }
}

module.exports = { UniversalActuator };
