'use strict';

// Prova o comportamento do race_probe contra um pipe REAL com maxInstances=1
// (tools/pipe_holder.py), que e como o runtime do PKA se comporta.
//
// Cenario:
//   1. holder ocupa o pipe (maxInstances=1).
//   2. race_probe roda com --pid fixo e bate em BUSY — e NAO deve desistir.
//   3. holder sai.
//   4. RuntimeServer reconstruido assume o mesmo nome.
//   5. race_probe deve vencer e autenticar.
//
// Uso: node tools/verify_race_after_release.cjs

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { RuntimeServer } = require('../reconstruction/runtime-server.cjs');

const KEY = '9b2ff0b49a2d2d3004dba9f8e7b4c69f';
const PID = 64900 + (process.pid % 200);
const PIPE = '\\\\.\\pipe\\pka-runtime-2-' + PID;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-race-'));
  const keyFile = path.join(dir, 'channel-key.json');
  fs.writeFileSync(keyFile, JSON.stringify({ pid: PID, key: KEY }));

  // 1. Holder real, maxInstances=1.
  const holder = spawn('python', ['-u', '-B', path.resolve(__dirname, 'pipe_holder.py'),
    '--pid', String(PID), '--seconds', '30', '--instances', '1'], { windowsHide: true });
  let holderOut = '';
  holder.stdout.on('data', chunk => { holderOut += chunk.toString(); process.stdout.write('[holder] ' + chunk); });
  holder.stderr.on('data', chunk => process.stderr.write('[holder] ' + chunk));
  for (let i = 0; i < 80 && !/HOLDER ready/u.test(holderOut); i += 1) await wait(100);
  if (!/HOLDER ready/u.test(holderOut)) {
    console.error('FALHOU: holder nao subiu.');
    holder.kill();
    process.exit(1);
  }

  // 1b. Ocupa a UNICA instancia com um cliente bobo, senao o probe entra de
  //     primeira e o cenario de BUSY nunca acontece.
  const dummy = net.connect(PIPE);
  dummy.on('error', () => {});
  await new Promise((resolve, reject) => {
    dummy.once('connect', resolve);
    dummy.once('error', reject);
  });
  console.log('dummy ocupou a instancia unica');
  // Confirma que agora esta cheio: uma segunda conexao deve falhar/BUSY.
  await wait(300);

  // 2. Probe concorrente, pid fixo.
  const probe = spawn('python', ['-u', '-B', path.resolve(__dirname, 'race_probe.py'),
    '--pid', String(PID), '--key-later', '--key-file', keyFile, '--seconds', '25'],
  { windowsHide: true });
  let output = '';
  probe.stdout.on('data', chunk => { output += chunk.toString(); process.stdout.write(chunk); });
  probe.stderr.on('data', chunk => process.stderr.write(chunk));

  for (let i = 0; i < 60 && !/busy error=231/u.test(output); i += 1) await wait(100);
  const sawBusy = /busy error=231/u.test(output);
  const gaveUpWhileBusy = /marked orphaned/u.test(output);

  // 3. Holder e dummy saem.
  dummy.destroy();
  holder.kill();
  await new Promise(resolve => holder.on('exit', resolve));
  console.log('\n>>> holder saiu\n');

  // 4. Servidor de verdade assume o nome.
  const server = new RuntimeServer({ pid: PID, key: KEY, nonce: Buffer.alloc(32, 8) });
  server.on('error', () => {});
  let started = false;
  for (let i = 0; i < 60 && !started; i += 1) {
    try {
      await server.start();
      started = true;
    } catch {
      await wait(100);
    }
  }
  if (!started) {
    console.error('FALHOU: o servidor nao conseguiu assumir o pipe.');
    probe.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  const code = await new Promise(resolve => probe.on('exit', resolve));
  await server.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const authenticated = /RESULT AUTHENTICATED/u.test(output);
  console.log('\n--- veredito ---');
  console.log('viu BUSY                  :', sawBusy);
  console.log('desistiu com o holder vivo:', gaveUpWhileBusy);
  console.log('exit code                 :', code);
  console.log('autenticou apos liberacao :', authenticated);

  if (!sawBusy) {
    console.error('INCONCLUSIVO: o probe nao chegou a ver BUSY.');
    process.exit(1);
  }
  if (gaveUpWhileBusy) {
    console.error('FALHOU: desistiu enquanto o holder ainda segurava o pipe.');
    process.exit(1);
  }
  if (!authenticated || code !== 0) {
    console.error('FALHOU: nao venceu a corrida nem autenticou apos a liberacao.');
    process.exit(1);
  }
  console.log('OK: espera o dono sair, ganha a instancia e autentica.');
}

main().catch(error => {
  console.error('FATAL', error.message);
  process.exit(1);
});
