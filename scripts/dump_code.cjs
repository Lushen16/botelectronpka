const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const bridge = require(path.join(base, 'lib/pipe-bridge.jsc'));
console.log('proof length:', bridge.proof.length);
console.log('frame length:', bridge.frame.length);
console.log('proof code:\n' + Function.prototype.toString.call(bridge.proof));
console.log('frame code:\n' + Function.prototype.toString.call(bridge.frame));

const proto = require(path.join(base, 'lib/protocol.jsc'));
console.log('encodeCommand code:\n' + Function.prototype.toString.call(proto.encodeCommand));
console.log('decodeState code:\n' + Function.prototype.toString.call(proto.decodeState));
console.log('decodeAck code:\n' + Function.prototype.toString.call(proto.decodeAck));
