#!/usr/bin/env node
'use strict';

// Patch the Shiba loader's hardcoded client version and refresh the install manifest hashes.
//
// usage: node tools/patch-version.cjs <appDir> <oldVer> <newVer>
//   appDir = %LOCALAPPDATA%\ShibaLauncher\Apps\<sha1>   (contains current\.shiba-install.json)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const [, , appDirArg, oldVer = '3.2.9', newVer = '3.3.0'] = process.argv;
if (!appDirArg) {
  console.error('usage: node tools/patch-version.cjs <appDir> [oldVer] [newVer]');
  process.exit(2);
}

const appDir = path.resolve(appDirArg);
const manifestPath = path.join(appDir, 'current', '.shiba-install.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const exePath = path.join(appDir, 'current', manifest.PreferredExecutable);

if (!fs.existsSync(exePath)) {
  console.error(`missing exe: ${exePath}`);
  process.exit(1);
}

if (Buffer.byteLength(oldVer) !== Buffer.byteLength(newVer)) {
  console.error('versions must be the same byte length to patch in place');
  process.exit(1);
}

// ---- locate every occurrence, both encodings ------------------------------
const buf = fs.readFileSync(exePath);
const ascii = Buffer.from(oldVer, 'ascii');
const wide = Buffer.from(oldVer, 'utf16le');

function findAll(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

const asciiHits = findAll(buf, ascii);
const wideHits = findAll(buf, wide);
if (!asciiHits.length && !wideHits.length) {
  console.error(`no "${oldVer}" found in ${exePath}`);
  process.exit(1);
}

console.log(`exe: ${exePath}`);
console.log(`size: ${buf.length}`);
console.log(`ascii hits: ${asciiHits.map((o) => '0x' + o.toString(16)).join(', ')}`);
console.log(`utf16 hits: ${wideHits.map((o) => '0x' + o.toString(16)).join(', ')}`);

// ---- backup + patch in place ---------------------------------------------
const backupPath = `${exePath}.bak-${oldVer}`;
if (!fs.existsSync(backupPath)) fs.copyFileSync(exePath, backupPath);
console.log(`backup: ${backupPath}`);

asciiHits.forEach((off) => Buffer.from(newVer, 'ascii').copy(buf, off));
wideHits.forEach((off) => Buffer.from(newVer, 'utf16le').copy(buf, off));
fs.writeFileSync(exePath, buf);

// ---- verify ---------------------------------------------------------------
const after = fs.readFileSync(exePath);
for (const off of asciiHits) {
  if (after.toString('ascii', off, off + newVer.length) !== newVer) throw new Error(`ascii verify failed @0x${off.toString(16)}`);
}
for (const off of wideHits) {
  if (after.toString('utf16le', off, off + newVer.length * 2) !== newVer) throw new Error(`utf16 verify failed @0x${off.toString(16)}`);
}
if (after.length !== buf.length) throw new Error('size changed');

// ---- hashes ---------------------------------------------------------------
const sha256 = crypto.createHash('sha256').update(after).digest('hex');
const oldPreferred = manifest.PreferredExecutableHash;
manifest.PreferredExecutableHash = sha256;
if (manifest.ManagedFiles && manifest.ManagedFiles[manifest.PreferredExecutable]) {
  manifest.ManagedFiles[manifest.PreferredExecutable] = sha256;
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`sha256: ${sha256}`);
console.log(`manifest PreferredExecutableHash: ${oldPreferred} -> ${sha256}`);
console.log('patched, verified');
