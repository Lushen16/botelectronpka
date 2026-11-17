const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
require(path.join(base, 'bytecode-runtime.cjs'));

const cs = require(path.join(base, 'lib/config-sharing.jsc'));
const schema = require(path.join(base, 'shared/schema.js'));
const defaultConfig = schema.createConfig();

// Mock routeStore
const mockRouteStore = {
  get(id) {
    return { name: 'Route A', waypoints: [{ action: 'walk', pos: { x: 1, y: 2, z: 7 } }] };
  }
};

async function run() {
  const exported = await cs.exportSharedConfig(defaultConfig, { mode: 'none' }, mockRouteStore);
  console.log('Exported text prefix:', exported.text.slice(0, 30));
  console.log('Summary:', exported.summary);

  const inspected = cs.shareSummary(cs.decodeSharedConfig(exported.text));
  console.log('Inspected:', inspected);

  const merged = cs.mergeSharedConfig(exported.text, defaultConfig);
  console.log('Merged config keys:', Object.keys(merged.config));
}

run().catch(console.error);
