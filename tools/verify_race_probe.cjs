'use strict';

// Prova que tools/race_probe.py esta correto: sobe um RuntimeServer real,
// disputa a instancia e completa o handshake. Se o probe falhar aqui, o
// problema e a ferramenta; se passar aqui e falhar no jogo, o problema e o runtime.
//
// Uso: node tools/verify_race_probe.cjs

const path = require('node:path');
const { spawn } = require('node:child_process');
const { RuntimeServer } = require('../reconstruction/runtime-server.cjs');

const KEY = '45d9b2b308059ad199ac05b56532efc5';
const PID = 64100 + (process.pid % 300);

async function main() {
  const server = new RuntimeServer({ pid: PID, key: KEY, nonce: Buffer.alloc(32, 5) });
  server.on('error', () => {});
  await server.start();
  console.log('fixture runtime-server on pid ' + PID);

  const script = path.resolve(__dirname, 'race_probe.py');
  const child = spawn('python', ['-u', '-B', script, '--pid', String(PID),
    '--key', KEY, '--seconds', '20'], { windowsHide: true });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); process.stdout.write(chunk); });
  child.stderr.on('data', chunk => process.stderr.write(chunk));

  const code = await new Promise(resolve => child.on('exit', resolve));
  await server.close();

  const authenticated = /RESULT AUTHENTICATED/u.test(output);
  const challenge = /CHALLENGE bytes=\d+/u.test(output);
  console.log('\n--- veredito ---');
  console.log('exit code      :', code);
  console.log('recebeu challenge:', challenge);
  console.log('autenticou     :', authenticated);

  if (!challenge || !authenticated || code !== 0) {
    console.error('FALHOU: o race_probe nao fecha o handshake nem contra o fixture.');
    process.exit(1);
  }
  console.log('OK: o race_probe completa o handshake quando o servidor atende.');
}

main().catch(error => {
  console.error('FATAL', error.message);
  process.exit(1);
});
