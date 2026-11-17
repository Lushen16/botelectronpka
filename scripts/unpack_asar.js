const fs = require('fs');
const path = require('path');

function unpackAsar(asarPath, destDir) {
  const fd = fs.openSync(asarPath, 'r');
  const sizeBuf = Buffer.alloc(16);
  fs.readSync(fd, sizeBuf, 0, 16, 0);
  const jsonLen = sizeBuf.readUInt32LE(12);
  const headerBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, headerBuf, 0, jsonLen, 16);
  const header = JSON.parse(headerBuf.toString('utf8'));
  
  // The actual payload data starts after header
  // Note: standard asar header size = 16 + jsonLen, padded to 4 bytes boundary if needed
  // In asar format: header length is sizeBuf.readUInt32LE(4), payload starts at 8 + sizeBuf.readUInt32LE(4)
  const headerSize = sizeBuf.readUInt32LE(4);
  const baseOffset = 8 + headerSize;

  function extractNode(node, currentPath) {
    if (node.files) {
      fs.mkdirSync(currentPath, { recursive: true });
      for (const [name, child] of Object.entries(node.files)) {
        extractNode(child, path.join(currentPath, name));
      }
    } else if (typeof node.size === 'number') {
      const offset = baseOffset + parseInt(node.offset, 10);
      const fileBuf = Buffer.alloc(node.size);
      fs.readSync(fd, fileBuf, 0, node.size, offset);
      fs.mkdirSync(path.dirname(currentPath), { recursive: true });
      fs.writeFileSync(currentPath, fileBuf);
    }
  }

  extractNode(header, destDir);
  fs.closeSync(fd);
  console.log('Unpacked successfully to', destDir);
}

const asarPath = 'C:\\Users\\yago\\AppData\\Local\\ShibaLauncher\\Apps\\e76115b4bfb0e918e392b648a54b7335\\current\\Shiba Bots - Poke Alliance v3.3.1\\dll\\resources\\app.asar';
const destDir = path.join(__dirname, '..', 'extracted_v3.3.1');
unpackAsar(asarPath, destDir);
