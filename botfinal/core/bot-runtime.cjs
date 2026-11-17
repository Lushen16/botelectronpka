'use strict';

/**
 * Runtime do botfinal sobre o canal nativo.
 *
 * Um tick faz: snapshot fresco -> arbitro escolhe o estado -> motor do estado
 * despacha pelo CommandDispatcher. Nunca age com snapshot velho, nunca envia
 * dois comandos no mesmo tick, e nao inventa telemetria quando o canal cala.
 */

const { EventEmitter } = require('node:events');
const { StateArbiter, BOT_STATES } = require('./state-arbiter.cjs');
const { CommandDispatcher } = require('./command-dispatcher.cjs');

const DEFAULT_TICK_MS = 100;

class BotRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.session = options.session;
    this.transport = options.transport;
    this.config = options.config || {};
    this.combat = options.combat;
    this.walker = options.walker;
    this.healer = options.healer;
    this.arbiter = options.arbiter || new StateArbiter(this.config);
    this.now = options.now || Date.now;
    this.dispatcher = options.dispatcher || new CommandDispatcher({
      transport: this.transport, session: this.session, now: this.now,
    });
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.started = false;
    this.timer = null;
    this.busy = false;
    this.paused = false;
    this.last = null;
    this.ticks = 0;
    this.lastCommandAt = -Infinity;
  }

  get state() {
    return {
      started: this.started,
      paused: this.paused,
      ticks: this.ticks,
      state: this.arbiter.currentState,
      last: this.last,
      lastCommandAt: Number.isFinite(this.lastCommandAt)
        ? new Date(this.lastCommandAt).toISOString() : null,
    };
  }

  updateConfig(config = {}) {
    this.config = config;
    this.arbiter.updateConfig(config);
    this.combat?.updateConfig?.(config);
    this.walker?.updateConfig?.(config);
    this.healer?.updateConfig?.(config);
  }

  start() {
    if (this.started) return this.state;
    this.started = true;
    this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
    this.timer.unref?.();
    this.emit('change', this.state);
    return this.state;
  }

  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit('change', this.state);
    return this.state;
  }

  async pause() {
    this.paused = true;
    this.emit('change', this.state);
    return this.state;
  }

  async resume() {
    this.paused = false;
    this.emit('change', this.state);
    return this.state;
  }

  /** Um passo: decide e despacha no maximo um comando. */
  async tick() {
    if (!this.started || this.paused || this.busy) return null;
    this.busy = true;
    const epoch = this.ticks;
    try {
      this.ticks += 1;
      const snapshot = this.session?.snapshot();
      if (!snapshot) {
        this.last = { status: 'waiting', reason: 'no-snapshot', inputAccepted: false };
        return this.last;
      }
      if (snapshot.error || !snapshot.online || snapshot.stale) {
        this.last = {
          status: 'blocked',
          reason: snapshot.error || (!snapshot.online ? 'client-offline' : 'stale-snapshot'),
          inputAccepted: false,
        };
        this.emit('change', this.state);
        return this.last;
      }
      /* RUNTIME GATE: o personagem esta' no mundo?
       *
       * MEDIDO (2026-11-12): 54 walks foram despachados com o jogo no MENU.
       * `Game::walk` roda, retorna sucesso, e nao move ninguem porque
       * [rt+0x2528] = 0. Nenhum sinal que ja' existia detecta isso:
       * `online` le' HP (100 no menu), `position` vem do vtable-scan (acha a
       * instancia mesmo sem mapa). O gate e' o unico discriminador.
       *
       * `undefined` (DLL antiga que nao publica o campo) NAO bloqueia:
       * bloquear por ausencia de dado inutilizaria toda DLL anterior. */
      if (snapshot.runtimeReady === false) {
        this.last = {
          status: 'blocked',
          reason: 'runtime-not-ready',
          inputAccepted: false,
        };
        this.emit('change', this.state);
        return this.last;
      }

      const telemetry = snapshot.telemetry;
      const candidates = this.combat?.filterValidTargets?.(telemetry) ?? [];
      const isLureReady = this.combat?.isLureConditionMet?.(telemetry, candidates) ?? candidates.length > 0;
      // `isFormationHeld` e' o gatilho real do combate (medido no Shiba:
      // holding=true -> parado em 99,9%). `isLureReady` (contagem) e' apenas
      // pre-requisito de densidade e NAO pode disparar sozinho.
      //
      // Fallback: quando o engine NAO implementa `isFormationHeld` (mocks ou
      // substitutos), usamos `isLureReady` — senao qualquer engine externo
      // ficaria incapaz de entrar em combate. O `CombatEngine` real sempre
      // implementa o metodo, entao em producao o criterio medido vale.
      const isFormationHeld = typeof this.combat?.isFormationHeld === 'function'
        ? this.combat.isFormationHeld(telemetry, candidates)
        : isLureReady;
      // Reposicionamento (Dynamic Lure) tem precedencia sobre o combate.
      // Hoje o nosso engine devolve false (nao implementamos Dynamic Lure);
      // a precedencia existe para quando o estado vier de um adaptador.
      const isRepositioning = this.combat?.isRepositioning?.(telemetry, candidates) ?? false;
      const botState = this.arbiter.evaluate(telemetry, {
        inCombat: this.combat?.targetId != null,
        validTargets: candidates,
        isLureReady,
        isFormationHeld,
        isRepositioning,
        isRevivePending: false,
      });

      const result = await this.runState(botState, telemetry, candidates);
      // Se outro tick entrou nesse meio tempo, o resultado ainda e valido,
      // mas nao sobrescreve um despacho mais novo.
      if (result) this.last = result;
      this.emit('change', this.state);
      return result;
    } catch (error) {
      this.last = {
        status: 'error',
        reason: error.message,
        code: error.code || null,
        inputAccepted: false,
        effectVerified: false,
      };
      this.emit('change', this.state);
      return this.last;
    } finally {
      this.busy = false;
      void epoch;
    }
  }

  async runState(botState, telemetry, candidates) {
    if (botState === BOT_STATES.COMBAT) {
      const target = this.combat.selectTarget(telemetry, candidates);
      if (!target) return { status: 'combat', action: 'none', inputAccepted: false };
      const result = await this.combat.tick(telemetry, this.dispatcher);
      this.lastCommandAt = this.dispatcher.lastDispatchAt;
      if (result.status === 'error') {
        return { status: 'error', reason: result.error, code: result.code || null,
          inputAccepted: false, effectVerified: false };
      }
      return { status: 'combat', ...result };
    }
    if (botState === BOT_STATES.HEALING) {
      const result = await this.healer.tick(telemetry, this.dispatcher, true);
      this.lastCommandAt = this.dispatcher.lastDispatchAt;
      return { status: 'healing', ...result };
    }
    if (botState === BOT_STATES.WALKING) {
      const result = await this.walker.tick(telemetry, this.dispatcher);
      this.lastCommandAt = this.dispatcher.lastDispatchAt;
      if (result.status === 'error') {
        return { status: 'error', reason: result.error, code: result.code || null,
          inputAccepted: false, effectVerified: false };
      }
      return { status: 'walking', ...result };
    }
    if (botState === BOT_STATES.LURING) {
      // Lure sem agrupar ainda: anda, mas nao ataca.
      const result = await this.walker.tick(telemetry, this.dispatcher);
      return { status: 'luring', ...result };
    }
    return { status: String(botState).toLowerCase(), action: 'idle', inputAccepted: false };
  }
}

module.exports = { BotRuntime, DEFAULT_TICK_MS };
