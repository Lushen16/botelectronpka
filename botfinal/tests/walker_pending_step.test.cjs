'use strict';

/**
 * Regressão do overshoot do WalkerEngine.
 *
 *   node --test botfinal/tests/walker_pending_step.test.cjs
 *
 * DEFEITO REPRODUZIDO (medido no cliente em 2026-11-06 01:24Z):
 *   waypoint (957,1403,6), origem (957,1404,6) — 1 tile
 *   2 comandos despachados em 294ms, personagem terminou em y=1402
 *   Causa: cadência do motor (280ms) >> intervalo da telemetria (1000ms).
 *   O segundo tick leu a MESMA amostra e despachou outro passo.
 *
 * INVARIANTES QUE ESTES TESTES EXIGEM:
 *   1. Um passo pendente bloqueia novo despacho.
 *   2. Só uma amostra MAIS NOVA (tick diferente) reconcilia o pendente.
 *   3. Amostra nova com posição inalterada NÃO libera novo passo.
 *   4. Chegada ao waypoint conclui sem comando adicional.
 *   5. Sem progresso até o prazo: bloqueia, sem retry automático.
 *   6. Ticks concorrentes: no máximo um passo pendente.
 *   7. Stop/pause invalida continuação assíncrona tardia.
 *   8. Mudança de entidade ou amostra antiga não libera caminhada.
 *   9. Rota de 2 passos avança só após confirmação do primeiro.
 *
 * Relógio é injetado: nenhum sleep real, nenhuma dependência de tempo.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { WalkerEngine } = require(path.join(__dirname, '..', 'engines', 'walker-engine.cjs'));

const TILE_MS = 280;
const TELEMETRY_MS = 1000;
const TIMEOUT_MS = 2500;

function telemetry({ tick, x, y, z = 6, playerId = 7 }) {
  return { tick, playerId, position: { x, y, z } };
}

/** Harness com relógio controlado e dispatcher que só conta. */
function harness({ start, waypoints, playerId = 7, resolveDelayMs = 0 }) {
  let clock = 1000;
  const now = () => clock;
  const commands = [];
  const engine = new WalkerEngine({ walker: { enabled: true, waypoints } },
    { now, progressTimeoutMs: TIMEOUT_MS, playerId });

  const dispatcher = {
    async sendCommand(name, parameter) {
      commands.push({ name, parameter, at: clock });
      if (resolveDelayMs > 0) {
        /* Simula transporte assíncrono: o relógio avança enquanto espera. */
        await new Promise(resolve => setTimeout(resolve, 0));
        clock += resolveDelayMs;
      }
      return { commandId: commands.length, status: 0 };
    },
  };

  return {
    engine,
    dispatcher,
    commands,
    advance(ms) { clock += ms; },
    get clock() { return clock; },
    start: start ?? { x: 957, y: 1404, z: 6 },
    playerId,
  };
}

/* ------------------------------------------------------------------ */
/* 1. O BUG ORIGINAL: dois despachos com a mesma amostra                */
/* ------------------------------------------------------------------ */

test('cadencia 280ms com telemetria 1000ms nao duplica o passo pendente', async () => {
  /* O motor antigo NAO aceita relogio injetado: usa Date.now() direto.
   * Para que este teste reproduza o defeito de verdade (e nao passe por
   * acidente porque dois ticks instantaneos caem dentro da cadencia),
   * avancamos o relogio REAL em 300ms entre os ticks. Isso e' o cenario
   * do cliente: passos separados por ~294ms, mesma amostra de telemetria. */
  const { WalkerEngine: W } = require(path.join(__dirname, '..', 'engines', 'walker-engine.cjs'));
  const commands = [];
  const dispatcher = {
    async sendCommand(name, parameter) {
      commands.push({ name, parameter });
      return { commandId: commands.length, status: 0 };
    },
  };
  const engine = new W({ walker: { enabled: true,
    waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] } });
  const amostra = telemetry({ tick: 1, x: 957, y: 1404 });

  const first = await engine.tick(amostra, dispatcher);
  assert.equal(first.status, 'step-dispatched');
  assert.equal(commands.length, 1, 'primeiro passo deve sair');

  /* 300ms reais: passa a cadencia de 280ms. */
  await new Promise(resolve => setTimeout(resolve, 300));

  const second = await engine.tick(amostra, dispatcher);
  assert.equal(commands.length, 1,
    'a MESMA amostra nao pode gerar um segundo passo (era 2 antes da correção)');
  assert.notEqual(second.status, 'step-dispatched');
});

test('amostra nova com posicao inalterada continua aguardando', async () => {
  const h = harness({ waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] });
  await h.engine.tick(telemetry({ tick: 1, x: 957, y: 1404 }), h.dispatcher);
  assert.equal(h.commands.length, 1);

  h.advance(TELEMETRY_MS);
  const r = await h.engine.tick(telemetry({ tick: 2, x: 957, y: 1404 }), h.dispatcher);
  assert.equal(h.commands.length, 1, 'posicao igual nao libera novo passo');
  assert.match(r.status, /awaiting|pending/u);
});

test('chegada ao waypoint conclui sem comando adicional', async () => {
  const h = harness({ waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] });
  await h.engine.tick(telemetry({ tick: 1, x: 957, y: 1404 }), h.dispatcher);
  assert.equal(h.commands.length, 1);

  h.advance(TELEMETRY_MS);
  const r = await h.engine.tick(telemetry({ tick: 2, x: 957, y: 1403 }), h.dispatcher);
  assert.equal(r.status, 'waypoint-reached');
  assert.equal(h.commands.length, 1, 'chegada nao pode gerar movimento extra');
});

test('sem progresso ate o prazo bloqueia sem retry automatico', async () => {
  const h = harness({ waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] });
  await h.engine.tick(telemetry({ tick: 1, x: 957, y: 1404 }), h.dispatcher);
  assert.equal(h.commands.length, 1);

  let blocked = null;
  /* Amostras novas, posicao parada, tempo passando. */
  for (let tick = 2; tick <= 8; tick += 1) {
    h.advance(TELEMETRY_MS);
    const r = await h.engine.tick(telemetry({ tick, x: 957, y: 1404 }), h.dispatcher);
    if (r.status === 'blocked') { blocked = r; break; }
  }
  assert.ok(blocked, 'deveria bloquear apos o prazo sem progresso');
  assert.match(String(blocked.reason), /timeout|timeout|sem progresso|no-progress/iu);
  assert.equal(h.commands.length, 1, 'nao pode repetir comando cujo efeito e desconhecido');

  /* Depois de bloqueado, mais ticks nao podem retomar sozinhos. */
  h.advance(TELEMETRY_MS);
  const after = await h.engine.tick(telemetry({ tick: 9, x: 957, y: 1404 }), h.dispatcher);
  assert.notEqual(after.status, 'step-dispatched', 'bloqueio nao se libera sozinho');
  assert.equal(h.commands.length, 1);
});

/* ------------------------------------------------------------------ */
/* 2. CONCORRÊNCIA E CICLO DE VIDA                                     */
/* ------------------------------------------------------------------ */

test('ticks concorrentes produzem no maximo um passo pendente', async () => {
  const h = harness({
    waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }],
    resolveDelayMs: 200,
  });
  const amostra = telemetry({ tick: 1, x: 957, y: 1404 });
  const [a, b] = await Promise.all([
    h.engine.tick(amostra, h.dispatcher),
    h.engine.tick(amostra, h.dispatcher),
  ]);
  assert.equal(h.commands.length, 1, 'dois ticks simultaneos nao podem despachar dois passos');
  assert.ok(['step-dispatched', 'awaiting-progress'].includes(a.status));
  assert.ok(['step-dispatched', 'awaiting-progress'].includes(b.status));
});

test('stop com passo pendente invalida continuacao tardia', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const commands = [];
  const dispatcher = {
    async sendCommand(name, parameter) {
      commands.push({ name, parameter });
      await gate; // fica pendurado até liberarmos
      return { commandId: commands.length, status: 0 };
    },
  };
  const engine = new WalkerEngine(
    { walker: { enabled: true, waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] } },
    { now: () => 1000, progressTimeoutMs: TIMEOUT_MS, playerId: 7 },
  );

  const pending = engine.tick(telemetry({ tick: 1, x: 957, y: 1404 }), dispatcher);
  /* Para o motor ANTES de o envio resolver. */
  engine.pause();
  release();
  const r = await pending;

  assert.equal(commands.length, 1, 'o comando em voo ja saiu; nao pode sair outro');
  assert.notEqual(r.status, 'step-dispatched',
    'depois do pause a continuacao deve ser descartada, nao confirmada');
  assert.equal(engine.pendingStep, null, 'o pendente precisa ser limpo no pause');

  /* Novos ticks depois do pause nao despacham. */
  const after = await engine.tick(telemetry({ tick: 2, x: 957, y: 1404 }), dispatcher);
  assert.equal(after.status, 'idle');
  assert.equal(commands.length, 1);
});

test('mudanca de entidade interrompe e registra, sem mover', async () => {
  const h = harness({ waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] });
  await h.engine.tick(telemetry({ tick: 1, x: 957, y: 1404, playerId: 7 }), h.dispatcher);
  assert.equal(h.commands.length, 1);

  h.advance(TELEMETRY_MS);
  const r = await h.engine.tick(telemetry({ tick: 2, x: 957, y: 1404, playerId: 8 }), h.dispatcher);
  assert.match(r.status, /abort|blocked|entity/iu);
  assert.equal(h.commands.length, 1, 'entidade diferente nao pode liberar caminhada');
  assert.equal(h.engine.pendingStep, null);
});

test('amostra antiga ou fora de ordem nao reconcilia o pendente', async () => {
  const h = harness({ waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] });
  await h.engine.tick(telemetry({ tick: 5, x: 957, y: 1404 }), h.dispatcher);
  assert.equal(h.commands.length, 1);

  h.advance(TILE_MS);
  /* Mesmo tick (repetida) e tick menor (fora de ordem): nenhum libera. */
  for (const tick of [5, 4]) {
    const r = await h.engine.tick(telemetry({ tick, x: 957, y: 1403 }), h.dispatcher);
    assert.notEqual(r.status, 'waypoint-reached',
      'amostra tick=' + tick + ' nao pode confirmar chegada');
    assert.equal(h.commands.length, 1);
  }
});

test('mudanca de andar interrompe em vez de reinterpretar', async () => {
  const h = harness({ waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] });
  await h.engine.tick(telemetry({ tick: 1, x: 957, y: 1404, z: 6 }), h.dispatcher);

  h.advance(TELEMETRY_MS);
  const r = await h.engine.tick(telemetry({ tick: 2, x: 957, y: 1404, z: 7 }), h.dispatcher);
  assert.match(r.status, /abort|blocked|floor|z/iu);
  assert.equal(h.commands.length, 1);
});

/* ------------------------------------------------------------------ */
/* 3. ROTA DE DOIS PASSOS                                             */
/* ------------------------------------------------------------------ */

test('rota de dois passos avanca so apos confirmar o primeiro', async () => {
  const h = harness({
    waypoints: [
      { action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' },
      { action: 'walk', pos: { x: 957, y: 1402, z: 6 }, param: '' },
    ],
  });

  /* Passo 1: só um comando. */
  await h.engine.tick(telemetry({ tick: 1, x: 957, y: 1404 }), h.dispatcher);
  assert.equal(h.commands.length, 1);
  assert.deepEqual(h.commands[0].parameter, 0, 'norte');

  /* Mesma amostra: nada. */
  h.advance(TILE_MS);
  await h.engine.tick(telemetry({ tick: 1, x: 957, y: 1404 }), h.dispatcher);
  assert.equal(h.commands.length, 1, 'nao pode disparar os dois antecipadamente');

  /* Chegou ao waypoint 1. */
  h.advance(TELEMETRY_MS);
  const reached = await h.engine.tick(telemetry({ tick: 2, x: 957, y: 1403 }), h.dispatcher);
  assert.equal(reached.status, 'waypoint-reached');
  assert.equal(h.commands.length, 1, 'chegar nao despacha; quem despacha e o proximo tick');

  /* Proximo tick, mesma amostra: segue para o waypoint 2. */
  h.advance(TILE_MS);
  const second = await h.engine.tick(telemetry({ tick: 2, x: 957, y: 1403 }), h.dispatcher);
  assert.equal(second.status, 'step-dispatched');
  assert.equal(h.commands.length, 2, 'avança para o segundo waypoint depois de confirmar o primeiro');
  assert.deepEqual(h.commands[1].parameter, 0, 'norte de novo');

  /* Chegou ao waypoint 2: fim, sem novos comandos. */
  h.advance(TELEMETRY_MS);
  const done = await h.engine.tick(telemetry({ tick: 3, x: 957, y: 1402 }), h.dispatcher);
  assert.equal(done.status, 'waypoint-reached');
  assert.equal(h.commands.length, 2);
});

/* ------------------------------------------------------------------ */
/* 4. ANCORAGEM: o pendente expõe o que foi enviado                    */
/* ------------------------------------------------------------------ */

test('confirma um passo intermediario sem pular o waypoint distante', async () => {
  const waypoint = { x: 957, y: 1402, z: 6 };
  const h = harness({ waypoints: [
    { action: 'walk', pos: waypoint },
    { action: 'walk', pos: { x: 958, y: 1402, z: 6 } },
  ] });
  const first = await h.engine.tick(telemetry({ tick: 1, x: 957, y: 1404 }), h.dispatcher);
  assert.deepEqual(first.pending.target, { x: 957, y: 1403, z: 6 });
  assert.deepEqual(first.targetWp, waypoint);
  h.advance(TELEMETRY_MS);
  const middle = telemetry({ tick: 2, x: 957, y: 1403 });
  const confirmed = await h.engine.tick(middle, h.dispatcher);
  assert.equal(confirmed.status, 'step-confirmed');
  assert.equal(confirmed.nextIndex, 0);
  const second = await h.engine.tick(middle, h.dispatcher);
  assert.deepEqual(second.pending.target, waypoint);
  h.advance(TELEMETRY_MS);
  const reached = await h.engine.tick(telemetry({ tick: 3, x: 957, y: 1402 }), h.dispatcher);
  assert.equal(reached.status, 'waypoint-reached');
  assert.equal(reached.nextIndex, 1);
});

test('o passo pendente registra origem, alvo, direcao e amostra', async () => {
  const h = harness({ waypoints: [{ action: 'walk', pos: { x: 957, y: 1403, z: 6 }, param: '' }] });
  await h.engine.tick(telemetry({ tick: 9, x: 957, y: 1404, playerId: 7 }), h.dispatcher);
  const p = h.engine.pendingStep;
  assert.ok(p, 'precisa registrar o pendente');
  assert.deepEqual(p.from, { x: 957, y: 1404, z: 6 });
  assert.deepEqual(p.target, { x: 957, y: 1403, z: 6 });
  assert.equal(p.direction, 0);
  assert.equal(p.sampleTick, 9);
  assert.equal(p.playerId, 7);
});
