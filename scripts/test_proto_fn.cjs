const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const proto = require(path.join(base, 'lib/protocol.jsc'));

for (const name of Object.keys(proto.COMMANDS)) {
  try {
    const res = proto.encodeCommand(1, name);
    console.log(`Command '${name}' with 0 extra args: length = ${res.length}, hex = ${res.toString('hex')}`);
  } catch (e) {
    console.log(`Command '${name}' with 0 extra args failed: ${e.message}`);
  }
}
