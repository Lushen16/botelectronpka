'use strict';

/**
 * Ponte entre o canal capturado do menu e os motores do botfinal.
 *
 * O canal ja vem autenticado pelo menu original. Este modulo so adapta a API
 * (snapshot/sendCommand) ao que BotRuntime espera e liga os motores.
 */

const path = require('node:path');

function load(root, relative) {
  return require(path.join(root, relative));
}

function startBotOnChannel(channel, options = {}) {
  const root = options.root || path.resolve(__dirname, '..', '..');
  const BotRuntime = load(root, 'botfinal/core/bot-runtime.cjs').BotRuntime;
  const CombatEngine = load(root, 'botfinal/engines/combat-engine.cjs').CombatEngine;
  const WalkerEngine = load(root, 'botfinal/engines/walker-engine.cjs').WalkerEngine;
  const HealerEngine = load(root, 'botfinal/engines/healer-engine.cjs').HealerEngine;
  const StateArbiter = load(root, 'botfinal/core/state-arbiter.cjs').StateArbiter;

  const fs = require('node:fs');
  const config = options.config
    || (fs.existsSync(options.configFile)
      ? JSON.parse(fs.readFileSync(options.configFile, 'utf8'))
      : {});

  // Adaptador: BotRuntime chama session.snapshot() e dispatcher.sendCommand().
  const session = {
    snapshot: () => channel.snapshot(),
    get error() { return channel.error; },
  };
  const dispatcher = {
    lastDispatchAt: -Infinity,
    async sendCommand(name, parameter, extra) {
      const ack = await channel.sendCommand(name, parameter, extra);
      if (!ack || ack.status !== 0) {
        throw Object.assign(Error('Runtime rejeitou ' + name + ': status ' + (ack?.status ?? '?')),
          { code: 'COMMAND_REJECTED', status: ack?.status ?? null });
      }
      this.lastDispatchAt = Date.now();
      return ack;
    },
    attack(id) { return this.sendCommand('attack', id); },
    skill(spell) { return this.sendCommand('talk', String(spell)); },
    walk(direction) { return this.sendCommand('walk', direction); },
    hotkey(key) { return this.sendCommand('hotkey', String(key)); },
  };

  const arbiter = new StateArbiter(config);
  const runtime = new BotRuntime({
    session,
    transport: channel,
    config,
    combat: new CombatEngine(config),
    walker: new WalkerEngine(config),
    healer: new HealerEngine(config),
    arbiter,
    dispatcher,
  });

  runtime.on('change', state => {
    const last = state.last || {};
    const line = '[pka-bot] ' + state.state + ' :: ' + (last.status || '-')
      + (last.action ? '/' + last.action : '') + (last.reason ? ' (' + last.reason + ')' : '');
    try {
      process.stdout.write('\r' + line + '            ');
      if (process.env.PKA_CONTROLLER_LOG_DIR) {
        fs.appendFileSync(path.join(process.env.PKA_CONTROLLER_LOG_DIR, 'controller.log'), line + '\n');
      }
    } catch { /* ignore */ }
  });

  runtime.start();
  return runtime;
}

module.exports = { startBotOnChannel };
