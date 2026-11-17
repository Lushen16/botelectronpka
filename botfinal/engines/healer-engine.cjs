'use strict';

/**
 * HealerEngine (botfinal) — adaptador do motor de cura MEDIDO para o runtime
 * do nosso bot.
 *
 * POR QUE ESTE ARQUIVO MUDOU (2026-11-12)
 * ---------------------------------------
 * A versao anterior era um motor PARALELO, escrito a mao, que nao conhecia os
 * canais reais de cura. Ele so' olhava dois campos:
 *
 *   if (this.config.healPokemonName && this.config.returnPokemonName)  ...
 *   if (this.config.potionItemId)  ...  sendCommand('potion', id)
 *
 * Consequencia medida (execucao direta, HP 20%, config de producao):
 *
 *     tick -> {status:'no-action-needed'} x3
 *     comandos enviados: []
 *
 * Ou seja: com o bot em HEALING, o healer NUNCA emitia nada. Duas causas:
 *
 *   1. `healMoveSlot` — o canal que o Shiba usa de verdade (`talk mN`) — nao
 *      era lido. Nao existia caminho de cura por move.
 *   2. `potionItemId` nao existe na config real. O item do Shiba e' HOTKEY
 *      (`hoenn.potionHotkey: "Alt+f"`), e o formato e' texto, nao id.
 *
 * O `reconstruction/engines/healer-engine.cjs` ja' implementa os tres canais
 * medidos (potion/hotkey, medicine/hotkey, cura por `talk mN`, troca por
 * texto) e tem cobertura propria. Em vez de manter duas implementacoes
 * divergentes — a que rodava nao era a que tem teste — este modulo passa a ser
 * um ADAPTADOR fino sobre ele.
 *
 * O QUE ELE ADICIONA SOBRE O MOTOR BASE
 * -------------------------------------
 * Fallback por canal. O `potion` do Shiba e' tecla de action bar e a nossa DLL
 * recusa com `STATUS_NO_FOREGROUND` (5) quando o jogo nao esta' em foco — que
 * e' o caso normal em segundo plano. Antes, isso encerrava a tentativa e o bot
 * ficava sem cura nenhuma. Agora: um canal recusado por motivo de ambiente
 * (4/5/6) fica banido por BAN_MS e o MESMO tick tenta o proximo. Cura por move
 * (`talk mN`) e' nativa e funciona em segundo plano, entao o bot efetivamente
 * cura mesmo sem foco.
 */

const { createHealerEngine, rosterMatches, HEAL_RETRY_MS } = require('../../reconstruction/engines/healer-engine.cjs');

/** Quanto tempo um canal recusado por ambiente fica fora de uso. */
const BAN_MS = 30000;

/** Status do protocolo que significam "ambiente", nao "comando ruim":
 *  4 = identidade do Pokemon mudou (troca em andamento)
 *  5 = cliente/action bar aguardando cooldown OU sem foco (nosso caso)
 *  6 = hotkey/slot sem a acao esperada na action bar */
const ENV_STATUS = new Set([4, 5, 6]);

/** Canal de origem -> chave de banimento.
 *
 *  Só canais que dependem de FOCO entram aqui. `hotkey` e `action` viram
 *  tecla na action bar e a DLL recusa com STATUS_NO_FOREGROUND em segundo
 *  plano — banir faz sentido, e o mesmo tick cai no canal nativo.
 *
 *  `talk` (cura por move) e `switchPokemon` (texto no chat) são NATIVOS: não
 *  exigem foco. Um status de ambiente neles indicaria defeito real, então
 *  NÃO banimos — devolvemos erro para o chamador ver. Banir mascararia o
 *  problema por 30 s. */
const FOCUS_CHANNEL = Object.freeze({ hotkey: 'hotkey', action: 'hotkey' });

const HEALER_KEYS = ['enabled', 'healHpPercent', 'healPokemonName', 'healMoveSlot',
  'healResetSlot', 'returnPokemonName'];
const HOENN_KEYS = ['potionHpPercent', 'potionHotkey', 'potionActionBar', 'potionCooldownMs',
  'useMedicine', 'medicineHotkey', 'medicineActionBar'];

class HealerEngine {
  constructor(config = {}) {
    this.lastHealTime = 0;
    this.lastSent = null;
    this.banned = new Map();
    this.failures = [];
    this.updateConfig(config);
  }

  updateConfig(config = {}) {
    const next = config || {};
    const healerIn = next.healer || {};
    const hoennIn = next.hoenn || {};

    /* Valores CONFIGURADOS, imutaveis. O motor base recebe copias mutaveis
     * destes; o banimento zera a copia por 30 s, nunca o original. */
    const healerValues = {
      enabled: healerIn.enabled !== false,
      healHpPercent: Number(healerIn.healHpPercent ?? 50),
      healPokemonName: typeof healerIn.healPokemonName === 'string' ? healerIn.healPokemonName : '',
      /* Canal NATIVO de cura: `talk mN`, o unico que funciona sem foco. */
      healMoveSlot: Number.isInteger(healerIn.healMoveSlot) ? healerIn.healMoveSlot : 0,
      /* Reset usa o MESMO campo do motor base e ele só testa
       * `Number.isInteger`. Passar 0 faria ele emitir `talk m0` — comando
       * inexistente. Por isso 0 vira `undefined` (canal desligado). */
      healResetSlot: Number.isInteger(healerIn.healResetSlot) && healerIn.healResetSlot > 0
        ? healerIn.healResetSlot : undefined,
      returnPokemonName: typeof healerIn.returnPokemonName === 'string' ? healerIn.returnPokemonName : '',
    };
    const hoennValues = {
      potionHpPercent: Number(hoennIn.potionHpPercent ?? 0),
      potionHotkey: typeof hoennIn.potionHotkey === 'string' ? hoennIn.potionHotkey : '',
      potionActionBar: Number.isInteger(hoennIn.potionActionBar) ? hoennIn.potionActionBar : 0,
      potionCooldownMs: Number(hoennIn.potionCooldownMs ?? 1500),
      useMedicine: hoennIn.useMedicine === true,
      medicineHotkey: typeof hoennIn.medicineHotkey === 'string' ? hoennIn.medicineHotkey : '',
      medicineActionBar: Number.isInteger(hoennIn.medicineActionBar) ? hoennIn.medicineActionBar : 0,
    };

    /* Referencias estaveis: o motor base guarda `config.healer` e
     * `config.hoenn`. Recriar os objetos a cada update apagaria o estado de
     * cooldown interno dele. So' troca quando o valor realmente muda. */
    if (!this.healer || !sameValues(this.healer, healerValues, HEALER_KEYS)) {
      this.healer = { ...healerValues };
    }
    if (!this.hoenn || !sameValues(this.hoenn, hoennValues, HOENN_KEYS)) {
      this.hoenn = { ...hoennValues };
    }
    this.configured = { healer: { ...healerValues }, hoenn: { ...hoennValues } };
    this.config = { ...next, healer: this.healer, hoenn: this.hoenn };
    this.inner = createHealerEngine(this.config, {
      switchBeforeHeal: next.healer?.switchBeforeHeal === true,
      /* Filtro na FONTE: o motor base consulta isto antes de escolher o
       * canal. Sem ele, banir `hotkey` só zerava `potionHpPercent` e a
       * medicine (`medicineHotkey: "E"`) continuava sendo emitida — o
       * fallback caía no mesmo canal banido. */
      canSend: name => name !== 'hotkey' || !this.banned.has('hotkey'),
    });
  }

  /** Reaplica os canais banidos nas copias que o motor base le.
   *
   *  `hotkey` é o canal de potion E de medicine. O ban cobre os dois: o
   *  motor base tenta potion primeiro e, se `potionHpPercent` for zerado,
   *  cairia na medicine — que também é tecla e falharia igual. Por isso o
   *  filtro real está em `canSend` (na fonte); aqui só desligamos potion e
   *  medicine para o motor não montar o comando e o tick não gastar rodada.
   */
  applyBans() {
    const now = Date.now();
    for (const [key, until] of this.banned) if (now >= until) this.banned.delete(key);
    const hotkeyBanned = this.banned.has('hotkey');
    this.hoenn.potionHpPercent = hotkeyBanned ? 0 : this.configured.hoenn.potionHpPercent;
    this.hoenn.useMedicine = hotkeyBanned ? false : this.configured.hoenn.useMedicine;
  }

  /** Bane o canal do comando recusado. `name` é o nome do comando emitido
   *  ('hotkey' | 'action' | 'talk' | ...), NÃO o par [name, parameter].
   *
   *  Só canais com foco são baníveis — ver FOCUS_CHANNEL. Para os nativos,
   *  a recusa é defeito e sobe como erro em vez de virar silêncio de 30 s. */
  banFor(status, name) {
    if (!ENV_STATUS.has(status) && status !== 2) return false;
    const key = FOCUS_CHANNEL[name];
    if (!key) return false;
    const until = Date.now() + BAN_MS;
    this.banned.set(key, until);
    this.failures.push({ at: Date.now(), channel: key, status, bannedUntil: until });
    this.failures = this.failures.slice(-50);
    this.applyBans();
    return true;
  }

  /**
   * Um passo de cura.
   *
   * @param {object} telemetry snapshot normalizado
   * @param {object} transport CommandDispatcher (sendCommand(name, parameter, options))
   * @param {boolean} requested true quando o arbitro escolheu HEALING
   */
  async tick(telemetry, transport, requested = false) {
    if (!this.healer.enabled) return this.result('disabled', [], ['healer-disabled']);

    const now = Date.now();
    this.applyBans();

    /* Se o arbitro pediu cura por um limiar mais alto que o do healer
     * (`lowHpComboPercent` > `healHpPercent`), o motor base nao veria
     * necessidade e ficaria em silencio para sempre. Elevamos o limiar ate'
     * o HP atual para que a emergencia seja atendida de fato. */
    const playerHp = Number.isFinite(telemetry?.healthPercent) ? telemetry.healthPercent : 100;
    const petHp = Number.isFinite(telemetry?.ownPokemon?.healthPercent) ? telemetry.ownPokemon.healthPercent : Infinity;
    const worst = Math.min(playerHp, petHp);
    const configured = this.configured.healer.healHpPercent;
    this.healer.healHpPercent = requested && worst >= configured && worst < 100
      ? Math.min(100, worst + 1)
      : configured;

    const recorder = { events: [] };
    const sink = { command: (name, parameter, extra) => { recorder.events.push({ name, parameter, extra }); } };

    let step = this.inner.step(telemetry, sink, now);
    const attempts = [];

    /* Fallback por canal: no maximo 3 rodadas (potion -> medicine -> move). */
    for (let round = 0; round < 3 && step.emitted.length > 0; round++) {
      const [name, parameter] = step.emitted[0];
      const extra = recorder.events[0]?.extra;
      attempts.push({ name, parameter });

      if (!transport?.sendCommand) {
        return this.result('blocked', attempts, step.blocked, { reason: 'no-transport', name, parameter });
      }

      try {
        const ack = await transport.sendCommand(name, parameter, extra);
        const status = Number.isInteger(ack?.status) ? ack.status : 0;
        if (status !== 0) {
          /* `banFor` recebe o NOME do comando, não o par emitido. */
          if (!this.banFor(status, name)) {
            return this.result('error', attempts, step.blocked, { name, parameter, status });
          }
          recorder.events.length = 0;
          step = this.inner.step(telemetry, sink, now);
          continue;
        }
        this.lastSent = { name, parameter, at: now, status };
        this.lastHealTime = now;
        return this.result('heal', attempts, step.blocked, { name, parameter, status });
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : null;
        if (status !== null && this.banFor(status, name)) {
          recorder.events.length = 0;
          step = this.inner.step(telemetry, sink, now);
          continue;
        }
        return this.result('error', attempts, step.blocked, {
          name, parameter, status, error: error.message, code: error.code ?? null,
        });
      }
    }

    if (attempts.length > 0) {
      return this.result('blocked', attempts, step.blocked, this.failures.at(-1) ?? null);
    }
    return this.result(step.action === 'idle' ? 'idle' : 'idle', [], step.blocked ?? []);
  }

  result(status, attempts, blocked, detail = null) {
    return {
      status,
      action: status === 'heal' ? 'heal' : 'idle',
      attempts,
      blocked: [...new Set(blocked || [])],
      bans: [...this.banned.keys()],
      detail,
      lastHealAt: this.lastHealTime || null,
    };
  }

  get state() {
    return {
      enabled: this.healer.enabled,
      healHpPercent: this.healer.healHpPercent,
      healMoveSlot: this.healer.healMoveSlot,
      potionChannel: this.hoenn.potionHotkey || (this.hoenn.potionActionBar || null),
      banned: [...this.banned.keys()],
      lastSent: this.lastSent,
      failures: this.failures.slice(-10),
    };
  }
}

function sameValues(a, b, keys) {
  return keys.every(key => a[key] === b[key]);
}

module.exports = { HealerEngine, rosterMatches, HEAL_RETRY_MS, ENV_STATUS, BAN_MS, FOCUS_CHANNEL };
