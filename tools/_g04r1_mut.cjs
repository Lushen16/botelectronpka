const fs = require('fs');
const p = 'reconstruction/engine-runtime.cjs';
let s = fs.readFileSync(p, 'utf8');
const alvo = `    const blocked = [...new Set(compatibility.missing.map(entry => entry.module))];
    return { modules: [], compatibility, blocked, refused: true };`;
if (!s.includes(alvo)) { console.error('ALVO NAO ENCONTRADO'); process.exit(1); }
s = s.replace(alvo, `    const blocked = [...new Set(compatibility.missing.map(entry => entry.module))];
    /* MUTACAO: remove so' os modulos incompatíveis e sobe o resto. */
    return { modules: requested.filter(m => !blocked.includes(m)), compatibility, blocked, refused: false };`);
fs.writeFileSync(p, s);
console.log('mutacao aplicada: partida parcial silenciosa');
