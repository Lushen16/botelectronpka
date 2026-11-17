'use strict';

/**
 * E2E do canal nativo: sobe a pka_native.dll em modo host e exercita o
 * transporte real do botfinal contra ela.
 *
 *   node tools/native_e2e.cjs                  # pid falso 49001, chave fixa
 *   node tools/native_e2e.cjs --pid 25876      # injeta? nao: so prova handshake
 *
 * O que prova:
 *   - challenge/authenticate/welcome nos dois sentidos (HMAC identico)
 *   - state 48 bytes decodifica
 *   - telemetry JSON passa em decodeTelemetry (schema 2, pulseVersion 3)
 *   - comando manual recebe ACK (kind 10) com status
 *
 * O que NAO prova: efeito no jogo. effectVerified continua false.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createTransport } = require('../botfinal/core/pipe-transport.cjs');

const pidArg = process.argv.indexOf('--pid');
const PID = pidArg >= 0 ? Number(process.argv[pidArg + 1]) : 49001;
const KEY = process.env.PKA_CHANNEL_KEY || '0123456789abcdef0123456789abcdef';
const ROOT = path.resolve(__dirname, '..');
const HOST = path.join(ROOT, 'native', 'pka_host.exe');
const DLL = path.join(ROOT, 'native', 'pka_native.dll');
const LOGDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pka-e2e-'));

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' :: ' + detail : ''));
}

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  if (!fs.existsSync(HOST) || !fs.existsSync(DLL)) {
    console.error('compile antes: node tools/build_native.cjs');
    process.exit(2);
  }

  let host = null;
  if (PID === 49001) {
    host = spawn(HOST, [DLL], {
      cwd: ROOT,
      env: { ...process.env, PKA_HOST_MODE: '1', PKA_CHANNEL_PID: String(PID),
        PKA_CHANNEL_KEY: KEY, PKA_LOG_DIR: LOGDIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    host.stdout.on('data', () => {});
    host.stderr.on('data', () => {});
    await wait(1200);
  }

  const transport = createTransport('native', { pid: PID, key: KEY,
    startupTimeoutMs: 5000, commandTimeoutMs: 3000 });
  let state = null;
  let telemetry = null;
  transport.on('state', value => { state = value; });
  transport.on('telemetry', value => { telemetry = value; });

  try {
    await transport.connect();
    check('handshake HMAC nos dois sentidos', transport.authenticated === true);

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !(state && telemetry)) await wait(50);
    check('state decodificado (48 bytes)', Boolean(state), state ? 'hp=' + state.healthPercent : 'ausente');
    check('telemetry decodificada (schema 2)', Boolean(telemetry),
      telemetry ? 'tick=' + telemetry.tick : 'ausente');
    check('telemetry passa nas regras do decoder', telemetry?.pulseVersion === 3
      && telemetry?.schema === 2);

    const ack = await transport.sendCommand('walk', 1);
    check('comando walk recebeu ACK', ack?.commandId > 0, 'status=' + ack?.status);

    const ack2 = await transport.sendCommand('hotkey', 'F5');
    check('comando hotkey recebeu ACK', ack2?.commandId > 0, 'status=' + ack2?.status);

    const ack3 = await transport.sendCommand('attack', 12345);
    check('attack responde status do protocolo', ack3?.status !== undefined,
      'status=' + ack3?.status + ' (3 = funcoes do jogo indisponiveis)');
  } catch (error) {
    check('conexao', false, error.message);
  } finally {
    try { await transport.close(); } catch { /* ignore */ }
    if (host) { try { host.kill(); } catch { /* ignore */ } }
    await wait(300);
    const logFile = path.join(LOGDIR, 'pka_native.log');
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
      console.log('\n--- log da DLL ---');
      for (const line of lines.slice(-8)) console.log('  ' + line);
    }
    fs.rmSync(LOGDIR, { recursive: true, force: true });
  }

  const failed = results.filter(row => !row.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => { console.error('FATAL', error.stack || error.message); process.exit(2); });
