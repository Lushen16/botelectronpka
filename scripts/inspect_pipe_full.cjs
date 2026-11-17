const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const bridge = require(path.join(base, 'lib/pipe-bridge.jsc'));

// Let's inspect methods of PipeBridge
const pb = new bridge.PipeBridge({ directory: 'C:/Users/yago/AppData/Local/OTPbot' });
console.log('Default settings:', {
  pollMs: pb.pollMs,
  staleMs: pb.staleMs,
  commandTimeoutMs: pb.commandTimeoutMs,
  startupTimeoutMs: pb.startupTimeoutMs
});

console.log('connect typeof:', typeof pb.connect);

// Let's see how pipe name is built or where it connects
// Check strings in PipeBridge
const fs = require('fs');
const content = fs.readFileSync(path.join(base, 'lib/pipe-bridge.jsc'));
const strings = [];
let curr = '';
for (let i = 0; i < content.length; i++) {
  const byte = content[i];
  if (byte >= 32 && byte <= 126) {
    curr += String.fromCharCode(byte);
  } else {
    if (curr.length >= 4) strings.push(curr);
    curr = '';
  }
}
const pipeRelated = strings.filter(s => s.toLowerCase().includes('pipe') || s.toLowerCase().includes('pka') || s.includes('\\\\.\\'));
console.log('Pipe related strings in jsc:', Array.from(new Set(pipeRelated)));
