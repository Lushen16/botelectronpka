'use strict';

// Contratos da auditoria ao vivo pelo canal nativo. Nenhum Electron aqui: as
// funcoes de veredito sao puras e o executor roda contra um runtime falso.
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  summarizeKill, summarizeHeal, summarizeRevive, summarizeNotification,
  diffCreatures, creatureHealth, buildConfig, isHealCommand, runLiveChannelAudit,
  KILL_HOTKEY, REVIVE_HOTKEY,
} = require('../reconstruction/app/live-channel-audit.cjs');

const sample = (overrides = {}) => ({
  at: new Date().toISOString(), status: 'combat', comboIndex: 0, reason: null, blocked: [],
  healthPercent: 100, position: { x: 1, y: 1, z: 7 }, creatures: [], emitted: [], ...overrides,
});

test('diffCreatures separa dano, desaparecimento e surgimento', () => {
  const before = new Map([[1, 100], [2, 80], [3, 50]]);
  const after = new Map([[1, 90], [3, 50], [4, 100]]);
  const diff = diffCreatures(before, after);
  assert.deepEqual(diff.damaged, [{ id: 1, from: 100, to: 90 }]);
  assert.deepEqual(diff.gone, [{ id: 2, lastHp: 80 }]);
  assert.deepEqual(diff.appeared, [4]);
});

test('creatureHealth so aceita id inteiro', () => {
  const map = creatureHealth({ creatures: [{ id: 7, healthPercent: 40 }, { id: '8', healthPercent: 1 }, null] });
  assert.deepEqual([...map.entries()], [[7, 40]]);
});

test('kill passa quando o HP da criatura ATACADA cai', () => {
  const result = summarizeKill([
    sample({ creatures: [{ id: 11, hp: 100 }], emitted: [['attack', 11]] }),
    sample({ creatures: [{ id: 11, hp: 72 }] }),
  ]);
  assert.equal(result.status, 'damaged');
  assert.equal(result.passed, true);
  assert.deepEqual(result.attacked, [11]);
});

test('kill passa quando a criatura atacada desaparece', () => {
  const result = summarizeKill([
    sample({ creatures: [{ id: 11, hp: 40 }], emitted: [['attack', 11]] }),
    sample({ creatures: [] }),
  ]);
  assert.equal(result.status, 'killed');
  assert.equal(result.passed, true);
  assert.deepEqual(result.gone.map(entry => entry.id), [11]);
});

test('dano de terceiro nao prova o nosso ataque', () => {
  const result = summarizeKill([
    sample({ creatures: [{ id: 11, hp: 100 }, { id: 12, hp: 100 }], emitted: [['attack', 11]] }),
    sample({ creatures: [{ id: 11, hp: 100 }, { id: 12, hp: 60 }] }),
  ]);
  assert.equal(result.status, 'attack-without-effect');
  assert.equal(result.passed, false);
  assert.deepEqual(result.damaged.filter(entry => entry.attacked), []);
});

test('kill sem nenhum attack e declarado, nao aprovado', () => {
  const result = summarizeKill([sample({ creatures: [{ id: 11, hp: 100 }] })]);
  assert.equal(result.status, 'no-attack');
  assert.equal(result.passed, false);
});

test('cura passa quando o HP sobe depois do comando', () => {
  const result = summarizeHeal([
    sample({ healthPercent: 100, emitted: [['hotkey', 'F1']] }),
    sample({ healthPercent: 100 }),
    sample({ healthPercent: 100 }),
  ]);
  assert.equal(result.status, 'command-without-recovery');
  assert.equal(result.passed, false);

  const recovered = summarizeHeal([
    sample({ healthPercent: 55, emitted: [['hotkey', 'F1']] }),
    sample({ healthPercent: 70 }),
  ]);
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.passed, true);
  assert.deepEqual(recovered.recovery, { at: recovered.recovery.at, from: 55, to: 70, commandAt: recovered.commands[0].at });
});

test('cura sem comando nenhum nao inventa resultado', () => {
  const result = summarizeHeal([sample({ healthPercent: 90 }), sample({ healthPercent: 95 })]);
  assert.equal(result.status, 'no-command');
  assert.equal(result.passed, false);
});

test('isHealCommand reconhece skill, potion, hotkey e action bar', () => {
  assert.equal(isHealCommand('talk', 'm1'), true);
  assert.equal(isHealCommand('talk', 'spell'), false);
  assert.equal(isHealCommand('potion', 1), true);
  assert.equal(isHealCommand('hotkey', 'Alt+f'), true);
  assert.equal(isHealCommand('attack', 11), false);
});

test('revive passa so com a hotkey de revive emitida apos combo', () => {
  const sent = summarizeRevive([
    sample({ status: 'combo', comboIndex: 1, emitted: [['hotkey', KILL_HOTKEY]] }),
    sample({ status: 'revive', comboIndex: 1, emitted: [['hotkey', REVIVE_HOTKEY]] }),
  ]);
  assert.equal(sent.status, 'revive-sent');
  assert.equal(sent.passed, true);

  const noRevive = summarizeRevive([
    sample({ status: 'combo', comboIndex: 1, emitted: [['hotkey', KILL_HOTKEY]] }),
    sample({ status: 'combat', comboIndex: 1 }),
  ]);
  assert.equal(noRevive.status, 'combo-without-revive');
  assert.equal(noRevive.passed, false);

  const noCombo = summarizeRevive([sample({ emitted: [['attack', 5]] })]);
  assert.equal(noCombo.status, 'no-combo');
  assert.equal(noCombo.passed, false);
});

test('combo e reconhecido pela hotkey de ataque mesmo sem status combo', () => {
  // Medido ao vivo: o runtime nunca publicou status `combo`, o combo aparecia so'
  // como as hotkeys emitidas. Sem isso a fase inteira virava `no-combo`.
  const semStatus = summarizeRevive([
    sample({ status: 'combat', emitted: [['hotkey', KILL_HOTKEY]] }),
    sample({ status: 'combat' }),
  ]);
  assert.equal(semStatus.comboDone, true);
  assert.equal(semStatus.status, 'combo-without-revive');

  const comRevive = summarizeRevive([
    sample({ status: 'combat', emitted: [['hotkey', KILL_HOTKEY]] }),
    sample({ status: 'combat', emitted: [['hotkey', REVIVE_HOTKEY]] }),
  ]);
  assert.equal(comRevive.status, 'revive-sent');
  assert.equal(comRevive.sent.length, 1);
});

test('notificacao so passa com evento recebido no renderer', () => {
  assert.equal(summarizeNotification([]).passed, false);
  assert.equal(summarizeNotification(undefined).status, 'not-notified');
  assert.equal(summarizeNotification(['hunt_pokemon.mp3']).passed, true);
});

test('buildConfig mescla sem mutar a base e preserva arrays', () => {
  const base = { target: { combo: { enabled: false, sequenceText: 'm5' } }, alerts: { rules: [{ name: 'a' }] } };
  const config = buildConfig(base, { target: { combo: { enabled: true } } });
  assert.equal(config.target.combo.enabled, true);
  assert.equal(config.target.combo.sequenceText, 'm5');
  assert.deepEqual(config.alerts.rules, [{ name: 'a' }]);
  assert.equal(base.target.combo.enabled, false);
});

test('sem sessao no canal a auditoria para no connect e declara o bloqueio', async () => {
  const calls = [];
  const runtime = {
    sessions: [],
    state: { status: 'idle' },
    last: null,
    async connect(pid, config) { calls.push(['connect', pid, Boolean(config)]); return {}; },
    async setModules(module, enabled) { calls.push(['setModules', module, enabled]); return {}; },
    async pause() { calls.push(['pause']); return {}; },
  };
  const window = {
    isDestroyed: () => false,
    show() {},
    hide() {},
    webContents: { executeJavaScript: async () => true },
  };
  const report = await runLiveChannelAudit(window, runtime, { pid: 1712 });
  assert.equal(report.ok, false);
  assert.equal(report.blocked, 'Canal sem sessao valida: nada mais pode ser medido.');
  const connect = report.checks.find(check => check.name === 'channel.connect');
  assert.equal(connect.passed, false);
  assert.equal(report.failed.includes('channel.connect'), true);
  assert.deepEqual(calls[0], ['connect', 1712, true]);
  assert.deepEqual(calls.pop(), ['setModules', 'all', false]);
});
