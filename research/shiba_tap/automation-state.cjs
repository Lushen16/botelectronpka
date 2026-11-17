'use strict';

/**
 * Modelo do frame kind 6 (automation) do canal do fornecedor.
 *
 * Este modulo NAO fala com o jogo e NAO pertence ao bot. Ele so traduz o
 * payload que o tap capturou num estado normalizado, com validacao de enum e
 * arbitragem de dono do movimento. O agente do bot consome daqui.
 *
 * Fonte de verdade dos campos e enums: research/shiba_tap/KIND6_MAP.md
 * (28.830 amostras reais, 80 min, Shiba v3.3.1).
 *
 * Uso:
 *   const { parse } = require('./automation-state.cjs');
 *   const state = parse(payloadBufferOuString);
 *   state.movementOwner  // null | 'target'
 *   state.phase          // { core, lure, modules }
 */

/* Enums observados. Valor fora daqui significa build diferente: o parser
 * marca `unknown` em vez de inventar comportamento. */
const CORE_PHASE = Object.freeze(['idle', 'combat']);
const LURE_MODE = Object.freeze(['off', 'dynamic']);
const LURE_PHASE = Object.freeze(['off', 'travel', 'arc', 'stationary', 'wait', 'observe']);
const EVENT_KIND = Object.freeze(['info', 'warning', 'error']);
const MODULES = Object.freeze(['target', 'walker', 'healer', 'looting', 'hoenn', 'alerts']);

/* Transicoes de lure que a captura realmente produziu (401 MB, 2.809
 * transicoes). Serve para detectar fase desconhecida em build novo, nao para
 * bloquear: transicao fora da lista e' registrada como `unusual`, nao erro. */
const LURE_TRANSITIONS = Object.freeze({
  'off>travel': 902, 'travel>off': 936,
  'travel>arc': 270, 'arc>travel': 297,
  'travel>stationary': 149, 'stationary>travel': 156,
  'off>arc': 35, 'wait>travel': 17, 'travel>wait': 16,
  'off>stationary': 12, 'arc>off': 6, 'stationary>off': 5,
  'wait>off': 2, 'arc>observe': 2,
});

function asObject(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value.replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  }
  if (Buffer.isBuffer(value)) {
    try {
      return JSON.parse(value.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value;
  return null;
}

function pickCoord(value) {
  if (!value || typeof value !== 'object') return null;
  const { x, y, z } = value;
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

/** Estado normalizado a partir do payload cru. */
function parse(raw) {
  const data = asObject(raw);
  if (!data) return { ok: false, error: 'payload nao e JSON de objeto' };

  const issues = [];
  const unknown = (field, value, allowed) => {
    if (value === undefined || value === null || value === '') return value ?? null;
    if (allowed.includes(value)) return value;
    issues.push({ field, value, allowed });
    return value;
  };

  const core = data.core || {};
  const luring = data.luring || {};
  const walkerTimer = data.walkerTimer || {};

  const modules = Array.isArray(data.modules) ? data.modules.filter(Boolean) : [];
  for (const name of modules) {
    if (!MODULES.includes(name)) issues.push({ field: 'modules', value: name, allowed: MODULES });
  }

  const events = Array.isArray(data.events) ? data.events.map(event => ({
    id: Number.isFinite(event?.id) ? event.id : null,
    kind: EVENT_KIND.includes(event?.kind) ? event.kind : (event?.kind ?? null),
    message: typeof event?.message === 'string' ? event.message : '',
  })) : [];
  for (const event of events) {
    if (event.kind && !EVENT_KIND.includes(event.kind)) {
      issues.push({ field: 'events[].kind', value: event.kind, allowed: EVENT_KIND });
    }
  }

  const count = Number.isFinite(luring.count) ? luring.count : 0;
  const minCount = Number.isFinite(luring.minCount) ? luring.minCount : 0;

  return {
    ok: true,
    protocol: Number.isFinite(data.protocol) ? data.protocol : null,
    tick: Number.isFinite(data.tick) ? data.tick : null,
    pid: Number.isFinite(data.pid) ? data.pid : null,
    authorized: data.authorized === true,
    busy: data.busy === true,
    error: typeof data.error === 'string' ? data.error : '',

    /* Dono do movimento: e' isto que impede target e walker de brigarem. */
    movementOwner: core.movementOwner ?? null,
    phase: {
      core: unknown('core.phase', core.phase, CORE_PHASE),
      lure: unknown('luring.phase', luring.phase, LURE_PHASE),
      ui: typeof data.phase === 'string' ? data.phase : '',
      modules: {
        target: typeof data.phases?.target === 'string' ? data.phases.target : '',
        walker: typeof data.phases?.walker === 'string' ? data.phases.walker : '',
      },
    },
    lure: {
      mode: unknown('luring.mode', luring.mode, LURE_MODE),
      phase: unknown('luring.phase', luring.phase, LURE_PHASE),
      holding: luring.holding === true,
      count,
      minCount,
      gateOpen: minCount > 0 ? count >= minCount : null,
      actorId: Number.isFinite(luring.actorId) ? luring.actorId : null,
      target: pickCoord(luring.target),
    },
    walker: {
      index: Number.isFinite(data.walkerIndex) ? data.walkerIndex : null,
      timerPhase: typeof walkerTimer.phase === 'string' ? walkerTimer.phase : '',
      remainingMs: Number.isFinite(walkerTimer.remainingMs) ? walkerTimer.remainingMs : 0,
    },
    modules,
    events,
    issues,
  };
}

/**
 * Quem pode mover o personagem neste tick.
 *
 * Regra derivada da captura: `core.movementOwner` vem `null` quando ninguem
 * esta' dirigindo e `"target"` durante combate. O walker so' anda quando o
 * dono esta' livre. Devolver isso explicitamente evita que dois motores
 * mandem passo no mesmo tick.
 */
function movementPermission(state) {
  if (!state || !state.ok) return { allowed: false, reason: 'estado invalido' };
  if (state.movementOwner) {
    return { allowed: false, reason: 'dono do movimento: ' + state.movementOwner };
  }
  if (state.phase.core === 'combat') {
    return { allowed: false, reason: 'em combate' };
  }
  if (state.lure.phase && state.lure.phase !== 'off') {
    return { allowed: false, reason: 'lure ativa: ' + state.lure.phase };
  }
  return { allowed: true, reason: 'livre' };
}

/**
 * Detecta travamento: mesma fase por mais de `maxMs`. A captura mostra
 * transicoes a cada ~166 ms, entao 10 s parado na mesma fase e' anormal
 * (o fornecedor publica 6 amostras/s).
 */
function detectStall(previous, current, elapsedMs, maxMs = 10000) {
  if (!current?.ok) return null;
  if (!previous?.ok) return null;
  const same = previous.lure.phase === current.lure.phase
    && previous.phase.core === current.phase.core
    && previous.walker.index === current.walker.index
    && previous.tick === current.tick;
  if (!same) return null;
  if (elapsedMs < maxMs) return null;
  return {
    kind: 'stall',
    lurePhase: current.lure.phase,
    corePhase: current.phase.core,
    walkerIndex: current.walker.index,
    elapsedMs,
  };
}

/** A transicao de lure e' uma das que a captura produziu? */
function isCommonLureTransition(from, to) {
  if (!from || !to) return false;
  return Object.hasOwn(LURE_TRANSITIONS, from + '>' + to);
}

module.exports = {
  parse, movementPermission, detectStall, isCommonLureTransition,
  CORE_PHASE, LURE_MODE, LURE_PHASE, EVENT_KIND, MODULES, LURE_TRANSITIONS,
};
