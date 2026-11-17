const cp = require('child_process');
const csv = cp.execSync('tasklist /V /FO CSV').toString();
const lines = csv.split('\r\n').filter(Boolean);
for (const line of lines) {
  // simple csv parser for quotes
  const matches = line.match(/\"([^\"]*)\"/g);
  if (matches && matches.length >= 9) {
    const name = matches[0].replace(/\"/g, '');
    const pid = matches[1].replace(/\"/g, '');
    const session = matches[2].replace(/\"/g, '');
    const mem = matches[4].replace(/\"/g, '');
    const title = matches[8].replace(/\"/g, '');
    if (title && title !== 'N/A') {
      console.log(`${pid.padEnd(8)} | ${name.padEnd(25)} | ${mem.padEnd(12)} | ${title}`);
    }
  }
}
