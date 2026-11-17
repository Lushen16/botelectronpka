'use strict';

/**
 * MemoryScanner: Leitor direto de memória do PokeAlliance_dx.exe.
 * Lê a tabela de criaturas viva (estruturas C++) sem depender do pipe quando o canal está ocupado ou indisponível.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');

class MemoryScanner {
  constructor(pid) {
    this.pid = pid;
    this.script = path.resolve(__dirname, '../../tools/scan_creatures.py');
  }

  async scan() {
    return new Promise((resolve, reject) => {
      execFile('python', [this.script, '--pid', String(this.pid)], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || stdout || err.message));
        try {
          const snapshot = JSON.parse(stdout);
          resolve(snapshot);
        } catch (parseErr) {
          reject(new Error(`Falha ao processar dados de memória: ${parseErr.message}`));
        }
      });
    });
  }
}

module.exports = { MemoryScanner };
