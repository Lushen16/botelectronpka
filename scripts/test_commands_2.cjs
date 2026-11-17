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

// useWith: pos, itemId, stackPos or similar?
testCmd('useWith A', 'useWith', pos, 3000, 1);
testCmd('useWith B', 'useWith', pos, { itemId: 3000, stack: 1 });
testCmd('useWith C', 'useWith', pos, 3000, 0);

// orderGround: pos, summonId
testCmd('orderGround A', 'orderGround', pos, 123456);
testCmd('orderGround B', 'orderGround', pos, 123456, 1);

// guildDaily: string
for (const sep of [' ', ':', ',', '/', '-', '_']) {
  testCmd(`guildDaily ${sep}`, 'guildDaily', `normal${sep}fire`);
}

// turn: what does it look like?
// Let's test directions 0..3 and actor
for (const actor of ['player', 'pokemon', 0, 1, 'creature', 'self']) {
  for (const dir of [0, 1, 2, 3, 'north', 'south']) {
    try {
      const buf = proto.encodeCommand(1, 'turn', dir, actor);
      console.log(`[PASS] turn dir=${dir} actor=${actor}: ${buf.toString('hex')}`);
    } catch (e) {}
  }
}
