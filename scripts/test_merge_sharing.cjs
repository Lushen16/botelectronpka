const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const cs = require(path.join(base, 'lib/config-sharing.jsc'));
const schema = require(path.join(base, 'shared/schema.js'));

const baseConfig = schema.createConfig();
const sharedConfig = schema.createConfig();
sharedConfig.walker.smartWalking = true;

const encoded = cs.encodeSharedConfig(sharedConfig);

try {
  const merged = cs.mergeSharedConfig(encoded, baseConfig);
  console.log('mergeSharedConfig success with (encoded, baseConfig)!');
  console.log('smartWalking:', merged.config.walker.smartWalking);
} catch (e) {
  console.log('mergeSharedConfig error with (encoded, baseConfig):', e.message);
}
