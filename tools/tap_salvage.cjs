'use strict';

/**
 * Extrai o que da' pra recuperar de frames de telemetria TRUNCADOS.
 *
 * Um telemetry completo tem ~46 KB (roster + moves + items + creatures +
 * alertEvents). O tap antigo cortava em 8192 e o JSON ficava invalido. Aqui a
 * gente le os campos escalares do comeco, antes do corte, e salva o texto cru
 * para inspecao.
 *
 *   node tools/tap_salvage.cjs [arquivo]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const input = process.argv[2] || path.join(ROOT, 'native', 'pka_tap_10244.jsonl');
const outDir = path.join(ROOT, 'captures');

function scalar(text, name) {
  const pattern = new RegExp('"' + name + '":("(?:[^"\\\\]|\\\\.)*"|\\{[^{}]*\\}|[-0-9.eE+]+|null|true|false)');
  const match = text.match(pattern);
  return match ? match[1] : undefined;
}

function main() {
  const records = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

  const telemetry = records.filter(r => r.kind === 5);
  const truncated = telemetry.filter(r => r.trunc).sort((a, b) => b.n - a.n);
  const intact = telemetry.filter(r => !r.trunc);

  console.log('arquivo     : ' + input);
  console.log('total frames: ' + records.length);
  console.log('telemetry   : ' + telemetry.length +
    ' (integras ' + intact.length + ', truncadas ' + truncated.length + ')');

  if (!truncated.length) {
    console.log('\nnenhuma truncada. nada a recuperar.');
    return;
  }

  const biggest = truncated[0];
  console.log('\ntamanho real da maior: ' + biggest.n + ' bytes');
  console.log('gravado              : ' + (biggest.d.length / 2) + ' bytes');

  const text = Buffer.from(biggest.d, 'hex').toString('utf8');
  fs.mkdirSync(outDir, { recursive: true });
  const rawFile = path.join(outDir, 'telemetry-truncated-raw.json');
  fs.writeFileSync(rawFile, text);

  const fields = ['tick', 'schema', 'pulseVersion', 'nativeVerified', 'playerName',
    'playerId', 'pokemonName', 'comboPokemonName', 'fightMode', 'chaseMode',
    'direction', 'activeSlot', 'ownSummonId', 'clientPid', 'clockMs'];
  console.log('\n-- campos escalares recuperados --');
  const recovered = {};
  for (const name of fields) {
    const value = scalar(text, name);
    if (value !== undefined) {
      recovered[name] = value;
      console.log('  ' + name.padEnd(18) + value);
    }
  }
  const position = scalar(text, 'position');
  if (position) console.log('  ' + 'position'.padEnd(18) + position);

  fs.writeFileSync(path.join(outDir, 'telemetry-salvaged.json'),
    JSON.stringify(recovered, null, 2) + '\n');
  console.log('\ntexto cru : ' + rawFile);
  console.log('campos    : ' + path.join(outDir, 'telemetry-salvaged.json'));
}

main();
