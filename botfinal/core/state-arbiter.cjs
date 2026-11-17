'use strict';

/**
 * StateArbiter: Réplica estrita da máquina de estados observada no payload
 * nativo do Shiba Bots (msftedit.dll stomped .text).
 * 
 * Hierarquia de controle:
 * 1. EMERGENCY_HEAL: HP crítico do Player ou Pet exige cura imediata.
 * 2. REVIVE: Se o pet morreu ou combo terminou com revive pendente.
 * 3. REPOSICIONAMENTO (Dynamic Lure): fechando a box. Vence o combate.
 * 4. COMBAT (Target): a formação FECHOU (isFormationHeld) → rotação assume.
 * 5. LURING (Travel Lure): há monstros e ele ainda está agrupando/andando.
 * 6. NORMAL_HEAL: cura segura fora de combate.
 * 7. WALKING: caminhada livre pelos waypoints.
 *
 * CORREÇÃO MEDIDA (2026-11-11, adendo 10 do checkpoint):
 * ------------------------------------------------------
 * A versão anterior disparava COMBAT quando `count >= minCount`. A captura do
 * Shiba (37.702 kind6, sessão real) mostra que isso está ERRADO:
 *
 *   count>=minCount → MOVING 1.882 frames | GROUPING 233 frames
 *
 * Ou seja: com o "lure pronto" pela contagem, ele continua ANDANDO em 89%
 * dos casos. O discriminador real é `luring.holding`:
 *
 *   holding=true  → GROUPING 855 de 856 (99,9%), qualquer contagem
 *   holding=false → MOVING  10.746 de 10.865
 *
 * E `holding` transita SEM a contagem mudar (transições medidas `7->7`,
 * `6->6`, `8->8`): ele depende de GEOMETRIA (quem colou na box), não de
 * número de monstros. Por isso `isLureReady` (contagem) sozinho não decide
 * combate — passa a ser apenas o pré-requisito de "há densidade suficiente",
 * e o disparo exige `isFormationHeld`.
 */

const BOT_STATES = Object.freeze({
  IDLE: 'IDLE',
  WALKING: 'WALKING',
  LURING: 'LURING',
  COMBAT: 'COMBAT',
  HEALING: 'HEALING',
  REVIVING: 'REVIVING',
});

class StateArbiter {
  constructor(config = {}) {
    this.config = config;
    this.currentState = BOT_STATES.IDLE;
    this.lastState = null;
    this.stateSince = Date.now();
    this.log = [];
  }

  updateConfig(config) {
    this.config = config;
  }

  evaluate(telemetry, { inCombat, validTargets, isLureReady, isRevivePending, isFormationHeld, isRepositioning }) {
    const now = Date.now();
    const playerHp = telemetry?.healthPercent ?? 100;
    const petHp = telemetry?.ownPokemon?.healthPercent ?? 100;
    const isPetPresent = Boolean(telemetry?.ownPokemon && petHp > 0);

    const emergencyPlayerHp = Number(this.config?.target?.lowHpComboPercent ?? 20);
    const emergencyPetHp = Number(this.config?.healer?.healHpPercent ?? 15);

    // 1. Emergência de Vida: cura imediata interrompe qualquer ação
    const isCriticalHp = playerHp <= emergencyPlayerHp || (isPetPresent && petHp <= emergencyPetHp);
    if (isCriticalHp && this.config?.healer?.enabled) {
      return this._transition(BOT_STATES.HEALING, 'Emergência de HP (Player ou Pet)');
    }

    // 2. Ciclo de Revive
    if (isRevivePending) {
      return this._transition(BOT_STATES.REVIVING, 'Revive em andamento');
    }

    // 3. Reposicionamento (Dynamic Lure): o Shiba fecha a box ANTES de atacar.
    //
    // MEDIDO (hunt real, PID 17748): 51 frames em que ele estava em
    // `luring.phase=arc/stationary/wait` enquanto `phases.target` ja' dizia
    // "Perfect lure 8/8". Ele agrupa primeiro; o combo sai depois.
    //
    // Isso tem precedencia sobre o combate, senao o nosso atacaria no meio do
    // posicionamento e perderia a formacao.
    if (isRepositioning === true) {
      return this._transition(BOT_STATES.LURING, 'Reposicionando a formação (Dynamic Lure)');
    }

    // 4. Combate (Target).
    //
    // Dispara por DOIS caminhos, e a ordem importa:
    //   a) `isFormationHeld` — a formação fechou (o critério do Shiba,
    //      medido: 99,9% de acerto). Vale mesmo com contagem abaixo do alvo,
    //      porque o que importa é quem colou na box, não quantos existem.
    //   b) `inCombat` explícito — quando o motor de combate já está engajado
    //      (ex.: retomada após revive, ou combo em andamento).
    //
    // `isLureReady` (contagem >= minCount) NÃO dispara combate sozinho: foi
    // medido que ele continua andando nessa condição em 89% dos frames.
    //
    // `isFormationHeld` NÃO exige `hasMonsters`: formação fechada IMPLICA que
    // há monstros na box. Exigir a lista junto descartava 908 frames reais em
    // que o payload do Shiba dizia "Best Tile 8/8" mas não trazia a contagem
    // em `luring.count` (o dado vinha da fase textual).
    const hasMonsters = Array.isArray(validTargets) && validTargets.length > 0;
    if (isFormationHeld === true) {
      return this._transition(BOT_STATES.COMBAT, 'Formação fechada (Prioridade Target)');
    }
    if (hasMonsters && inCombat) {
      return this._transition(BOT_STATES.COMBAT, 'Combate já engajado');
    }

    // 4. Luring (Travel Lure): agrupando monstros
    if (hasMonsters) {
      return this._transition(BOT_STATES.LURING, 'Agrupando monstros (Travel Lure)');
    }

    // 5. Cura fora de combate (se configurada e necessária)
    const healThreshold = Number(this.config?.healer?.healHpPercent ?? 60);
    if (this.config?.healer?.enabled && (playerHp < healThreshold || petHp < healThreshold)) {
      return this._transition(BOT_STATES.HEALING, 'Cura fora de combate');
    }

    // 6. Walker: sem monstros e sem necessidade de cura
    if (this.config?.walker?.enabled) {
      return this._transition(BOT_STATES.WALKING, 'Caminhada livre pelos waypoints');
    }

    return this._transition(BOT_STATES.IDLE, 'Aguardando ação');
  }

  _transition(newState, reason) {
    if (this.currentState !== newState) {
      this.lastState = this.currentState;
      this.currentState = newState;
      this.stateSince = Date.now();
      const entry = { from: this.lastState, to: newState, reason, timestamp: this.stateSince };
      this.log.push(entry);
      if (this.log.length > 50) this.log.shift();
    }
    return this.currentState;
  }
}

module.exports = { StateArbiter, BOT_STATES };
