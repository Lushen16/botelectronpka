const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const proto = require(path.join(base, 'lib/protocol.jsc'));

function testCmd(name, ...args) {
  try {
    const buf = proto.encodeCommand(100, name, ...args);
    console.log(`Cmd '${name}': len=${buf.length}, hex=${buf.toString('hex')}`);
  } catch (e) {
    console.log(`Cmd '${name}' error: ${e.message}`);
  }
}

testCmd('walk', 0); // north
testCmd('walk', 1); // east
testCmd('attack', 9999);
testCmd('follow', 9999);
testCmd('stop');
testCmd('focus');
testCmd('turn', 0); // direction north
testCmd('turn', 1, 1);
testCmd('order', { x: 100, y: 200, z: 7 });
testCmd('orderGround', { x: 100, y: 200, z: 7 });
testCmd('useWith', { x: 100, y: 200, z: 7 }, 1234);
testCmd('talk', 'hello');
testCmd('combo', '!autocombo m1, m2');
testCmd('switchPokemon', 'Charizard');
testCmd('recallPokemon', 'Charizard');
testCmd('hotkey', 'F1');
testCmd('guildDaily', 'normal', 'fire');
testCmd('refreshCombo');
testCmd('chase');
