'use strict';
/* Sonda descartavel: abre o canal nativo e imprime o motivo do gate e a
 * telemetria crua por alguns segundos. Nao envia comando nenhum. */
const { open, channelKey } = require('./reconstruction/native-adapter.cjs');
const { Transport } = require('./reconstruction/transport.cjs');
const { gateReason } = require('./reconstruction/automation.cjs');

const pid = Number(process.argv[2]);
(async () => {
  const transport = new Transport({ pid, key: channelKey(pid),
    commandTimeoutMs: 2000, startupTimeoutMs: 25000 });
  const adapter = await open({ pid }, { transport });
  const deadline = Date.now() + 4000;
  let last = '';
  while (Date.now() < deadline) {
    const snapshot = adapter.getSnapshot();
    const reason = snapshot ? gateReason(snapshot) : 'sem snapshot';
    const telemetry = snapshot?.telemetry;
    const line = JSON.stringify({
      reason,
      tick: telemetry?.tick,
      playerId: telemetry?.playerId,
      pos: telemetry?.position,
      runtimeReady: telemetry?.runtimeReady ?? snapshot?.runtimeReady,
      nativeVerified: telemetry?.nativeVerified,
      pulse: telemetry?.pulseVersion,
      playerName: telemetry?.playerName,
    });
    if (line !== last) { console.log(new Date().toISOString(), line); last = line; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await adapter.close();
})().catch(error => { console.error('falha:', error.message); process.exitCode = 1; });
