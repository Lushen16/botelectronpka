'use strict';

/**
 * Prova o tap num alvo controlado, sem jogo.
 *
 *   node tools/tap_test.cjs
 *
 * Roteiro:
 *   1. sobe pka_host.exe (DLL servidor, PID falso) num processo filho
 *   2. injeta pka_tap.dll no MESMO processo -> ele ve o lado servidor
 *   3. conecta o cliente real do botfinal -> handshake + comandos
 *   4. decodifica o log e exige ver challenge/authenticate/welcome/state/
 *      telemetry/manual/ack nos dois sentidos
 *
 * O que prova: o tap enxerga o protocolo inteiro sem falar com ele.
 * O que NAO prova: nada sobre o jogo real.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { connect } = require('./tap_client.cjs');
const decoder = require('./tap_decode.cjs');

const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native');
const HOST = path.join(NATIVE, 'pka_host.exe');
const SERVER_DLL = path.join(NATIVE, 'pka_native.dll');
const TAP_DLL = path.join(NATIVE, 'pka_tap.dll');
const INJECTOR = path.join(NATIVE, 'pka_inject.exe');
const KEY = 'tap-proof-key-0123456789abcdef';
const PID = 49123;
const TAP_OUT = path.join(os.tmpdir(), 'pka_tap_test.jsonl');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail === undefined ? '' : ' :: ' + detail));
}

function waitPipe(name, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync('\\\\.\\pipe\\' + name)) return true;
    execFileSync('powershell', ['-NoProfile', '-Command',
      'if (Test-Path "\\\\.\\pipe\\' + name + '") { exit 0 } else { exit 1 }'],
      { stdio: 'ignore' });
    return true;
  }
  return false;
}

async function main() {
  for (const file of [HOST, SERVER_DLL, TAP_DLL, INJECTOR]) {
    if (!fs.existsSync(file)) throw Error('faltando ' + file + ' — rode node tools/build_native.cjs');
  }
  if (fs.existsSync(TAP_OUT)) fs.unlinkSync(TAP_OUT);

  const env = { ...process.env, PKA_HOST_MODE: '1', PKA_CHANNEL_PID: String(PID),
    PKA_CHANNEL_KEY: KEY, PKA_TAP_OUT: TAP_OUT, PKA_TAP_ALL: '1' };

  const host = spawn(HOST, [SERVER_DLL], { env, stdio: 'ignore' });
  await new Promise(resolve => setTimeout(resolve, 900));
  record('host iniciado', Boolean(host.pid), 'pid=' + host.pid + ' canal=' + PID);

  try {
    execFileSync(INJECTOR, ['--pid', String(host.pid), '--dll', TAP_DLL],
      { env, encoding: 'utf8', timeout: 20000 });
    record('tap injetado no processo servidor', true);
  } catch (error) {
    record('tap injetado no processo servidor', false, error.message);
    host.kill();
    return finish();
  }

  await new Promise(resolve => setTimeout(resolve, 1200));

  const transport = connect({ pid: PID, key: KEY });
  transport.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      transport.on('authenticated', resolve);
      transport.on('error', reject);
    });
    record('cliente autenticou contra o servidor', true);
  } catch (error) {
    record('cliente autenticou contra o servidor', false, error.message);
    host.kill();
    return finish();
  }

  await new Promise(resolve => setTimeout(resolve, 700));

  for (const [command, parameter] of [['walk', 3], ['hotkey', 'F2']]) {
    try {
      const ack = await transport.send(command, parameter);
      record('comando ' + command + ' recebeu ACK', true, 'status=' + ack.status);
    } catch (error) {
      record('comando ' + command + ' recebeu ACK', false, error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  await new Promise(resolve => setTimeout(resolve, 1500));
  transport.close();
  host.kill();
  await new Promise(resolve => setTimeout(resolve, 400));

  /* --------------------------------------------------------- decodifica */
  if (!fs.existsSync(TAP_OUT)) {
    record('log do tap gravado', false, 'arquivo ausente');
    return finish();
  }
  const size = fs.statSync(TAP_OUT).size;
  record('log do tap gravado', size > 0, size + ' bytes');

  const records = fs.readFileSync(TAP_OUT, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  record('registros do tap', records.length > 0, records.length + ' registros');

  const frames = decoder.framesByDirection(records);
  const seen = new Set();
  for (const dir of ['c2s', 's2c']) {
    for (const frame of frames[dir]) {
      const described = decoder.describe(frame);
      seen.add(dir + ':' + described.name);
    }
  }

  const required = [
    's2c:challenge', 'c2s:authenticate', 's2c:welcome',
    's2c:state', 's2c:telemetry',
    'c2s:manual', 's2c:ack',
  ];
  for (const key of required) {
    record('frame ' + key, seen.has(key));
  }

  const manualFrames = frames.c2s.filter(f => f.kind === 9).map(f => decoder.describeManual(f.payload));
  record('manual decodificado com comando e texto',
    manualFrames.length >= 2 && manualFrames.some(m => m.text === 'F2'),
    manualFrames.map(m => m.command + (m.text ? '="' + m.text + '"' : '')).join(', '));

  const acks = frames.s2c.filter(f => f.kind === 10).map(f => decoder.describeAck(f.payload));
  record('acks decodificados', acks.length >= 2,
    acks.map(a => a.command + '=' + a.status).join(', '));

  const telemetry = frames.s2c.filter(f => f.kind === 5).map(f => decoder.describeTelemetry(f.payload));
  record('telemetry e JSON valido', telemetry.length > 0 && !telemetry[0].error,
    telemetry[0] && !telemetry[0].error
      ? 'schema=' + telemetry[0].schema + ' campos=' + telemetry[0].fieldCount
      : telemetry[0]?.error);

  finish();
}

function finish() {
  const failed = results.filter(r => !r.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  if (failed.length) {
    console.log('log do tap: ' + TAP_OUT);
    const boot = path.join(os.tmpdir(), 'pka_tap_boot.log');
    if (fs.existsSync(boot)) {
      console.log('--- pka_tap_boot.log ---');
      console.log(fs.readFileSync(boot, 'utf8').split(/\r?\n/).slice(-6).join('\n'));
    }
    process.exitCode = 1;
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
