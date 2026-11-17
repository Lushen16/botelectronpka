'use strict';

/**
 * Ligacao entre o controle (kind 11) e os MOTORES PROPRIOS.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * `automation_apply()` em native/pka_native.c so' altera flags e as publica no
 * kind 6. Auditar as quatro variaveis mostra 5 leitores, todos dentro de
 * build_automation(): nenhum deles inicia motor, aplica config ou emite acao.
 * `modules: ["target"]` e' cosmetica. Este modulo faz a ponte que faltava:
 * kind 11 -> motor proprio -> executor proprio.
 *
 * ARQUITETURA ESCOLHIDA: A (motores no Node).
 * A cadeia ja' existia e nao estava ligada:
 *
 *   kind 11 (start/stop/monitor/togglePause)
 *     -> AutomationControl (estados explicitos)
 *     -> ControlBridge (este arquivo: valida config, liga/desliga motores)
 *     -> BotRuntime (arbitro) -> Combat/Walker/Healer
 *     -> CommandDispatcher (kind 9) -> Transport -> execute_command()
 *
 * Motores na DLL duplicariam CombatEngine/WalkerEngine que ja' existem, com
 * regras que so' os testes cobrem. Escolhemos nao duplicar.
 *
 * O QUE ESTE MODULO NAO PROMETE
 * - kind 11 nao tem ACK. `accepted` aqui significa "a config passou na
 *   validacao local e o motor foi armado", nao "o cliente executou".
 * - `effectVerified` continua false ate' alguem observar o cliente.
 */

const { STATE } = require('./automation-control.cjs');
const { BOT_STATES } = require('./state-arbiter.cjs');

const MOTORS = Object.freeze(['target', 'walker', 'hooper', 'healer']);

/** Validacao de config: o que o motor realmente precisa para armar. */
function validateConfig(module, config, engines) {
  const issues = [];
  if (!config || typeof config !== 'object') {
    issues.push('config ausente');
    return { ok: false, issues };
  }
  if (module === 'walker') {
    const waypoints = config.walker?.waypoints;
    if (!Array.isArray(waypoints) || waypoints.length === 0) {
      issues.push('walker.waypoints vazio: o motor nao tem rota');
    } else {
      for (const [index, wp] of waypoints.entries()) {
        const pos = wp?.pos;
        if (!pos || ![pos.x, pos.y, pos.z].every(Number.isInteger)) {
          issues.push('waypoint ' + index + ' sem posicao inteira');
        } else if (pos.x < 0 || pos.x >= 65535 || pos.y < 0 || pos.y >= 65535
                   || pos.z < 0 || pos.z > 15) {
          issues.push('waypoint ' + index + ' fora dos limites');
        }
        if (wp?.action && !engines.walker.allowedActions?.includes(wp.action)
            && !['walk', 'wait'].includes(wp.action)) {
          issues.push('waypoint ' + index + ' com acao nao suportada: ' + wp.action);
        }
      }
    }
  }
  if (module === 'target') {
    if (!Array.isArray(config.target?.monsters)) {
      issues.push('target.monsters ausente');
    }
    const combo = config.target?.combo;
    if (combo?.enabled && typeof combo.sequenceText !== 'string') {
      issues.push('target.combo habilitado sem sequenceText');
    }
  }
  return { ok: issues.length === 0, issues };
}

class ControlBridge {
  constructor(options = {}) {
    if (!options.runtime) throw Error('runtime (BotRuntime) e obrigatorio');
    this.runtime = options.runtime;
    this.config = options.config || {};
    this.engines = {
      combat: options.combat,
      walker: options.walker,
      healer: options.healer,
    };
    this.arbiter = options.arbiter;
    this.log = [];
    this.modules = [];
    this.paused = false;
    this.started = false;
    this._lastActive = null;
  }

  get state() {
    return {
      started: this.started,
      paused: this.paused,
      modules: [...this.modules],
      lastActive: this._lastActive,
      arbiter: this.arbiter?.currentState ?? null,
      ticks: this.runtime?.ticks ?? 0,
    };
  }

  _record(entry) {
    this.log.push({ at: Date.now(), ...entry });
    this.log = this.log.slice(-200);
    return entry;
  }

  /**
   * Aplica a config de um start. Nao confia: valida, atualiza os motores,
   * e so' entao liga o runtime. Devolve o que foi de fato feito.
   */
  async applyConfig(module, config) {
    const validation = validateConfig(module, config, this.engines);
    if (!validation.ok) {
      return this._record({ action: 'config-rejected', module,
        issues: validation.issues });
    }
    this.config = config;
    this.runtime.updateConfig?.(config);
    this.engines.combat?.updateConfig?.(config);
    this.engines.walker?.updateConfig?.(config);
    this.engines.healer?.updateConfig?.(config);
    return this._record({ action: 'config-applied', module,
      waypoints: config.walker?.waypoints?.length ?? 0,
      monsters: config.target?.monsters?.length ?? 0 });
  }

  /** Liga um modulo: valida config, arma o motor e solta o runtime. */
  async start(module, config) {
    if (!['target', 'walker'].includes(module)) {
      return this._record({ action: 'start-refused', module,
        reason: 'module sem motor proprio ligado' });
    }
    const applied = await this.applyConfig(module, config);
    if (applied.action !== 'config-applied') return applied;

    if (!this.modules.includes(module)) this.modules.push(module);
    this.paused = false;
    this.started = true;
    if (this.arbiter) {
      /* O arbitro decide o estado a cada tick; nao forcamos COMBAT/WALKING.
       * Forcar seria inventar decisao. So' garantimos que o runtime corre. */
      this.arbiter.updateConfig?.(config);
    }
    this.runtime.start();
    this._record({ action: 'started', module, modules: [...this.modules] });
    return { action: 'started', module, modules: [...this.modules] };
  }

  /** Para um modulo. `stop` precisa interromper comandos novos, nao so' marcar. */
  async stop(module) {
    if (module === 'hoenn' || !['target', 'walker'].includes(module)) {
      /* Nao ha' motor proprio para hoenn/healer hoje: registramos a recusa em
       * vez de fingir que parou algo. */
      return this._record({ action: 'stop-refused', module,
        reason: 'module sem motor proprio ligado' });
    }
    this.modules = this.modules.filter(name => name !== module);
    this.runtime.stop();
    this.started = this.modules.length > 0;
    this._lastActive = null;
    this._record({ action: 'stopped', module, modules: [...this.modules] });
    return { action: 'stopped', module, modules: [...this.modules] };
  }

  /** Pausa/retoma o despacho. Pausa corta comandos NOVOS; um ja' em voo termina. */
  async setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      await this.runtime.pause();
      this._record({ action: 'paused' });
    } else {
      await this.runtime.resume();
      this._record({ action: 'resumed' });
    }
    return { action: this.paused ? 'paused' : 'resumed' };
  }

  /** Traduz um comando kind 11 recebido para a operacao local equivalente. */
  async handle(body) {
    if (!body || typeof body.op !== 'string') {
      return { ok: false, failure: 'bad-request' };
    }
    const op = body.op;
    if (op === 'start') {
      const result = await this.start(body.module, body.config);
      return { ok: result.action === 'started', op, result };
    }
    if (op === 'stop') {
      const result = await this.stop(body.module);
      return { ok: result.action === 'stopped', op, result };
    }
    if (op === 'monitor') {
      const result = await this.setPaused(body.enabled !== true);
      return { ok: true, op, result };
    }
    if (op === 'togglePause') {
      const result = await this.setPaused(body.pauseMonitor === true);
      return { ok: true, op, result };
    }
    return { ok: false, failure: 'unknown-op', op };
  }

  async close() {
    this.runtime.stop();
    this.modules = [];
    this.started = false;
    this.paused = false;
  }
}

module.exports = { ControlBridge, validateConfig, MOTORS, STATE, BOT_STATES };
