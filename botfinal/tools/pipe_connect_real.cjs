'use strict';

// Real, un-simulated connect attempt against the live PKA runtime pipe.
// Reports the exact Node error so we know whether "pipe busy" is surfaced
// as EAGAIN/EBUSY or something else on this platform.
const net = require('node:net');

const pid = Number(process.argv[2] || 0);
if (!Number.isInteger(pid) || pid <= 0) {
  console.error('usage: node tools/pipe_connect_real.cjs <pid>');
  process.exit(2);
}

const path = '\\\\.\\pipe\\pka-runtime-2-' + pid;
console.log('path:', path);

const socket = net.connect(path);
let done = false;
const finish = (label, extra = '') => {
  if (done) return;
  done = true;
  console.log(label, extra);
  try { socket.destroy(); } catch { /* ignore */ }
};

socket.on('connect', () => finish('CONNECTED', 'a second client can attach'));
socket.on('error', error => finish('ERROR', JSON.stringify({ message: error.message, code: error.code, errno: error.errno })));
setTimeout(() => finish('TIMEOUT', 'no connect and no error in 3000ms'), 3000);
