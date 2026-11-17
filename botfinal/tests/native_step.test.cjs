'use strict';

/**
 * Contrato do passo nativo. Nenhum teste aqui toca no cliente.
 *
 *   node --test botfinal/tests/native_step.test.cjs
 *
 * O que estes testes garantem: a máquina de estados nunca colapsa
 * "recebido", "agendado", "executado" e "observado"; um comando por vez;
 * expiração descarta; sessão anterior é recusada; resultado incerto não
 * repete.
 *
 * O que eles NÃO garantem: que o cliente executou. Isso exige teste real.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { NativeStep, STATE, DEFAULT_TTL_MS } =
  require(path.join(__dirname, '..', 'core', 'native-step.cjs'));

const IDENTITY = { pid: 100, boot: 'a'.repeat(32), playerId: 7 };
const FROM = { x: 957, y: 1404, z: 6 };
const TARGET = { x: 957, y: 1403, z: 6 };

function harness(options = {}) {
  let clock = 1000;
  const step = new NativeStep({ now: () => clock, ttlMs: options.ttlMs ?? 2500 });
  return {
    step,
    advance(ms) { clock += ms; },
    get clock() { return clock; },
    command: (over = {}) => ({ direction: 0, identity: IDENTITY, from: FROM,
      target: TARGET, ...over }),
  };
}

const cmd = { direction: 0, identity: IDENTITY, from: FROM, target: TARGET };

test('aceita um comando válido e fica ACCEPTED', () => {
  const h = harness();
  h.step.accept(cmd);
  assert.equal(h.step.state, STATE.ACCEPTED);
  assert.equal(h.step.pending, true);
  assert.deepEqual(h.step.status.identity, IDENTITY);
});

test('recusa segundo comando enquanto há um pendente', () => {
  const h = harness();
  h.step.accept(cmd);
  const refused = h.step.accept(cmd);
  assert.equal(refused.reason, 'already-pending');
  assert.equal(h.step.state, STATE.ACCEPTED, 'estado não muda');
});

test('recusa identidade incompleta ou inválida', () => {
  const h = harness();
  assert.equal(h.step.accept({ ...cmd, identity: null }).reason, 'bad-identity');
  assert.equal(h.step.accept({ ...cmd,
    identity: { pid: 100, boot: '', playerId: 7 } }).reason, 'bad-identity');
  assert.equal(h.step.accept({ ...cmd,
    identity: { pid: 100, boot: 'x'.repeat(32) } }).reason, 'bad-identity');
  assert.equal(h.step.state, STATE.IDLE);
});

test('recusa direção fora de 0..7', () => {
  const h = harness();
  assert.equal(h.step.accept({ ...cmd, direction: 8 }).reason, 'bad-direction');
  assert.equal(h.step.accept({ ...cmd, direction: -1 }).reason, 'bad-direction');
});

test('os cinco estágios são distintos e ordenados', () => {
  const h = harness();
  h.step.accept(cmd);
  assert.equal(h.step.status.scheduledAt, null);
  assert.equal(h.step.status.executingAt, null);
  assert.equal(h.step.status.executedAt, null);
  assert.equal(h.step.status.observedAt, null);

  h.advance(10);
  h.step.schedule();
  assert.equal(h.step.state, STATE.SCHEDULED);
  assert.ok(h.step.status.scheduledAt > 0);
  assert.equal(h.step.status.executingAt, null, 'agendado != em execução');
  assert.equal(h.step.status.executedAt, null, 'agendado != executado');

  h.advance(10);
  const claim = h.step.beginExecution().claim;
  assert.equal(h.step.state, STATE.EXECUTING);
  assert.ok(h.step.status.executingAt > 0);
  assert.equal(h.step.status.executedAt, null, 'em execução != executado');

  h.advance(10);
  h.step.markExecuted(claim);
  assert.equal(h.step.state, STATE.EXECUTED);
  assert.ok(h.step.status.executedAt > 0);
  assert.equal(h.step.status.observedAt, null, 'executado != observado');
});

test('executado NÃO conta como efeito', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.schedule();
  const claim = h.step.beginExecution().claim;
  h.step.markExecuted(claim);
  assert.equal(h.step.state, STATE.EXECUTED);
  assert.equal(h.step.status.observedAt, null);
  assert.equal(h.step.pending, true);
});

test('observado exige posição no alvo e mesma entidade', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.schedule();
  const claim = h.step.beginExecution().claim;
  h.step.markExecuted(claim);

  const partial = h.step.observe({ playerId: 7, position: { x: 957, y: 1404, z: 6 } });
  assert.equal(partial.action, 'observe-pending');
  assert.equal(h.step.state, STATE.EXECUTED, 'sem movimento, continua EXECUTED');

  h.step.observe({ playerId: 7, position: TARGET });
  assert.equal(h.step.state, STATE.OBSERVED);
  assert.deepEqual(h.step.status.observedPosition, TARGET);
});

test('entidade diferente falha em vez de "observar"', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.schedule();
  const claim = h.step.beginExecution().claim;
  h.step.markExecuted(claim);
  const r = h.step.observe({ playerId: 99, position: TARGET });
  assert.equal(r.reason, 'entity-changed');
  assert.equal(h.step.state, STATE.FAILED);
});

test('comando expirado falha antes de agendar', () => {
  const h = harness({ ttlMs: 100 });
  h.step.accept(cmd);
  h.advance(200);
  const r = h.step.schedule();
  assert.equal(r.reason, 'expired-before-schedule');
  assert.equal(h.step.state, STATE.FAILED);
});

test('cancelamento só vale antes de executar', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.cancel();
  assert.equal(h.step.state, STATE.CANCELLED, 'cancela em ACCEPTED');

  const h2 = harness();
  h2.step.accept(cmd);
  h2.step.schedule();
  h2.step.cancel();
  assert.equal(h2.step.state, STATE.CANCELLED, 'cancela em SCHEDULED');

  const h3 = harness();
  h3.step.accept(cmd);
  h3.step.schedule();
  const claim = h3.step.beginExecution().claim;
  const r3 = h3.step.cancel();
  assert.equal(r3.action, 'cancel-refused', 'não cancela em EXECUTING');
  assert.equal(h3.step.state, STATE.EXECUTING);

  h3.step.markExecuted(claim);
  const r4 = h3.step.cancel();
  assert.equal(r4.action, 'cancel-refused');
  assert.equal(h3.step.state, STATE.EXECUTED, 'não cancela o que já foi enviado');
});

test('cancelamento posterior não engana a máquina durante a execução', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.schedule();

  /* Simula: pedido de cancelamento chega concorrente com o início. Quem
   * ganha o claim primeiro decide. */
  const began = h.step.beginExecution();
  assert.equal(began.ok, true);
  const cancelled = h.step.cancel();
  assert.equal(cancelled.action, 'cancel-refused');
  assert.equal(h.step.state, STATE.EXECUTING,
    'a máquina não pode reportar cancelled com execução em voo');

  h.step.markExecuted(began.claim);
  assert.equal(h.step.state, STATE.EXECUTED);
});

test('claim velho não promove um passo novo', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.schedule();
  const old = h.step.beginExecution().claim;
  h.step.markUnknown('transporte caiu', old);
  h.step.reset();

  /* Passo novo, execução nova, claim maior. */
  h.step.accept(cmd);
  h.step.schedule();
  const fresh = h.step.beginExecution().claim;
  assert.ok(fresh > old, 'claim é monotônico');

  const stale = h.step.markExecuted(old);
  assert.equal(stale.reason, 'stale-claim');
  assert.equal(h.step.state, STATE.EXECUTING, 'claim velho não mexe no estado atual');

  assert.equal(h.step.markExecuted(fresh).action, 'executed');
  assert.equal(h.step.state, STATE.EXECUTED);
});

test('resultado incerto de execução velha não envenena passo novo', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.schedule();
  const old = h.step.beginExecution().claim;
  h.step.markUnknown('timeout', old);
  h.step.reset();

  h.step.accept(cmd);
  h.step.schedule();
  const fresh = h.step.beginExecution().claim;

  const r = h.step.markUnknown('relatorio atrasado', old);
  assert.equal(r.reason, 'stale-claim');
  assert.equal(h.step.state, STATE.EXECUTING);

  assert.equal(h.step.markUnknown('timeout real', fresh).action, 'unknown');
  assert.equal(h.step.state, STATE.UNKNOWN);
});

test('resultado incerto bloqueia retry automático', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.schedule();
  const claim = h.step.beginExecution().claim;
  h.step.markUnknown('timeout no transporte', claim);
  assert.equal(h.step.state, STATE.UNKNOWN);
  assert.equal(h.step.retryAllowed, false);

  const accept = h.step.accept(cmd);
  assert.equal(accept.reason, 'already-pending',
    'UNKNOWN ainda ocupa o slot; precisa de reset explícito');

  h.step.reset();
  assert.equal(h.step.state, STATE.IDLE);
  assert.equal(h.step.pending, false);
  assert.equal(h.step.retryAllowed, true);
  assert.equal(h.step.accept(cmd).action, 'accepted');
});

test('execução também respeita o TTL', () => {
  const h = harness({ ttlMs: 100 });
  h.step.accept(cmd);
  h.step.schedule();
  h.advance(200);
  const r = h.step.beginExecution();
  assert.equal(r.reason, 'expired-before-execute');
  assert.equal(h.step.state, STATE.FAILED);
  assert.equal(h.step.retryAllowed, true, 'falha conhecida não bloqueia retry');
});

test('confirmação depois do prazo vira UNKNOWN, não EXECUTED', () => {
  const h = harness({ ttlMs: 100 });
  h.step.accept(cmd);
  h.step.schedule();
  const claim = h.step.beginExecution().claim;
  h.advance(200);
  const r = h.step.markExecuted(claim);
  assert.equal(r.action, 'unknown');
  assert.equal(r.reason, 'confirmed-after-ttl');
  assert.equal(h.step.state, STATE.UNKNOWN);
  assert.equal(h.step.retryAllowed, false);
});

test('beginExecution só é aceito uma vez por passo', () => {
  const h = harness();
  h.step.accept(cmd);
  h.step.schedule();
  assert.equal(h.step.beginExecution().ok, true);
  const second = h.step.beginExecution();
  assert.equal(second.ok, undefined);
  assert.equal(second.reason, STATE.EXECUTING);
});

test('reset limpa o passo e registra o estado anterior', () => {
  const h = harness();
  h.step.accept(cmd);
  const r = h.step.reset();
  assert.equal(r.previous, STATE.ACCEPTED);
  assert.equal(h.step.step, null);
  assert.equal(h.step.pending, false);
});

test('ordem inválida é recusada, não reinterpretada', () => {
  const h = harness();
  assert.equal(h.step.markExecuted(0).reason, STATE.IDLE);
  assert.equal(h.step.schedule().reason, STATE.IDLE);
  assert.equal(h.step.beginExecution().reason, STATE.IDLE);
  assert.equal(h.step.observe({ playerId: 7, position: TARGET }).reason, STATE.IDLE);

  h.step.accept(cmd);
  assert.equal(h.step.beginExecution().reason, STATE.ACCEPTED,
    'não executa sem agendar');
  h.step.schedule();
  assert.equal(h.step.markExecuted().reason, STATE.SCHEDULED,
    'não executa sem beginExecution');
  assert.equal(h.step.observe({ playerId: 7, position: TARGET }).reason,
    STATE.SCHEDULED, 'não observa sem executar');
});

test('ttl padrão é o declarado', () => {
  const step = new NativeStep();
  assert.equal(step.ttlMs, DEFAULT_TTL_MS);
  assert.equal(DEFAULT_TTL_MS, 2500);
});
