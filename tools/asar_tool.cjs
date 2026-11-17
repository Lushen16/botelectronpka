'use strict';

/**
 * Leitor/escritor de ASAR mínimo e verificável.
 *
 * Formato observado (Electron 44 / @electron/asar 4.x):
 *   u32 @0   = 4                      (tamanho do campo seguinte)
 *   u32 @4   = pickleSize             (4 + 4 + len(json) + padding)
 *   u32 @8   = pickleSize - 4
 *   u32 @12  = len(json)
 *   @16      = json
 *   @16+len  = padding até fronteira de 4 bytes a partir do offset 8
 *   data     = 8 + pickleSize
 *
 * Uso:
 *   node tools/asar_tool.cjs list    <app.asar>
 *   node tools/asar_tool.cjs extract <app.asar> <dir>
 *   node tools/asar_tool.cjs pack    <dir> <app.asar>
 *   node tools/asar_tool.cjs verify  <app.asar> <dir>   (compara árvore)
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readAsar(file) {
  const buffer = fs.readFileSync(file);
  const pickleSize = buffer.readUInt32LE(4);
  const jsonLength = buffer.readUInt32LE(12);
  const dataStart = 8 + pickleSize;
  const header = JSON.parse(buffer.subarray(16, 16 + jsonLength).toString('utf8'));
  return { buffer, header, dataStart, pickleSize, jsonLength };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, full, out);
    else out.push({ path: full, entry });
  }
  return out;
}

function list(file) {
  const { header } = readAsar(file);
  return walk(header, '', []).map(row => row.path).sort();
}

function extract(file, dir) {
  const { buffer, header, dataStart } = readAsar(file);
  const rows = walk(header, '', []);
  for (const { path: rel, entry } of rows) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const start = dataStart + Number(entry.offset);
    fs.writeFileSync(target, buffer.subarray(start, start + Number(entry.size)));
  }
  fs.writeFileSync(path.join(dir, '.asar-header.json'),
    JSON.stringify(header, null, 2) + '\n', 'utf8');
  return rows.length;
}

function collect(dir, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = {};
  for (const entry of entries) {
    if (!prefix && entry.name === '.asar-header.json') continue;
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      files[entry.name] = { files: collect(path.join(dir, entry.name), rel).files };
    } else {
      files[entry.name] = { size: fs.statSync(path.join(dir, entry.name)).size };
    }
  }
  return { files };
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Ordena chaves para saída determinística, como o packer oficial. */
function stable(node) {
  const files = {};
  for (const key of Object.keys(node.files || {}).sort()) {
    const child = node.files[key];
    files[key] = child.files ? { files: stable(child).files } : child;
  }
  return { files };
}

function pack(dir, outFile) {
  const tree = stable(collect(dir));
  const rows = walk(tree, '', []);
  // Ordem de escrita: a mesma da árvore ordenada.
  const blobs = [];
  let offset = 0;
  for (const { path: rel } of rows) {
    const data = fs.readFileSync(path.join(dir, ...rel.split('/')));
    const entry = rel.split('/').reduce((node, part) => node.files[part], tree);
    entry.offset = String(offset);
    entry.size = data.length;
    entry.integrity = {
      algorithm: 'SHA256',
      hash: hash(data),
      blockSize: 4194304,
      blocks: [hash(data)],
    };
    blobs.push(data);
    offset += data.length;
  }

  const json = Buffer.from(JSON.stringify(tree), 'utf8');
  // Padding: o bloco do pickle começa em 8; JSON começa em 16.
  const padding = (4 - ((json.length) % 4)) % 4;
  const pickleSize = 4 + 4 + json.length + padding;
  const total = 8 + pickleSize + offset;

  const out = Buffer.alloc(total);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(pickleSize, 4);
  out.writeUInt32LE(pickleSize - 4, 8);
  out.writeUInt32LE(json.length, 12);
  json.copy(out, 16);
  let cursor = 8 + pickleSize;
  for (const blob of blobs) {
    blob.copy(out, cursor);
    cursor += blob.length;
  }
  fs.writeFileSync(outFile, out);
  return { files: rows.length, bytes: total, jsonLength: json.length, pickleSize };
}

function verify(asarFile, dir) {
  const { buffer, header, dataStart } = readAsar(asarFile);
  const problems = [];
  for (const { path: rel, entry } of walk(header, '', [])) {
    const disk = path.join(dir, ...rel.split('/'));
    if (!fs.existsSync(disk)) { problems.push('missing on disk: ' + rel); continue; }
    const expected = fs.readFileSync(disk);
    const start = dataStart + Number(entry.offset);
    const actual = buffer.subarray(start, start + Number(entry.size));
    if (expected.length !== actual.length) problems.push('size mismatch: ' + rel);
    else if (!expected.equals(actual)) problems.push('bytes mismatch: ' + rel);
  }
  return problems;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'list') {
    for (const row of list(rest[0])) console.log(row);
    return 0;
  }
  if (command === 'extract') {
    const count = extract(rest[0], rest[1]);
    console.log('extracted ' + count + ' files to ' + rest[1]);
    return 0;
  }
  if (command === 'pack') {
    const info = pack(rest[0], rest[1]);
    console.log(JSON.stringify(info));
    return 0;
  }
  if (command === 'verify') {
    const problems = verify(rest[0], rest[1]);
    if (problems.length) { for (const p of problems) console.error(p); return 1; }
    console.log('verify OK');
    return 0;
  }
  console.error('uso: list|extract|pack|verify');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { readAsar, list, extract, pack, verify, collect };
