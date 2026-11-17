const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const bridge = require(path.join(base, 'lib/pipe-bridge.jsc'));
const testPayload = Buffer.from('12345678'); // 8 bytes
const f = bridge.frame(bridge.KIND.telemetry, testPayload); // telemetry = 5

console.log('Real frame hex:', f.toString('hex'));
console.log('Offset 0 (uint32):', f.readUInt32LE(0)); // Should be 5 (kind)
console.log('Offset 4 (uint32):', f.readUInt32LE(4)); // Should be 8 (payload length)
