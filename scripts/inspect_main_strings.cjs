const path = require('path');
const base = 'C:/Users/yago/Documents/Clone/RECONSTRUÇAO OFIcial/extracted_v3.3.1';
const fs = require('fs');

const buf = fs.readFileSync(path.join(base, 'main.jsc'));
const strings = [];
let curr = '';
for (let i = 0; i < buf.length; i++) {
  const b = buf[i];
  if (b >= 32 && b <= 126) curr += String.fromCharCode(b);
  else {
    if (curr.length >= 4) strings.push(curr);
    curr = '';
  }
}

const sharingStrings = strings.filter(s => s.toLowerCase().includes('share') || s.toLowerCase().includes('export') || s.toLowerCase().includes('import'));
console.log('Sharing strings in main.jsc:', Array.from(new Set(sharingStrings)));
