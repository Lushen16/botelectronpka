const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const proto = require(path.join(base, 'lib/protocol.jsc'));

// State is 48 bytes
const buf = Buffer.alloc(48);
buf.writeUInt32LE(1, 0); // isOnline / protoVersion / ?
try {
  const decoded = proto.decodeState(buf);
  console.log('Decoded dummy state:', decoded);
} catch (e) {
  console.log('decodeState error:', e.message);
}

// Ack is 12 bytes
const ackBuf = Buffer.alloc(12);
ackBuf.writeUInt32LE(1, 0); // commandId
ackBuf.writeUInt32LE(0, 4); // status
try {
  const decodedAck = proto.decodeAck(ackBuf);
  console.log('Decoded dummy ack:', decodedAck);
} catch (e) {
  console.log('decodeAck error:', e.message);
}
