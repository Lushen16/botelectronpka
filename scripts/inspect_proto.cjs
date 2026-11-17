const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

try {
  const proto = require(path.join(base, 'lib/protocol.jsc'));
  console.log('=== PROTOCOL CONSTANTS ===');
  console.log('Keys:', Object.keys(proto));
  console.log('STATE_SIZE:', proto.STATE_SIZE);
  console.log('COMMAND_SIZE:', proto.COMMAND_SIZE);
  console.log('ACK_SIZE:', proto.ACK_SIZE);
  console.log('COMMANDS:', proto.COMMANDS);
  console.log('STATUS:', proto.STATUS);
  console.log('DIRECTIONS:', proto.DIRECTIONS);
} catch (e) {
  console.error('Error loading protocol:', e);
}

try {
  const bridge = require(path.join(base, 'lib/pipe-bridge.jsc'));
  console.log('=== PIPE-BRIDGE EXPORTS ===');
  console.log('Keys:', Object.keys(bridge));
} catch (e) {
  console.error('Error loading pipe-bridge:', e);
}

try {
  const sec = require(path.join(base, 'lib/security.jsc'));
  console.log('=== SECURITY EXPORTS ===');
  console.log('Keys:', Object.keys(sec));
} catch (e) {
  console.error('Error loading security:', e);
}
