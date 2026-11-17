'use strict';

/**
 * Envio real de tecla ao cliente, pelo transporte PostMessageW.
 *
 * Envia UMA tecla inofensiva (F1, primeira skill da action bar) e reporta
 * exatamente o que o atuador confirmou. Nao afirma efeito no jogo: aceite do
 * transporte nao e prova de dano, cura ou movimento.
 *
 * Uso:
 *   node tools/live_key_send.cjs --pid 25876 --key F1
 *   node tools/live_key_send.cjs --pid 25876 --key F1 --direction 1
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const get = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const pid = Number(get('pid', 0));
const key = get('key', null);
const direction = get('direction', null);

if (!Number.isInteger(pid) || pid <= 0) {
  console.error('uso: node tools/live_key_send.cjs --pid <pid> --key <tecla>');
  process.exit(2);
}

const actuator = path.resolve(__dirname, 'combat_actuator.py');

function run(payload) {
  const json = JSON.stringify(payload);
  const out = execFileSync('python', ['-B', actuator, '--serve'], {
    input: json + '\n', encoding: 'utf8', timeout: 15000,
  });
  const lines = out.trim().split(/\r?\n/u).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function main() {
  const results = [];
  const check = (label, ok, detail = '') => {
    results.push({ label, ok });
    console.log((ok ? 'OK   ' : 'FAIL ') + label + (detail ? ' :: ' + detail : ''));
  };

  console.log('[*] PID ' + pid + ' | tecla ' + (key || '(nenhuma)')
    + (direction !== null ? ' | direcao ' + direction : ''));

  const probe = run({ pid, request: { kind: 'probe' } });
  check('probe do transporte', probe.success === true, probe.error || 'ok');
  check('janela encontrada', Boolean(probe.hwnd), probe.hwnd);
  check('dimensoes validas', probe.width > 0 && probe.height > 0,
    probe.width + 'x' + probe.height);
  check('canal PostMessageW', probe.transport === 'PostMessageW');
  check('modo background (sem foreground forcado)', probe.foreground === false);

  if (key) {
    const sent = run({ pid, request: { kind: 'key', key: String(key).toLowerCase() } });
    check('tecla aceita pelo transporte', sent.success === true, sent.error || 'ok');
    check('eventos contabilizados', sent.eventsSent >= 1, 'eventsSent=' + sent.eventsSent);
    check('efeito NAO declarado', sent.effectVerified === false);
  }

  if (direction !== null) {
    const moved = run({ pid, request: { kind: 'walk', direction: Number(direction) } });
    check('movimento aceito', moved.success === true, moved.error || 'ok');
    check('eventos de movimento', moved.eventsSent >= 1, 'eventsSent=' + moved.eventsSent);
    check('efeito NAO declarado (movimento)', moved.effectVerified === false);
  }

  const failed = results.filter(row => !row.ok);
  console.log('\nresumo: ' + (results.length - failed.length) + '/' + results.length + ' OK');
  console.log('nota: aceite do transporte nao comprova efeito no jogo.');
  process.exit(failed.length ? 1 : 0);
}

main();
