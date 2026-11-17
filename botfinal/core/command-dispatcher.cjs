'use strict';

/**
 * Despacho de comandos pelo canal nativo.
 *
 * Traduz o vocabulario dos motores (attack/talk/combo/walk/useWith) para o
 * protocolo real, validando frescor e PID antes de cada envio. Nada aqui
 * inventa coordenadas: ataques usam o id da criatura, como o cliente espera.
 */

const { COMMANDS } = require('../../reconstruction/protocol.cjs');

// Nomes que os motores usam e que o protocolo conhece sob outro rótulo.
const ALIASES = Object.freeze({ skill: 'talk', spell: 'talk' });

class CommandDispatcher {
  constructor(options = {}) {
    this.transport = options.transport;
    this.session = options.session;
    this.now = options.now || Date.now;
    this.lastDispatchAt = -Infinity;
    this.maxAgeMs = options.maxAgeMs ?? 1500;
    this.log = [];
    this.onDispatch = options.onDispatch || (() => {});
  }

  /** Snapshot fresco ou erro: nunca despacha com dado velho. */
  requireFresh() {
    const snap = this.session?.snapshot();
    if (!snap) throw Object.assign(Error('Sem snapshot do canal nativo.'), { code: 'NO_SNAPSHOT' });
    if (snap.error) throw Object.assign(Error(snap.error), { code: 'SESSION_ERROR' });
    if (!snap.online) throw Object.assign(Error('Cliente offline.'), { code: 'CLIENT_OFFLINE' });
    if (snap.stale) throw Object.assign(Error('Snapshot expirado; nao enviado.'), { code: 'STALE_SNAPSHOT' });
    return snap;
  }

  resolveName(name) {
    const key = ALIASES[name] || name;
    if (!Object.hasOwn(COMMANDS, key)) throw Object.assign(
      Error('Comando sem suporte no protocolo: ' + name), { code: 'UNSUPPORTED_COMMAND' });
    return key;
  }

  /**
   * Envia um comando ja no formato dos motores.
   * `parameter` segue o contrato de encodeCommand por comando.
   *
   * ESTAGIOS — nao colapsar em um so' booleano:
   *   enfileirado      : este metodo foi chamado
   *   escrito          : o socket aceitou os bytes (Transport.write)
   *   recebido         : o servidor respondeu ACK (kind 10)
   *   aceito           : ACK.status === 0
   *   executado        : nao observavel pelo protocolo
   *   efeito observado : so' com `verify` (leitura depois do envio)
   *
   * Por isso `inputAccepted` reflete APENAS o ACK. O efeito fica em
   * `effectVerified` e nunca e' inferido de status 0.
   */
  async send(name, parameter = 0, options = {}) {
    const command = this.resolveName(name);
    const snap = this.requireFresh();
    const before = options.verify ? this.positionOf(snap) : null;

    const result = await this.transport.sendCommand(command, parameter, options);
    if (!result || result.status !== 0) {
      throw Object.assign(
        Error('Runtime rejeitou ' + command + ': status ' + (result?.status ?? 'desconhecido')),
        { code: 'COMMAND_REJECTED', status: result?.status ?? null, command });
    }
    this.lastDispatchAt = this.now();
    const record = {
      at: new Date(this.lastDispatchAt).toISOString(),
      pid: snap.pid, command, parameter,
      delivery: {
        enqueued: true,
        written: true,
        received: true,          // ACK recebido
        accepted: true,          // ACK.status === 0
      },
      inputAccepted: true,       // sinonimo de accepted, NAO de executed
      effectVerified: false,
    };

    if (options.verify) {
      const observed = await this.waitForEffect(before, options.verify, options.verifyTimeoutMs);
      record.effectVerified = observed.changed;
      record.effect = observed;
    }

    this.log.push(record);
    this.log = this.log.slice(-200);
    this.onDispatch(record);
    return record;
  }

  /** Posicao do jogador no snapshot, ou null. */
  positionOf(snap) {
    const pos = snap?.telemetry?.position;
    if (!pos || ![pos.x, pos.y, pos.z].every(Number.isInteger)) return null;
    return { x: pos.x, y: pos.y, z: pos.z };
  }

  /**
   * Espera o snapshot mudar de posicao. Este e' o unico criterio de EFEITO
   * que temos hoje: ACK prova recebimento, nao movimento.
   */
  async waitForEffect(before, kind, timeoutMs = 1500) {
    if (kind !== 'position') {
      return { changed: false, reason: 'verificacao nao implementada: ' + kind };
    }
    if (!before) return { changed: false, reason: 'posicao inicial ausente' };
    const deadline = this.now() + timeoutMs;
    let last = before;
    while (this.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 40));
      const snap = this.session?.snapshot();
      const now = this.positionOf(snap ?? {});
      if (!now) continue;
      last = now;
      if (now.x !== before.x || now.y !== before.y || now.z !== before.z) {
        return { changed: true, before, after: now,
          delta: { x: now.x - before.x, y: now.y - before.y, z: now.z - before.z },
          elapsedMs: timeoutMs - (deadline - this.now()) };
      }
    }
    return { changed: false, reason: 'posicao nao mudou dentro de ' + timeoutMs + 'ms',
      before, after: last, elapsedMs: timeoutMs };
  }

  /** Compatibilidade com os motores que chamam sendCommand(name, parameter). */
  sendCommand(name, parameter = 0, options = {}) {
    return this.send(name, parameter, options);
  }

  /** Ataque por id de criatura, como o runtime nativo espera. */
  attack(targetId) {
    if (!Number.isInteger(targetId) || targetId <= 0 || targetId > 0xffffffff) {
      return Promise.reject(Object.assign(Error('targetId invalido.'), { code: 'BAD_TARGET' }));
    }
    return this.send('attack', targetId);
  }

  /** Skill por nome de spellword (m1..mN). */
  skill(spellword, options) {
    return this.send('talk', String(spellword), options);
  }

  /** Andar em uma direcao cardinal (0..7). */
  walk(direction) {
    if (!Number.isInteger(direction) || direction < 0 || direction > 7) {
      return Promise.reject(Object.assign(Error('direcao invalida.'), { code: 'BAD_DIRECTION' }));
    }
    return this.send('walk', direction);
  }

  /** Hotkey por nome de tecla configurada no cliente. */
  hotkey(key, options) {
    return this.send('hotkey', String(key), options);
  }

  /** Captura: item aplicado sobre um id de corpo numa posicao. */
  capture({ itemId, targetId, stack = 1, pos }) {
    if (!pos || !Number.isInteger(pos.x) || !Number.isInteger(pos.y) || !Number.isInteger(pos.z)) {
      return Promise.reject(Object.assign(Error('posicao de captura invalida.'), { code: 'BAD_POSITION' }));
    }
    return this.send('useWith', { itemId, targetId, stack, x: pos.x, y: pos.y, z: pos.z });
  }
}

module.exports = { CommandDispatcher, ALIASES };
