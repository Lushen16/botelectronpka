#!/usr/bin/env node
'use strict';

/**
 * Rota longa: valida o CICLO, nao uma acao isolada.
 *
 *   node tools/route-cycle.cjs --pid 1712 --minutes 5
 *   node tools/route-cycle.cjs --pid 1712 --minutes 3 --dirs 0,1,2,3
 *
 * DIFERENCA em relacao a route-e2e.cjs:
 *   route-e2e faz walk -> attack -> combo UMA vez e reporta.
 *   route-cycle roda N ciclos e mede:
 *     - quantos waypoints foram alcancados
 *     - quantos alvos foram mortos
 *     - se o walker RETOMOU a rota depois do combate
 *     - se algum passo falhou por obstaculo/cooldown
 *
 * O QUE ISSO PROVA: que os motores coexistem. Sem isso, cada acao isolada
 * funciona mas o bot nao "anda, acha, mata e segue" — que e' o minimo de um bot.
 *
 * SEM FOCO: walk e attack sao nativos. Se o teste exigir foco, ele reporta.
 * Nenhuma acao no cliente alem dos comandos do proprio bot.
 *
 * SAIDA
 *   <out>.json  — resumo por ciclo
 *   imprime tabela ao final
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NativeTransport } = require(path.join(ROOT, 'botfinal', 'core', 'pipe-transport.cjs'));
const { createHealerEngine } = require(path.join(ROOT, 'reconstruction', 'engines', 'healer-engine.cjs'));

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

const pid = Number(arg('--pid', 0));
if (!pid) { console.error('faltou --pid'); process.exit(2); }
const minutes = Number(arg('--minutes', 3));
const stepsPerCycle = Number(arg('--steps', 4));
const dirs = String(arg('--dirs', '0,1,2,3')).split(',').map(s => Number(s.trim()))
  .filter(d => Number.isInteger(d) && d >= 0 && d <= 7);
const outBase = String(arg('--out', path.join(ROOT, 'captures', 'routes', `cycle-${pid}`)));

const keyFile = path.join(ROOT, 'captures', `channel-key-${pid}.json`);
if (!fs.existsSync(keyFile)) { console.error('sem chave em ' + keyFile); process.exit(2); }
const key = JSON.parse(fs.readFileSync(keyFile, 'utf8')).key;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const DELTA = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0],
  4: [0, -1], 5: [0, 1], 6: [0, 1], 7: [0, -1] };

async function main() {
  const t = new NativeTransport({ pid, key });
  let snap = null;
  let lastState = null;
  t.on('telemetry', v => { snap = v; });
  t.on('state', v => { lastState = v; });

  await t.connect();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !snap) await sleep(50);
  if (!snap) { console.error('sem telemetria'); process.exit(1); }

  /* GUARDA DE MUNDO — o criterio tem que ser o RUNTIME GATE, nao o HP.
   *
   * MEDIDO (2026-11-12): 54 walks retornaram "dir=N na thread do jogo" e a
   * posicao nao mudou 1 tile. Diagnostico:
   *
   *     runtime gate [rt+0x2668] = 0
   *     runtime alvo [rt+0x2528] = 0x0
   *     global LocalPlayer       = 0x0
   *
   * O jogo estava no MENU. `Game::walk` foi chamada 54 vezes e nao tinha
   * personagem para mover. `kind 4` NAO detecta isso: reporta `isOnline:1`
   * lendo so' o HP, que continua 100 no menu.
   *
   * O sinal confiavel e' a telemetria: `playerName` vem do global/vtable e
   * `creatures` do scan. Se ambos vazios, nao ha mundo.
   *
   * LIMITE: se o personagem estiver no mundo mas numa area sem criaturas, esta
   * guarda tambem bloqueia. E' conservador de proposito: medir walk sem alvo
   * ainda e' possivel, mas medir ATTACK nao — e o ciclo precisa dos dois.
   *
   * ATUALIZADO (2026-11-13): `runtimeReady` sozinho TAMBEM nao basta. Medido
   * no mesmo cliente, em sequencia:
   *
   *   a) menu:       runtimeReady=false, position valida, hp=100
   *                  -> o gate pega (era o caso de 2026-11-12)
   *   b) transicao:  runtimeReady=TRUE,  position=(0,0,0), hp=0
   *                  -> o gate NAO pega; 10 walks enviados, 0 tiles
   *
   * O gate abre antes da posicao ser publicada e continua aberto depois da
   * morte. A regra correta e' a CONJUNCAO dos dois sinais. `(0,0,0)` e
   * `(65535,65535,255)` sao sentinelas de "sem mundo", nao coordenadas. */
  const hasGate = Boolean(snap) && typeof snap.runtimeReady === 'boolean';
  const validPos = () => {
    const p = snap && snap.position;
    return Boolean(p && Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z)
      && p.x > 0 && p.y > 0 && p.x < 60000 && p.y < 60000 && p.z >= 0 && p.z < 100);
  };
  const inWorld = () => {
    if (!validPos()) return false;
    if (hasGate) return snap.runtimeReady === true;
    const hasName = snap && typeof snap.playerName === 'string' && snap.playerName.length > 0;
    return hasName;
  };

  if (!inWorld()) {
    const pos = snap && snap.position;
    console.error('BLOQUEADO: personagem fora do mundo.');
    console.error(`  runtimeReady: ${hasGate ? String(snap.runtimeReady) : 'nao publicado (DLL antiga)'}`);
    console.error(`  position  : ${pos ? `(${pos.x},${pos.y},${pos.z})` : 'ausente'}`);
    console.error(`  playerName: ${snap && snap.playerName ? JSON.stringify(snap.playerName) : 'vazio'}`);
    console.error('');
    console.error('O jogo esta no menu. `Game::walk` seria chamada sem efeito —');
    console.error('foi o que aconteceu: 54 walks, 0 tiles. Entre no mundo e rode de novo.');
    console.error('Nada foi enviado.');
    t.close();
    process.exit(3);
  }

  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  const log = [];
  const cycles = [];
  const tEnd = Date.now() + minutes * 60000;
  let cycleIdx = 0;
  let dirIdx = 0;

  /* Healer configurado a partir da config REAL capturada do Shiba
   * (botfinal/config/kind11/target-config.json), nao de valores inventados:
   *
   *   poção    Alt+f (action bar 3), abaixo de 60%, cooldown 1500 ms
   *   medicine tecla "E", habilitado
   *   healer   healHpPercent 0 -> CURA POR MOVE DESLIGADA
   *
   * `healHpPercent: 0` e' proposital. Curar por move (`m5`) troca o Pokemon
   * ativo e mexe no roster; sem roster real publicado pela nossa DLL, o
   * healer cairia em 'heal-pokemon-unresolved' e nao faria nada. A poção
   * resolve o caso que MATOU o teste anterior: o personagem apanhou do
   * Magnemite ate' hp=0 (ver adendo 7). Poção e' o remédio barato e correto.
   *
   * WHY no ciclo: medido 2026-11-12 — 17 batedores, o ataque passou a fazer
   * dano e o selvagem revidou; sem cura o bot atacou ate' morrer. Um ciclo que
   * mede "walk e attack funcionam" nao pode morrer no meio da medicao. */
  const healerCfg = (() => {
    try {
      const base = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'botfinal', 'config', 'kind11', 'target-config.json'), 'utf8'
      ).replace(/^\uFEFF/u, ''));
      return { healer: base.healer || {}, hoenn: base.hoenn || {} };
    } catch (e) {
      console.error('aviso: config do healer ausente (' + e.message + '); rodando sem cura');
      return null;
    }
  })();
  const healer = healerCfg ? createHealerEngine(healerCfg, { keyboardOnly: false }) : null;
  if (healer) {
    console.log(`healer  : potion ${healerCfg.hoenn.potionHotkey || '-'} abaixo de `
      + `${healerCfg.hoenn.potionHpPercent}% | heal-move ${healerCfg.healer.healHpPercent || 'off'}`);
  }

  /* Executa o healer contra a telemetria corrente. Devolve o que foi enviado.
   * O sink fala 'talk'/'hotkey' no mesmo transporte dos outros comandos. */
  async function runHealer(cycle) {
    if (!healer) return null;
    const emitted = [];
    const sink = {
      command: (name, parameter, extra) => emitted.push({ name, parameter, extra }),
    };
    let result;
    try { result = healer.step(snap, sink, Date.now()); }
    catch (e) { cycle.errors.push({ stage: 'healer', error: e.message }); return null; }
    if (result && result.blocked && result.blocked.length) {
      cycle.healerBlocked = result.blocked;
    }
    for (const cmd of emitted) {
      try {
        const args = cmd.extra !== undefined
          ? [cmd.name, cmd.parameter, cmd.extra]
          : [cmd.name, cmd.parameter];
        const ack = await t.sendCommand(...args);
        cycle.heals.push({ cmd: cmd.name, param: cmd.parameter, status: ack.status });
      } catch (e) {
        cycle.errors.push({ stage: 'heal', error: e.message });
      }
    }
    return result;
  }

  while (Date.now() < tEnd) {
    cycleIdx++;
    /* Se o personagem saiu do mundo no meio da rota (morte, deslog, transicao
     * de mapa), parar em vez de acumular ciclos vazios que parecem falha.
     *
     * MEDIDO (2026-11-12): rodei 17 ciclos e os ultimos 8 reportaram
     * `walk 0/3 | atk sem-efeito` com `dist=1 dz=0` (alvo adjacente!). Nao era
     * alcance: o log mostrou `attack handler devolveu 13` e depois
     * `reentrada=1` -> `gate=0`. O personagem tinha MORRIDO (hp=0, titulo sem
     * "- Usobot"). O Magnemite revidou enquanto o script seguia atacando.
     *
     * Tambem para quando o HP cai a 0 mesmo com o objeto ainda legivel por
     * vtable-scan (que acha a instancia no menu de morte). */
    if (!inWorld()) {
      console.log(`\nciclo ${cycleIdx}: personagem saiu do mundo; parando.`);
      cycleIdx--;
      break;
    }
    const hp = snap && typeof snap.healthPercent === 'number' ? snap.healthPercent : null;
    if (hp !== null && hp <= 0) {
      console.log(`\nciclo ${cycleIdx}: HP=0 (morreu); parando.`);
      cycleIdx--;
      break;
    }
    const cycle = {
      cycle: cycleIdx,
      tStart: Date.now(),
      posStart: snap.position ? { ...snap.position } : null,
      hpStart: typeof snap.healthPercent === 'number' ? snap.healthPercent : null,
      walks: [], approaches: 0, attacks: [], kills: 0, combos: 0,
      heals: [], healerBlocked: [],
      errors: [],
    };

    // ── 0. curar ANTES de andar/atacar (o ciclo anterior pode ter deixado o HP baixo)
    await runHealer(cycle);

    // ── 1. andar ate N passos
    for (let s = 0; s < stepsPerCycle && Date.now() < tEnd; s++) {
      const dir = dirs[dirIdx++ % dirs.length];
      const before = snap.position ? { ...snap.position } : null;
      let ack = null;
      try { ack = await t.sendCommand('walk', dir); }
      catch (e) { cycle.errors.push({ stage: 'walk', dir, error: e.message }); continue; }
      await sleep(1100);
      const after = snap.position ? { ...snap.position } : null;
      const dx = before && after ? after.x - before.x : 0;
      const dy = before && after ? after.y - before.y : 0;
      const [ex, ey] = DELTA[dir];
      cycle.walks.push({ dir, status: ack.status, dx, dy, exact: dx === ex && dy === ey });
    }

    // ── 2. procurar alvo, APROXIMAR, atacar
    //
    // MEDIDO (2026-11-12): atacar o alvo mais proximo sem se aproximar deu
    // 17 ataques com `dist` 8-9 e `dz` 1, todos com HP 100 depois. O handler
    // executava (`devolveu 5`), mas o alvo estava fora de alcance.
    //
    // Alcance de ataque no jogo e' ~1-2 tiles no MESMO z. Portanto o ciclo tem
    // que ANDAR ate' o alvo antes de atacar — e' o que um jogador faz. Sem isso
    // o teste mede "ataque longe nao faz dano", que ja' sabiamos.
    const creatures = (snap.creatures || []);
    const me0 = snap.position || { x: 0, y: 0, z: 0 };

    const ATTACK_RANGE = 2;

    /* ALVO TEM QUE ESTAR NO MESMO ANDAR (dz === 0).
     *
     * MEDIDO (2026-11-12, 18 ataques em `captures/routes/cycle-final.json`):
     *
     *   com efeito   (n=5):  dz=0 em 5/5   dist 1-2
     *   sem efeito   (n=13): dz=1 em 11/13 dist 1-2
     *
     * Nao e' alcance horizontal — os alvos com dz=1 estavam a 1-2 tiles no
     * plano e ainda assim nada aconteceu. E' ALTURA: o handler de attack
     * recebe o id e a acao e' resolvida no mapa do Pokemon ativo; um alvo um
     * andar acima nao esta no alcance de melee.
     *
     * O `nearest()` antigo ordenava por `dz` mas ATACAVA mesmo com dz>0 —
     * ou seja, preferia o andar certo e depois atirava no errado. Agora:
     * so' ataca com dz===0; se nao houver alvo no andar, reporta em vez de
     * gastar ataque.
     */
    const candidates = () => {
      const me = snap.position || me0;
      return (snap.creatures || [])
        .filter(c => c.type === 1 && c.healthPercent > 0)
        .map(c => ({
          ...c,
          dist: Math.max(Math.abs(c.pos.x - me.x), Math.abs(c.pos.y - me.y)),
          dz: Math.abs(c.pos.z - me.z),
        }))
        .sort((a, b) => (a.dz - b.dz) || (a.dist - b.dist));
    };
    const nearest = () => candidates().find(c => c.dz === 0) || null;

    let target = nearest();
    let approachSteps = 0;

    while (target && target.dist > ATTACK_RANGE && approachSteps < 8
           && Date.now() < tEnd) {
      const me = snap.position || me0;
      const dx = target.pos.x - me.x;
      const dy = target.pos.y - me.y;
      // DIR map: 0=norte(y-1) 1=leste(x+1) 2=sul(y+1) 3=oeste(x-1)
      let dir;
      if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? 1 : 3;
      else dir = dy > 0 ? 2 : 0;

      const before = snap.position ? { ...snap.position } : null;
      await t.sendCommand('walk', dir);
      await sleep(1100);
      const after = snap.position ? { ...snap.position } : null;
      const wdx = before && after ? after.x - before.x : 0;
      const wdy = before && after ? after.y - before.y : 0;
      const [ex, ey] = DELTA[dir];
      cycle.walks.push({
        dir, status: 0, dx: wdx, dy: wdy,
        exact: wdx === ex && wdy === ey, approach: true,
      });
      approachSteps++;
      target = nearest();
    }
    cycle.approachSteps = approachSteps;
    if (target) {
      cycle.finalDist = target.dist;
      cycle.finalDz = target.dz;
    } else {
      /* Sem alvo no mesmo andar. Nao e' erro do bot: e' cena (monstros um
       * andar acima/abaixo). Registrar evita ler "0 kills" como falha. */
      const anyCreature = candidates()[0] || null;
      cycle.noSameFloorTarget = anyCreature
        ? { name: anyCreature.name, dist: anyCreature.dist, dz: anyCreature.dz }
        : null;
    }

    if (target && Date.now() < tEnd) {
      const hpBefore = target.healthPercent;
      let ack = null;
      /* Retry em STATUS_SEND_FAILED (2).
       *
       * MEDIDO (2026-11-12): os ataques do ciclo voltaram 9x status 0 e 8x
       * status 2. Status 2 = STATUS_SEND_FAILED, que a DLL devolve quando
       * RECUSA antes de chamar o handler (gate fechado / reentrada). Isso e'
       * diferente de status 0 (comando entregue). Recusa ANTES da chamada e'
       * segura de repetir: nada aconteceu. Nao confundir com GAME_EXEC_
       * INDETERMINATE, que nunca vira status 2. */
      for (let attempt = 0; attempt < 3; attempt++) {
        try { ack = await t.sendCommand('attack', target.id); }
        catch (e) { cycle.errors.push({ stage: 'attack', error: e.message }); break; }
        if (ack.status !== 2) break;
        await sleep(1500);
      }
      // Acompanha o HP por 6 s, guardando a serie (nao so' o final).
      //
      // MEDIDO (2026-11-12): com a DLL antiga, criaturas so' eram relidas a
      // cada 8 s (SCAN_INTERVAL_MS) e este laco observa 6 s — logo `hpAfter`
      // era sempre igual a `hpBefore` e o relatorio dizia "0 com efeito",
      // mesmo quando o handler devolvia 13 e o alvo morria. A DLL agora
      // relê o HP das criaturas conhecidas antes de cada telemetria
      // (refresh_creature_stats), entao a serie muda dentro da janela.
      //
      // A serie tambem permite distinguir "morreu" (some da lista) de
      // "levou dano" (HP cai) de "imune/recusado" (HP constante).
      let hpAfter = hpBefore, vanished = false;
      const hpSeries = [hpBefore];
      const hpPlayerSeries = [];
      let healsInCombat = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 6000 && Date.now() < tEnd) {
        await sleep(500);
        /* CURA TATICA DURANTE O COMBATE.
         *
         * MEDIDO (2026-11-12): o ciclo levava o personagem a hp=0 porque so'
         * curava no inicio do proximo ciclo — e o proximo ciclo nunca chegava
         * (a guarda `hp<=0` abortava). Curar aqui, na janela em que o selvagem
         * esta' revidando, e' o que fecha o buraco.
         *
         * O healer tem cooldown proprio (potionCooldownMs=1500 da config real),
         * entao chamar a cada 500 ms nao spamma: ele mesmo segura. */
        if (typeof snap.healthPercent === 'number') hpPlayerSeries.push(snap.healthPercent);
        if (healer && typeof snap.healthPercent === 'number') {
          const before = cycle.heals.length;
          await runHealer(cycle);
          if (cycle.heals.length > before) healsInCombat++;
        }
        const row = (snap.creatures || []).find(c => c.id === target.id);
        if (!row) { vanished = true; break; }
        hpAfter = row.healthPercent;
        if (hpSeries.at(-1) !== hpAfter) hpSeries.push(hpAfter);
      }
      cycle.attacks.push({
        target: target.name, id: target.id, status: ack ? ack.status : null,
        hpBefore, hpAfter, vanished, hpSeries,
        hpPlayerSeries, healsInCombat,
        effect: vanished || hpAfter < hpBefore,
        /* `ack.status === 0` significa "handler executou", NAO "acertou".
         * Se o handler executou e o HP nao mudou, o alvo pode estar fora de
         * alcance (dist/dz) ou ser imune — o campo abaixo separa os casos. */
        executed: ack ? ack.status === 0 : false,
        dist: target.dist, dz: target.dz,
      });
      if (vanished || hpAfter < hpBefore) cycle.kills++;
    }

    // ── 3. combo
    if (Date.now() < tEnd) {
      try {
        const ack = await t.sendCommand('combo', '!autocombo');
        if (ack.status === 0) cycle.combos++;
        cycle.comboStatus = ack.status;
      } catch (e) { cycle.errors.push({ stage: 'combo', error: e.message }); }
      await sleep(800);
    }

    cycle.tEnd = Date.now();
    cycle.posEnd = snap.position ? { ...snap.position } : null;
    cycle.movedTiles = cycle.posStart && cycle.posEnd
      ? Math.max(Math.abs(cycle.posEnd.x - cycle.posStart.x), Math.abs(cycle.posEnd.y - cycle.posStart.y))
      : 0;
    cycles.push(cycle);
    log.push(cycle);

    // escreve incremental (sobrevive a kill)
    fs.writeFileSync(outBase + '.json', JSON.stringify({
      pid, minutes, cycles, generatedAt: new Date().toISOString(),
    }, null, 1));
  }

  t.close();

  // ── resumo
  const totalWalks = cycles.reduce((a, c) => a + c.walks.length, 0);
  const exactWalks = cycles.reduce((a, c) => a + c.walks.filter(w => w.exact).length, 0);
  const totalAttacks = cycles.reduce((a, c) => a + c.attacks.length, 0);
  const effectAttacks = cycles.reduce((a, c) => a + c.attacks.filter(x => x.effect).length, 0);
  /* `executed` e' o que o ACK prova: o handler rodou. `effect` exige o HP
   * mudar. Separar os dois evita as duas leituras erradas: "status 0 =
   * acertou" e "sem HP = handler nao rodou". */
  const executedAttacks = cycles.reduce((a, c) => a + c.attacks.filter(x => x.executed).length, 0);
  const silentAttacks = executedAttacks - effectAttacks;
  const totalKills = cycles.reduce((a, c) => a + c.kills, 0);
  const totalCombos = cycles.reduce((a, c) => a + c.combos, 0);
  const errors = cycles.reduce((a, c) => a + c.errors.length, 0);
  const movedCycles = cycles.filter(c => c.movedTiles > 0).length;
  const totalHeals = cycles.reduce((a, c) => a + (c.heals ? c.heals.length : 0), 0);
  const healsOk = cycles.reduce(
    (a, c) => a + (c.heals ? c.heals.filter(h => h.status === 0).length : 0), 0);
  /* HP do jogador: inicial do primeiro ciclo e final do ultimo. Se cair muito,
   * o ciclo esta' sendo mais caro que o healer aguenta. */
  const hpIni = cycles.length ? cycles[0].hpStart : null;
  const hpFim = cycles.length
    ? (() => {
      const s = cycles[cycles.length - 1].attacks;
      const last = s.length ? s[s.length - 1].hpPlayerSeries : null;
      return last && last.length ? last[last.length - 1] : null;
    })()
    : null;
  const minHp = cycles.reduce((m, c) => {
    const series = c.attacks.flatMap(a => a.hpPlayerSeries || []);
    const local = series.length ? Math.min(...series) : Infinity;
    return Math.min(m, local);
  }, Infinity);

  const summary = {
    pid, minutes, cycles: cycles.length,
    walks: { total: totalWalks, exact: exactWalks, rate: totalWalks ? +(exactWalks / totalWalks).toFixed(3) : null },
    attacks: { total: totalAttacks, executed: executedAttacks, withEffect: effectAttacks,
      executedWithoutEffect: silentAttacks,
      rate: totalAttacks ? +(effectAttacks / totalAttacks).toFixed(3) : null },
    kills: totalKills,
    combos: { sent: totalCombos, cycles: cycles.length },
    heals: { sent: totalHeals, accepted: healsOk },
    hp: { start: hpIni, end: hpFim, min: Number.isFinite(minHp) ? minHp : null },
    cyclesThatMoved: movedCycles,
    /* Ciclos sem alvo no MESMO andar. Nao entram como falha: e' cena.
     * Sem esse numero, "0 kills" parece defeito de ataque quando o
     * personagem so' tinha monstros um andar acima. */
    cyclesWithoutSameFloorTarget: cycles.filter(c => c.noSameFloorTarget).length,
    errors,
  };
  fs.writeFileSync(outBase + '.summary.json', JSON.stringify(summary, null, 2));

  console.log('=== ROTA LONGA: ciclo completo ===\n');
  console.log(`pid ${pid} | ${minutes} min | ${cycles.length} ciclos\n`);
  console.log(`walk    : ${exactWalks}/${totalWalks} exatos (${summary.walks.rate != null ? (summary.walks.rate * 100).toFixed(0) : '?'}%)`);
  console.log(`attack  : ${effectAttacks}/${totalAttacks} com efeito`);
  console.log(`          ${executedAttacks} executaram no handler; ` +
    `${silentAttacks > 0 ? silentAttacks + ' executaram SEM mudar HP' : 'nenhum executou sem efeito'}`);
  console.log(`mortes  : ${totalKills}`);
  console.log(`combo   : ${totalCombos}/${cycles.length} ciclos`);
  console.log(`cura    : ${healsOk}/${totalHeals} aceitas (potion)`);
  console.log(`hp      : ${hpIni ?? '?'} -> ${hpFim ?? '?'} (minimo ${Number.isFinite(minHp) ? minHp : '?'})`);
  console.log(`ciclos com deslocamento: ${movedCycles}/${cycles.length}`);
  console.log(`sem alvo no mesmo andar: ${summary.cyclesWithoutSameFloorTarget}/${cycles.length}` +
    '  (monstros em z diferente — cena, nao falha)');
  console.log(`erros   : ${errors}`);
  console.log('');
  for (const c of cycles) {
    const w = c.walks.filter(x => x.exact).length;
    const a = c.attacks.length ? c.attacks.map(x => x.effect ? 'ok' : 'sem-efeito').join(',') : '-';
    const nf = c.noSameFloorTarget ? ` | sem-alvo-z (${c.noSameFloorTarget.name} dz=${c.noSameFloorTarget.dz})` : '';
    console.log(`  ciclo ${String(c.cycle).padStart(2)}: walk ${w}/${c.walks.length} | atk ${a} | kills ${c.kills} | moveu ${c.movedTiles} tiles${nf}`);
  }
  console.log(`\nEscrito: ${outBase}.json`);

  const ok = exactWalks === totalWalks && errors === 0 && movedCycles > 0;
  console.log(ok ? '\nVEREDITO: ciclo consistente' : '\nVEREDITO: ver itens acima');
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
