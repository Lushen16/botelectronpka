const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const cs = require(path.join(base, 'lib/config-sharing.jsc'));
const schema = require(path.join(base, 'shared/schema.js'));
const defaultConfig = schema.createConfig();

const res = cs.exportSharedConfig(defaultConfig, { mode: 'none' }, []);
console.log('Returned value:', res);
