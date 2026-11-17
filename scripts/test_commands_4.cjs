const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const proto = require(path.join(base, 'lib/protocol.jsc'));

function testObj(obj) {
  try {
    const buf = proto.encodeCommand(1, 'useWith', obj);
    console.log('SUCCESS:', JSON.stringify(obj), '-> hex:', buf.toString('hex'));
    return true;
  } catch (e) {
    return false;
  }
}

for (const targetId of [0, 1, undefined]) {
  for (const stack of [0, 1, 2, 255, undefined]) {
    for (const itemId of [100, 2000, 3000]) {
      const o = { x: 100, y: 200, z: 7, itemId, targetId, stack };
      testObj(o);
    }
  }
}
