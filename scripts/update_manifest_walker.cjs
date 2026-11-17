const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const manifestPath = path.resolve('reconstruction/app/asset-manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const walkerPath = path.resolve('reconstruction/app/ui/walker-model.js');
const walkerHash = crypto.createHash('sha256').update(fs.readFileSync(walkerPath)).digest('hex');

const entry = manifest.files.find(f => f.path === 'walker-model.js');
if (entry) {
  entry.sha256 = walkerHash;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('Updated manifest for walker-model.js:', walkerHash);
}
