'use strict';

/**
 * `tools/can-act.cjs` — o diagnostico que responde "o bot pode agir agora?".
 *
 * Nao testa o jogo: testa o CONTRATO de saida. Ele precisa
 *   1. nunca despachar comando (read-only);
 *   2. recusar sem chave ou sem PID;
 *   3. reportar bloqueio com exit 3 quando o runtime nao esta' pronto.
 *
 * O caso real que originou o tool: 54 walks com o jogo no menu, porque
 * `position` e `playerName` estavam preenchidos e nenhum dos dois detecta o
 * menu. `runtimeReady` e' o unico discriminador.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'can-act.cjs');

function run(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
}

test('can-act recusa sem --pid', () => {
  const result = run([]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /faltou --pid/);
});

test('can-act nao despacha comando: so conecta e le', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  assert.ok(!/sendCommand\s*\(/.test(source),
    'can-act e diagnostico: nao pode emitir kind 9');
  assert.ok(!/sendCommand/.test(source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ')),
    'nem em codigo executavel');
});

test('can-act aponta o pre-requisito do Pokemon ativo', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  /* A medicao de 2026-11-12 mostrou que o handler de attack executa a acao
   * em [rt+0x2568]. Sem esse aviso, o tool mentiria "pode agir" com o pet
   * fora da ball. */
  assert.match(source, /poke?mon/i);
  assert.match(source, /0x2568|ownPokemon|type === 3/);
});

test('can-act separa a cura do player da cura do pet', () => {
  const source = fs.readFileSync(TOOL, 'utf8');
  /* Medido: a potion/hotkey cura o PLAYER; o pet depende de move de cura
   * (`talk mN`), e nem todo Pokemon tem um. Sem essa distincao o tool
   * reportaria "healer quebrado" quando o problema e' o time. */
  assert.match(source, /hp player/i);
  assert.match(source, /hp pet/i);
  assert.match(source, /talk mN|healMove/);
});

test('can-act sai com 3 (bloqueado) quando o canal nao existe', () => {
  const result = run(['--pid', '999999']);
  assert.notEqual(result.status, 0, 'pid inexistente nao pode passar');
  assert.match(result.stdout + result.stderr, /canal\s*:|sem chave|FALHOU/);
});
