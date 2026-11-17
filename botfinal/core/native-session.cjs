'use strict';

/**
 * Sessao nativa: transforma os quadros `state` e `telemetry` do canal em um
 * snapshot no formato que os motores do botfinal consomem.
 *
 * Separacao de responsabilidades:
 *   - Transport (reconstruction/transport.cjs) faz I/O e handshake.
 *   - decodeState/decodeTelemetry validam os bytes.
 *   - Este modulo so junta os dois e controla frescor (ageMs), sem inventar
 *     campos: o que o cliente nao publicou fica ausente, nao vira zero.
 */

const { decodeState } = require('../../reconstruction/protocol.cjs');
const { decodeTelemetry } = require('../../reconstruction/telemetry.cjs');

const MAX_AGE_MS = 1500;

function healthFromState(state) {
  if (!state) return undefined;
  const value = Number(state.healthPercent);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function normalizeCreature(row) {
  if (!row || typeof row !== 'object') return null;
  const health = Number(row.healthPercent);
  if (!Number.isInteger(row.id) || row.id <= 0) return null;
  if (typeof row.name !== 'string' || !row.name.trim()) return null;
  if (!row.pos || ![row.pos.x, row.pos.y, row.pos.z].every(Number.isInteger)) return null;
  if (!Number.isFinite(health) || health < 0 || health > 100) return null;
  // O cliente publica `type`; os motores usam `creatureType`.
  const kind = Number.isInteger(row.creatureType) ? row.creatureType : row.type;
  return { ...row, creatureType: kind, healthPercent: health };
}

function normalizeTelemetry(telemetry, state) {
  if (!telemetry) return null;
  const creatures = (Array.isArray(telemetry.creatures) ? telemetry.creatures : [])
    .map(normalizeCreature).filter(Boolean);
  const own = creatures.filter(row => row.creatureType === 3 && row.healthPercent > 0);
  const ownPokemon = own.length === 1 ? own[0] : null;
  return {
    ...telemetry,
    creatures,
    ownPokemon,
    healthPercent: healthFromState(state),
    playerName: typeof telemetry.playerName === 'string' ? telemetry.playerName : '',
  };
}

class NativeSession {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
    this.pid = options.pid ?? null;
    this.state = null;
    this.telemetry = null;
    this.stateAt = null;
    this.telemetryAt = null;
    this.error = null;
    this.closed = false;
  }

  attach(transport) {
    transport.on('state', payload => this.onState(payload));
    transport.on('telemetry', payload => this.onTelemetry(payload));
    transport.on('error', error => { this.error = error.message; });
    transport.on('close', () => { this.closed = true; });
    return this;
  }

  onState(payload) {
    try {
      // reconstruction/transport.cjs ja decodifica e emite o objeto; um Buffer
      // cru so aparece quando a fonte e outra (ex.: replay de captura).
      this.state = Buffer.isBuffer(payload)
        ? decodeState(payload)
        : (payload && typeof payload === 'object' ? payload : null);
      if (!this.state) throw Error('Quadro de estado invalido.');
      this.stateAt = this.now();
      this.error = null;
    } catch (error) {
      this.error = error.message;
    }
  }

  onTelemetry(payload) {
    try {
      this.telemetry = Buffer.isBuffer(payload)
        ? decodeTelemetry(payload)
        : (payload && typeof payload === 'object' ? payload : null);
      if (!this.telemetry) throw Error('Quadro de telemetria invalido.');
      this.telemetryAt = this.now();
      this.error = null;
    } catch (error) {
      this.error = error.message;
    }
  }

  /** Snapshot no formato dos motores, ou null quando nao ha dados frescos. */
  snapshot() {
    if (!this.state || !this.telemetry) return null;
    const stamp = this.now();
    const ageMs = Math.max(stamp - this.stateAt, stamp - this.telemetryAt);
    const telemetry = normalizeTelemetry(this.telemetry, this.state);
    if (!telemetry) return null;
    /* runtimeReady: undefined quando a DLL e' antiga (nao publica o campo).
     * Nesse caso NAO bloqueamos — bloquear por ausencia de dado tornaria
     * toda DLL anterior inutil. O consumidor que quiser exigir o sinal
     * testa `=== false`. */
    const runtimeReady = telemetry.runtimeReady === false ? false
      : telemetry.runtimeReady === true ? true : undefined;
    return {
      generatedAt: new Date(stamp).toISOString(),
      pid: this.pid,
      online: !this.closed && !this.error && this.state.online === true,
      stale: !Number.isFinite(ageMs) || ageMs < 0 || ageMs > this.maxAgeMs,
      ageMs,
      error: this.error,
      authExpired: this.state.authExpired === true,
      healthPercent: telemetry.healthPercent,
      runtimeReady,
      telemetry,
    };
  }

  /** True quando state/telemetry sao recentes o bastante para agir. */
  usable() {
    const snap = this.snapshot();
    return Boolean(snap && snap.online && !snap.stale);
  }

  reset() {
    this.state = null;
    this.telemetry = null;
    this.stateAt = null;
    this.telemetryAt = null;
    this.error = null;
    this.closed = false;
  }
}

module.exports = { NativeSession, normalizeTelemetry, normalizeCreature, healthFromState, MAX_AGE_MS };
