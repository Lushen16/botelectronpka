const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const cs = require(path.join(base, 'lib/config-sharing.jsc'));
for (const [k, v] of Object.entries(cs)) {
  if (typeof v === 'function') {
    console.log(k, 'length:', v.length);
  }
}
