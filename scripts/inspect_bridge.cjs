const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const bridge = require(path.join(base, 'lib/pipe-bridge.jsc'));
console.log('KIND:', bridge.KIND);
console.log('MAX_FRAME:', bridge.MAX_FRAME);
console.log('proof function:', typeof bridge.proof, bridge.proof ? bridge.proof.toString() : '');
console.log('frame function:', typeof bridge.frame, bridge.frame ? bridge.frame.toString() : '');

const proto = Object.getOwnPropertyNames(bridge.PipeBridge.prototype);
console.log('PipeBridge methods:', proto);

const sec = require(path.join(base, 'lib/security.jsc'));
console.log('ElectronSecurity methods:', Object.getOwnPropertyNames(sec.ElectronSecurity.prototype));
