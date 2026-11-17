const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const proto = require(path.join(base, 'lib/protocol.jsc'));
const buf = Buffer.alloc(12);

buf.writeUInt32LE(101, 0); // commandId = 101
buf.writeUInt32LE(1, 4);   // type = 1
buf.writeUInt32LE(0, 8);   // status = 0 (OK)

const ack = proto.decodeAck(buf);
console.log('Decoded ACK:', ack);
