const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const proto = require(path.join(base, 'lib/protocol.jsc'));
const buf = Buffer.alloc(48);

buf.writeUInt32LE(1, 0);          // version = 1
buf.writeUInt32LE(1, 4);          // isOnline = 1 (true)
buf.writeUInt32LE(100, 8);        // healthPercent = 100%
buf.writeDoubleLE(5500.0, 12);    // hp = 5500.0
buf.writeDoubleLE(200.0, 20);     // mana = 200.0
buf.writeDoubleLE(1000.0, 28);    // cap = 1000.0
buf.writeUInt32LE(12345, 36);     // targetId = 12345
buf.writeUInt32LE(42, 40);        // attackSeqNum = 42
buf.writeUInt32LE(1, 44);         // protoVersion = 1

const state = proto.decodeState(buf);
console.log('Decoded full state successfully:', state);
