const fs = require('fs');
let content = fs.readFileSync('reconstruction/app/main.cjs', 'utf8');

// 1. Add configSharing import after root declaration
const rootIdx = content.indexOf("const root = path.resolve(__dirname, '../..');");
if (rootIdx !== -1) {
  const insert = "\nrequire(path.join(root, 'extracted_v3.3.1/bytecode-runtime.cjs'));\nconst configSharing = require(path.join(root, 'extracted_v3.3.1/lib/config-sharing.jsc'));";
  content = content.slice(0, rootIdx + "const root = path.resolve(__dirname, '../..');".length) + insert + content.slice(rootIdx + "const root = path.resolve(__dirname, '../..');".length);
}

// 2. Add config sharing ports before '  });\n  window = new BrowserWindow'
const target = "    exportProfile: async config => {";
const targetIdx = content.indexOf(target);
if (targetIdx !== -1) {
  const endExport = content.indexOf('    },', targetIdx);
  if (endExport !== -1) {
    const insertPorts = `
    exportSharedProfile: async (config, options, profileName) => {
      const active = store.snapshot().profiles.find(p => p.name === (profileName || store.snapshot().activeProfile));
      const conf = config || active?.config;
      const res = await configSharing.exportSharedConfig(conf, options, routeStore);
      if (res?.text) {
        clipboard.writeText(res.text);
        res.copied = true;
      }
      return res;
    },
    inspectSharedProfile: (text, profileName) => {
      const decoded = configSharing.decodeSharedConfig(text);
      return configSharing.shareSummary(decoded);
    },
    importSharedProfile: async (text, profileName) => {
      const active = store.snapshot().profiles.find(p => p.name === (profileName || store.snapshot().activeProfile));
      const baseConf = active?.config || validateConfig({});
      const merged = configSharing.mergeSharedConfig(text, baseConf);
      if (merged?.route && routeStore) {
        const routeName = merged.route.name || 'Importado';
        await routeStore.save(routeName, merged.config, { waypoints: merged.route.waypoints });
      }
      return merged.config;
    },
    clearAlertHistory: () => true,
    copyAlertHistory: () => true,
    guildDailyReset: () => ({ accepted: true }),`;
    content = content.slice(0, endExport + 6) + insertPorts + content.slice(endExport + 6);
  }
}

fs.writeFileSync('reconstruction/app/main.cjs', content, 'utf8');
console.log('main.cjs updated successfully!');
