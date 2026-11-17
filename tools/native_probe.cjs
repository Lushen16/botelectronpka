'use strict';

/**
 * Conecta num pipe arbitrario e imprime state/telemetry (modo externo / tap).
 *
 *   node tools/native_probe.cjs --pid 21436 --suffix -ext [--key ARQUIVO]
 */

const fs = require('node:fs');
const path = require('node:path');
const { createTransport } = require('../botfinal/core/pipe-transport.cjs');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const pid = Number(arg('pid', 0));
const suffix = arg('suffix', '');
const keyFile = arg('key', null);
if (!Number.isInteger(pid) || pid <= 0) {
  console.error('uso: node tools/native_probe.cjs --pid <pid> [--suffix -ext] [--key arquivo]');
  process.exit(2);
}

let key = process.env.PKA_CHANNEL_KEY || null;
if (!key && keyFile) key = fs.readFileSync(path.resolve(keyFile), 'utf8').trim();
if (!key) {
  console.error('sem chave: --key arquivo ou PKA_CHANNEL_KEY');
  process.exit(2);
}

const pipePath = '\\\\.\\pipe\\pka-runtime-2-' + pid + suffix;

(async () => {
  const transport = createTransport('native', { pid, key, path: pipePath, startupTimeoutMs: 6000 });
  let state = null;
  let telemetry = null;
  transport.on('state', v => { state = v; });
  transport.on('telemetry', v => { telemetry = v; });
  console.log('[pipe] ' + pipePath);
  await transport.connect();
  console.log('[auth] ' + transport.authenticated);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !(state && telemetry)) await new Promise(r => setTimeout(r, 50));
  console.log('[state] ' + JSON.stringify(state));
  if (telemetry) {
    console.log('[tele] player=' + JSON.stringify(telemetry.playerName)
      + ' pos=' + JSON.stringify(telemetry.position)
      + ' hp=' + telemetry.healthPercent
      + ' creatures=' + (telemetry.creatures?.length ?? 0));
  } else {
    console.log('[tele] ausente');
  }
  await transport.close();
})().catch(error => { console.error('ERRO ' + error.message); process.exit(1); });
