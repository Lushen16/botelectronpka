'use strict';

/**
 * CombatEngine: Motor de combate fiel à implementação nativa do Shiba Bots.
 * 
 * Principais garantias de fluidez:
 * 1. Target Lock Direto: envia 'attack' passando o uint32 creature.id direto via pipe.
 *    NÃO calcula coordenadas de tela e NÃO envia cliques de mouse simulados.
 * 2. Combo Nativo: envia '!autocombo' ou a rotação configurada (m1..m12) via canal direto.
 * 3. Finalização Fluida: ao matar o monstro ou atingir 'finishRemainingCount', libera
 *    o controle imediatamente para o Walker sem atrasos artificiais.
 * 4. Perfect Lure Preciso: checagem de distância Chebyshev em relação ao Pokémon próprio.
 */

const { DynamicLure } = require('./dynamic-lure.cjs');

function chebyshev(posA, posB) {
  if (!posA || !posB) return Infinity;
  return Math.max(Math.abs(posA.x - posB.x), Math.abs(posA.y - posB.y));
}

function isShiny(creature) {
  return typeof creature?.name === 'string' && /shiny/iu.test(creature.name);
}

class CombatEngine {
  constructor(config = {}) {
    this.config = config.target || {};
    this.hoenn = config.hoenn || {};
    this.targetId = null;
    this.targetSince = null;
    this.attackDispatched = false;
    this.comboStartedAt = null;
    this.comboCompletedAt = null;
    this.lastSkillTime = 0;
    this.stepIndex = 0;
    // Dynamic Lure: reposicionamento antes de soltar o combo. Ver
    // engines/dynamic-lure.cjs para o modelo extraido da captura real.
    this.lure = new DynamicLure(config);
    this.lastLure = null;
    this.ignored = new Set(
      String(this.config.ignoredCreaturesText || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  updateConfig(config = {}) {
    this.config = config.target || {};
    this.hoenn = config.hoenn || {};
    this.ignored = new Set(
      String(this.config.ignoredCreaturesText || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  filterValidTargets(telemetry) {
    const ownId = telemetry?.ownPokemon?.id;
    const playerPos = telemetry?.position;
    if (!playerPos || !Array.isArray(telemetry?.creatures)) return [];

    const maxDist = Number(this.config.maxDistance ?? 8);
    /* Alcance de ataque e' no MESMO ANDAR, e o Shiba ataca a partir da
     * posicao do Pokemon ativo (quem executa a move), nao do jogador.
     *
     * MEDIDO (2026-11-12, 18 ataques reais): com dz=0 -> 5/5 deram dano;
     * com dz=1 -> apenas 2/13 deram, e esses 2 foram alvos vizinhos que
     * desceram/subiram durante o voo. O handler nao reclama de alvo em
     * outro z: ele simplesmente nao conecta.
     *
     * `chebyshev()` sozinho NAO pega isso — ele ignora `z`. Era o furo:
     * alvo a 1 tile no plano e um andar acima passava no filtro e o bot
     * gastava ataque sem efeito. */
    const origin = telemetry?.ownPokemon?.pos || playerPos;

    return telemetry.creatures.filter(creature => {
      if (!creature || !creature.canAttack) return false;
      if (creature.id === ownId || creature.isOwnPokemon || creature.creatureType === 3) return false;
      if (creature.is_player || creature.creatureType === 0) return false;
      if (creature.healthPercent <= 0) return false;

      const name = String(creature.name || '').toLowerCase();
      if (this.ignored.has(name)) return false;

      /* mesmo andar obrigatorio quando ambos os z sao conhecidos */
      if (Number.isInteger(origin?.z) && Number.isInteger(creature.pos?.z)
          && origin.z !== creature.pos.z) return false;

      const dist = chebyshev(origin, creature.pos);
      return dist <= maxDist;
    });
  }

  /**
   * O Shiba está em reposicionamento (Dynamic Lure) antes de soltar o combo?
   *
   * Implementado em `engines/dynamic-lure.cjs` com AS FASES E DURAÇÕES
   * MEDIDAS na captura real (PID 17748, 6.616 frames dynamic):
   *
   *   travel      3.672 ms   anda (rota normal)
   *   arc            32 ms   micro-ajuste de ±1 tile
   *   stationary    234 ms   parado agrupando
   *   wait        1.406 ms   espera curta
   *
   * Devolve true quando o lure esta' num pulso de agrupamento (arc/wait/
   * stationary) e ainda NAO liberou o combo. Nesse estado o arbiter escolhe
   * LURING em vez de COMBAT — que e' o comportamento dele: fecha a box
   * primeiro, ataca depois.
   *
   * LIMITE: o `decide()` do lure precisa de telemetria viva. Quando chamado
   * sem snapshot (ou com lure desligado) devolve false.
   */
  isRepositioning(telemetry, candidates) {
    if (!telemetry) return false;
    const r = this.lure.decide(telemetry, { now: Date.now() });
    this.lastLure = r;
    if (r.action === 'release' || r.phase === 'off') return false;
    return r.phase === 'arc' || r.phase === 'stationary' || r.phase === 'wait';
  }

  /**
   * A formação está FECHADA? (critério que dispara o combate)
   *
   * MEDIDO no Shiba (37.702 kind6, checkpoint adendo 10):
   *   luring.holding=true  -> GROUPING 855/856 (99,9%)
   *   luring.holding=false -> MOVING  10.746/10.865
   * e `holding` transita com a contagem PARADA (`7->7`, `6->6`, `8->8`):
   * depende de geometria, não de número.
   *
   * Por isso: a contagem sozinha NÃO fecha formação. O que fecha é ter
   * monstros suficientes DENTRO do alcance do combo.
   */
  isFormationHeld(telemetry, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return false;
    const center = telemetry?.ownPokemon?.pos || telemetry?.position;
    if (!center) return false;
    const combo = this.config.combo || {};
    const range = Number(combo.perfectingLureRange ?? this.hoenn.perfectingLureRange ?? 4);
    const boxed = candidates.filter(c => chebyshev(center, c.pos) <= range);
    const minWilds = Number(this.hoenn.minWildsToEngage ?? 0);
    // Sem meta configurada: qualquer monstro na área já fecha.
    if (minWilds <= 0) return boxed.length > 0;
    return boxed.length >= minWilds;
  }

  /**
   * "Há densidade suficiente de monstros por perto?" — pré-requisito, NÃO
   * gatilho de combate.
   *
   * CORREÇÃO (2026-11-11): a versão anterior fazia
   *     return boxedMonsters.length >= minWilds || candidates.length >= minWilds;
   * O segundo termo usava a contagem TOTAL (o `candidates.length`), e era ele
   * que disparava o combate. Foi medido que o Shiba, nessa condição, continua
   * andando em 89% dos frames (1.882 de 2.115). Ou seja: era falso positivo
   * estrutural, não limiar mal ajustado.
   *
   * Agora só conta quem está dentro do alcance do combo. Quem decide parar é
   * `isFormationHeld`.
   */
  isLureConditionMet(telemetry, candidates) {
    const minWilds = Number(this.hoenn.minWildsToEngage ?? 0);
    const perfectLure = this.hoenn.perfectLure === true;
    const combo = this.config.combo || {};

    if (minWilds <= 0 && !perfectLure && !combo.perfectingLureEnabled) {
      return candidates.length > 0;
    }

    const center = telemetry?.ownPokemon?.pos || telemetry?.position;
    if (!center) return candidates.length > 0;
    const range = Number(combo.perfectingLureRange ?? this.hoenn.perfectingLureRange ?? 4);

    const boxedMonsters = candidates.filter(c => chebyshev(center, c.pos) <= range);

    if (minWilds > 0) {
      return boxedMonsters.length >= minWilds;
    }

    return boxedMonsters.length >= 1;
  }

  selectTarget(telemetry, candidates) {
    if (!candidates.length) return null;

    // Prioridade absoluta para Shiny se configurado
    if (this.config.shinyPriorityEnabled) {
      const shiny = candidates.find(isShiny);
      if (shiny) return shiny;
    }

    const playerPos = telemetry?.position;
    const mode = this.config.priorityMode || 'highestPriorityList';

    if (mode === 'lowestHealth') {
      return [...candidates].sort((a, b) => a.healthPercent - b.healthPercent)[0];
    }

    if (mode === 'nearest') {
      return [...candidates].sort((a, b) => chebyshev(playerPos, a.pos) - chebyshev(playerPos, b.pos))[0];
    }

    // Default: ordem da lista de monstros configurada ou o mais próximo
    return candidates[0];
  }

  async tick(telemetry, pipeTransport) {
    const now = Date.now();
    const candidates = this.filterValidTargets(telemetry);

    if (!candidates.length) {
      this.clearTarget();
      return { status: 'idle', reason: 'no-targets' };
    }

    const target = this.selectTarget(telemetry, candidates);
    if (!target) {
      this.clearTarget();
      return { status: 'idle', reason: 'target-lost' };
    }

    // 1. Mudança de Alvo: reseta rotação
    if (this.targetId !== target.id) {
      this.targetId = target.id;
      this.targetSince = now;
      this.attackDispatched = false;
      this.stepIndex = 0;
    }

    // 2. Trava de Alvo (Target Lock direto no protocolo do jogo)
    //    Um comando por tick: o tick seguinte cuida do combo.
    if (!this.attackDispatched) {
      try {
        await pipeTransport.sendCommand('attack', target.id);
        this.attackDispatched = true;
        return { status: 'attack-dispatched', targetId: target.id,
          targetName: target.name, hp: target.healthPercent };
      } catch (err) {
        return { status: 'error', command: 'attack', code: err.code || null, error: err.message };
      }
    }

    // 3. Execução de Combo de Skills
    const combo = this.config.combo || {};
    if (combo.enabled) {
      const lureDelay = Number(combo.lureDelay ?? 0);
      const stepDelay = Number(combo.stepDelay ?? 300);

      // Espera lure delay antes da primeira skill
      if (this.stepIndex === 0 && (now - this.targetSince < lureDelay)) {
        return { status: 'waiting-lure-delay', remaining: lureDelay - (now - this.targetSince) };
      }

      // Se usa comando nativo !autocombo, despacha uma única vez no início
      if (combo.useNativeSequence) {
        if (!this.comboStartedAt) {
          try {
            await pipeTransport.sendCommand('combo', '!autocombo');
            this.comboStartedAt = now;
            return { status: 'autocombo-dispatched' };
          } catch (err) {
            return { status: 'error', command: 'combo', code: err.code || null, error: err.message };
          }
        }
      } else {
        // Sequência manual m1..m12, aceitando virgula ou espaco como separador.
        const sequence = String(combo.sequenceText || '')
          .split(/[,;\s]+/u)
          .map(row => row.trim().toLowerCase())
          .filter(row => /^m[1-9]\d*$/u.test(row));

        if (sequence.length && (now - this.lastSkillTime >= stepDelay)) {
          if (this.stepIndex < sequence.length) {
            const move = sequence[this.stepIndex];
            try {
              await pipeTransport.sendCommand('talk', move);
              this.lastSkillTime = now;
              this.stepIndex++;
              return { status: 'skill-dispatched', move, step: this.stepIndex };
            } catch (err) {
              return { status: 'error', command: 'talk', move, code: err.code || null, error: err.message };
            }
          } else {
            // Rotação completa
            this.comboCompletedAt = now;
          }
        }
      }
    }

    return { status: 'in-combat', targetId: target.id, targetName: target.name, hp: target.healthPercent };
  }

  clearTarget() {
    this.targetId = null;
    this.targetSince = null;
    this.attackDispatched = false;
    this.comboStartedAt = null;
    this.stepIndex = 0;
  }
}

module.exports = { CombatEngine };
