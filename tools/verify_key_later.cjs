'use strict';

// Verifica o modo --key-later: o probe abre e segura a instancia ANTES da
// chave existir; o challenge chega; o arquivo de chave aparece depois; o probe
// autentica na MESMA conexao.
//
// Uso: node tools/verify_key_later.cjs

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { RuntimeServer } = require('../reconstruction/runtime-server.cjs');

const KEY = '45d9b2b308059ad199ac05b56532efc5';
const PID = 64400 + (process.pid % 300);

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-keylater-'));
  const keyFile = path.join(dir, 'channel-key.json');

  const server = new RuntimeServer({ pid: PID, key: KEY, nonce: Buffer.alloc(32, 6) });
  server.on('error', () => {});
  await server.start();
  console.log('fixture runtime-server on pid ' + PID);
  console.log('key file will appear at ' + keyFile);

  const child = spawn('python', ['-u', '-B', path.resolve(__dirname, 'race_probe.py'),
    '--pid', String(PID), '--key-later', '--key-file', keyFile, '--seconds', '25'],
  { windowsHide: true });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); process.stdout.write(chunk); });
  child.stderr.on('data', chunk => process.stderr.write(chunk));

  // Grava a chave 1.5s depois: o probe ja deve ter vencido a corrida e estar
  // segurando o handle sem saber a chave.
  setTimeout(() => {
    fs.writeFileSync(keyFile, JSON.stringify({ pid: PID, key: KEY }, null, 2));
    console.log('\n>>> key file written after the race\n');
  }, 1500);

  const code = await new Promise(resolve => child.on('exit', resolve));
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const authenticated = /RESULT AUTHENTICATED/u.test(output);
  const lateKey = /AUTHENTICATE sent \(late key\)|KEY loaded/u.test(output);
  console.log('\n--- veredito ---');
  console.log('exit code        :', code);
  console.log('chave carregada depois:', lateKey);
  console.log('autenticou       :', authenticated);

  if (!lateKey || !authenticated || code !== 0) {
    console.error('FALHOU: o modo --key-later nao autentica ao receber a chave tarde.');
    process.exit(1);
  }
  console.log('OK: --key-later vence a corrida antes da chave e autentica depois.');
}

main().catch(error => {
  console.error('FATAL', error.message);
  process.exit(1);
});
