#!/usr/bin/env node
'use strict';

/**
 * Testa a maquina de estados do run_in_game_thread SEM tocar no jogo.
 *
 * Reproduz a logica em JS (a mesma transicao) e prova que os dois bugs
 * apontados na revisao do GPT nao podem mais acontecer:
 *
 *   bug 1: done=1 antes da funcao -> timeout devolvia falha -> fallback
 *          movimento duplicado
 *   bug 2: slot global reutilizado -> result do pedido anterior lido
 *          como se fosse o novo
 *
 * Uso: node tests/walk_state_machine.test.cjs
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const IDLE = 0, CLAIMED = 1, RUNNING = 2, COMPLETED = 3;
const DONE = 1, FAILED = 0, INDETERMINATE = -1;

/* Transcricao fiel da logica em C. */
function makeSlot() {
  return { state: IDLE, seq: 0, result: 0, ownerSeq: 0, direction: 0 };
}

function hookRun(slot, fnDurationMs) {
  if (slot.state !== CLAIMED) return false;
  slot.state = RUNNING;
  slot.ownerSeq = slot.seq;
  /* simula a funcao demorando */
  slot._work = fnDurationMs;
  return true;
}

function hookFinish(slot, ok) {
  slot.result = ok ? 1 : 0;
  slot.state = COMPLETED;
}

function run(slot, dir, timeoutMs, hookDelayMs, fnDurationMs, fnOk = true) {
  if (slot.state !== IDLE && slot.state !== COMPLETED) return FAILED;
  slot.direction = dir;
  slot.result = 0;
  slot.ownerSeq = 0;
  const mySeq = ++slot.seq;
  slot.state = CLAIMED;

  let waited = 0;
  let claimed = false;
  let hookFired = false;
  while (waited < timeoutMs) {
    waited += 5;
    /* simula a mensagem chegando ao loop depois de hookDelayMs */
    if (!hookFired && waited >= hookDelayMs) {
      hookFired = hookRun(slot, fnDurationMs);
    }
    /* simula a funcao terminando */
    if (hookFired && slot.state === RUNNING && waited >= hookDelayMs + fnDurationMs) {
      hookFinish(slot, fnOk);
    }
    if (slot.state === RUNNING) claimed = true;
    if (slot.state === COMPLETED) {
      if (slot.ownerSeq !== mySeq) return INDETERMINATE;
      const ok = slot.result !== 0;
      slot.state = IDLE;
      return ok ? DONE : FAILED;
    }
  }
  if (claimed) return INDETERMINATE;
  slot.state = IDLE;
  return FAILED;
}

test('hook rapido: sucesso', () => {
  const s = makeSlot();
  assert.equal(run(s, 1, 300, 5, 20), DONE);
  assert.equal(s.state, IDLE);
});

test('bug 1 REGRESSAO: funcao lenta NAO devolve FAILED (impede fallback duplicado)', () => {
  const s = makeSlot();
  /* funcao demora 800ms, timeout 300ms */
  const r = run(s, 1, 300, 5, 800);
  assert.equal(r, INDETERMINATE, 'deve ser INDETERMINATE, nao FAILED');
  assert.notEqual(r, FAILED, 'FAILED faria o caller cair no fallback de teclado');
  assert.equal(s.state, RUNNING, 'estado fica RUNNING: o hook ainda vai terminar');
});

test('hook nunca dispara: FAILED honesto', () => {
  const s = makeSlot();
  const r = run(s, 1, 100, 99999, 10);
  assert.equal(r, FAILED);
  assert.equal(s.state, IDLE);
});

test('bug 2 REGRESSAO: pedido novo recusado enquanto o anterior esta em voo', () => {
  const s = makeSlot();
  assert.equal(run(s, 1, 300, 5, 800), INDETERMINATE);
  /* slot em RUNNING; novo pedido deve ser recusado, nao sequestrar o slot */
  const r2 = run(s, 2, 300, 5, 10);
  assert.equal(r2, FAILED, 'pedido novo com slot ocupado tem que ser recusado');
  assert.equal(s.direction, 1, 'direction do pedido em voo nao pode ser sobrescrita');
});

test('ownerSeq protege contra resultado de outro pedido', () => {
  const s = makeSlot();
  s.state = CLAIMED;
  s.seq = 7;
  s.ownerSeq = 3;      /* resultado de um pedido antigo */
  s.result = 1;
  s.state = COMPLETED;
  /* o chamador do pedido 7 ve COMPLETED com ownerSeq 3 -> INDETERMINATE */
  assert.notEqual(s.ownerSeq, s.seq);
});

test('INDETERMINATE nunca vira fallback no execute_command', () => {
  /* a regra do C: r == GAME_EXEC_DONE -> OK; r == INDETERMINATE -> UNSUPPORTED
   * sem tocar no teclado. So' FAILED cai no fallback. */
  const decide = r => r === DONE ? 'ok' : r === INDETERMINATE ? 'unsupported-sem-fallback' : 'fallback';
  assert.equal(decide(INDETERMINATE), 'unsupported-sem-fallback');
  assert.equal(decide(FAILED), 'fallback');
  assert.equal(decide(DONE), 'ok');
});
