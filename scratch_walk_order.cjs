'use strict';
/* Sonda descartavel: mede quantos passos o motor do clone despacha para um
 * alvo de 1 tile sob telemetria repetida, atrasada, fora de ordem e sem tick.
 * Mesmo formato da tabela de AGENTS.md ("Pendencia conhecida"). */
const { createWalkerEngine } = require('./reconstruction/engines/walker-engine.cjs');

const sink = () => { const out = []; return { out, command: (n, p) => out.push([n, p]) }; };

function run(name, samples) {
  const engine = createWalkerEngine({ walker: { loop: false, waypoints: [
    { action: 'walk', pos: { x: 11, y: 10, z: 7 } },
  ] } });
  const rec = sink();
  let steps = 0;
  let now = 0;
  for (const sample of samples) {
    const result = engine.step({ ...sample, position: sample.position }, rec, now);
    if (result.action === 'move') steps += 1;
    now += 100;
  }
  console.log(`${name.padEnd(34)} passos=${steps} esperado=1 ${steps === 1 ? 'OK' : 'FALHA'} razoes=${JSON.stringify(rec.out)}`);
  return steps;
}

const p = (x) => ({ position: { x, y: 10, z: 7 } });
run('repetida (10,10,10) tick=10', [{ tick: 10, ...p(10) }, { tick: 10, ...p(10) }, { tick: 10, ...p(10) }]);
run('atrasada (10,9,9)', [{ tick: 10, ...p(10) }, { tick: 9, ...p(10) }, { tick: 9, ...p(10) }]);
run('fora de ordem (10,12,11)', [{ tick: 10, ...p(10) }, { tick: 12, ...p(10) }, { tick: 11, ...p(10) }]);
run('sem tick (undefined x3)', [p(10), p(10), p(10)]);
