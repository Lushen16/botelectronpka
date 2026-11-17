const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const proto = require(path.join(base, 'lib/protocol.jsc'));

function testCmd(label, ...args) {
  try {
    const buf = proto.encodeCommand(1, ...args);
    console.log(`[PASS] ${label}: len=${buf.length}, hex=${buf.toString('hex')}`);
  } catch (e) {
    console.log(`[FAIL] ${label}: ${e.message}`);
  }
}

const pos = { x: 100, y: 200, z: 7 };

testCmd('orderGround 1', 'orderGround', 1234, pos);
testCmd('orderGround 2', 'orderGround', { summonId: 1234, pos });
testCmd('orderGround 3', 'orderGround', { summonId: 1234, ...pos });
testCmd('turn 1', 'turn', { direction: 0, pokemon: false });
testCmd('turn 2', 'turn', { direction: 0, pokemon: true });
testCmd('turn 3', 'turn', 0, { pokemon: true });
testCmd('useWith 1', 'useWith', { itemId: 3000, stack: 1, pos });
testCmd('useWith 2', 'useWith', 3000, 1, pos);
testCmd('useWith 3', 'useWith', 3000, pos, 1);
