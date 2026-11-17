'use strict';

/**
 * Ponte entre o bot e o dispatcher nativo do jogo.
 *
 * PROBLEMA QUE RESOLVE
 * O canal do fornecedor nao aceita comando de ataque (kind 9 = 0 em 105 mil
 * frames medidos). O combate roda dentro da DLL injetada, via dispatcher
 * nativo. Este modulo expoe esse dispatcher com a mesma cara do transporte
 * que o botfinal ja usa.
 *
 * CADEIA (research/shiba_tap/DISPATCH_LIVE.md)
 *   msftedit+0x15280(ecx = targetId, dl = 0 attack / 1 follow) -> al
 *
 * TRANSPORTE
 *   O `pka_attack_loop.dll` injetado no jogo faz polling de
 *   `native/pka_attack_target.txt` no formato `<id>,<mode>,<counter>` e chama o
 *   dispatcher quando o counter muda. A confirmacao vem do log
 *   `%TEMP%/pka_attack_loop.log`.
 *
 * USO
 *   const { NativeBridge } = require('./native-bridge.cjs');
 *   const bridge = new NativeBridge({ pid, nativeDir, tapFile });
 *   await bridge.ready();
 *   await bridge.attack(targetId);
 *
 * O modulo NAO escreve em botfinal/ nem reconstruction/. Para plugar, o agente
 * do bot passa esta instancia no lugar do transporte de comando.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tailLines } = require(path.resolve(__dirname, '..', '..', 'tools', 'tail_jsonl.cjs'));

const TARGET_FILE = 'pka_attack_target.txt';
const LOOP_CONFIG = 'pka_attack_loop_config.txt';
const LOOP_LOG = path.join(os.tmpdir(), 'pka_attack_loop.log');

class NativeBridge {
  constructor(options = {}) {
    if (!Number.isInteger(options.pid) || options.pid <= 0) {
      throw Error('pid invalido');
    }
    this.pid = options.pid;
    this.nativeDir = options.nativeDir
      || path.resolve(__dirname, '..', '..', 'native');
    this.tapFile = options.tapFile || this.findTapFile();
    this.targetFile = path.join(this.nativeDir, TARGET_FILE);
    this.counter = this.readCounter();
    this.timeoutMs = options.timeoutMs ?? 2000;
    /* telemetria mais velha que isso nao serve para atacar: a criatura pode ter\n     * morrido ou saido de alcance, e o dispatch retornaria 0 sem efeito. */
    this.maxAgeMs = options.maxAgeMs ?? 5000;
    /* permite apontar para outro log (testes isolam do log real) */
    this.loopLog = options.loopLog || LOOP_LOG;
    this.lastAttack = null;
  }

  findTapFile() {
    if (!fs.existsSync(this.nativeDir)) return null;
    const name = `pka_tap_${this.pid}.jsonl`;
    const file = path.join(this.nativeDir, name);
    return fs.existsSync(file) ? file : null;
  }

  /** Mantem o contador entre execucoes: o loop so' chama quando ele muda. */
  readCounter() {
    try {
      const parts = fs.readFileSync(this.targetFile, 'utf8').trim().split(',');
      const value = Number(parts[2]);
      return Number.isFinite(value) ? value : 0;
    } catch { return 0; }
  }

  /** O loop esta' injetado e escutando? */
  ready() {
    if (!this.tapFile || !fs.existsSync(this.tapFile)) {
      return { ready: false, reason: 'tap ausente para o pid ' + this.pid };
    }
    const config = path.join(this.nativeDir, LOOP_CONFIG);
    if (!fs.existsSync(config)) {
      return { ready: false, reason: 'falta ' + LOOP_CONFIG + ' (rode tools/build_native)' };
    }
    const log = this.readLoopLog();
    if (!log.includes('loop up')) {
      return {
        ready: false,
        reason: 'pka_attack_loop.dll nao injetado — rode:\n'
          + `  native\\pka_inject.exe --pid ${this.pid} --dll native\\pka_attack_loop.dll`,
      };
    }
    return { ready: true, reason: 'loop armado', tapFile: this.tapFile };
  }

  readLoopLog() {
    const file = this.loopLog || LOOP_LOG;
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  }

  /**
   * Ultima telemetria com creatures[] do tap.
   *
   * Procura em janelas crescentes: a telemetria e' intermitente (o fornecedor
   * as vezes passa minutos sem publicar), e olhar so' as ultimas 600 linhas
   * devolve null mesmo com dado fresco disponivel um pouco antes. Cada kind 4/6
   * sai a ~6/s, entao 600 linhas = ~50 s; 40000 linhas cobrem ~1 h.
   */
  snapshot() {
    if (!this.tapFile || !fs.existsSync(this.tapFile)) return null;
    for (const window of [800, 4000, 20000, 60000]) {
      const lines = tailLines(this.tapFile, window);
      if (!lines.length) continue;
      for (let i = lines.length - 1; i >= 0; i--) {
        let record;
        try { record = JSON.parse(lines[i]); } catch { continue; }
        if (record.kind !== 5 || record.trunc || !record.d) continue;
        try {
          const data = JSON.parse(Buffer.from(record.d, 'hex').toString('utf8'));
          if (!Array.isArray(data.creatures)) continue;
          /* record.t vem de GetTickCount (ms desde o boot), nao de Date.now().
           * ageMs = agora (mesma base) - t do frame. */
          return { t: record.t, ageMs: getTickCount() - record.t, ...data };
        } catch { /* payload cortado, segue */ }
      }
      /* achou a janela que contem telemetria? nao precisa varrer mais */
      if (window >= 4000) break;
    }
    return null;
  }

  /** Criaturas hostis vivas, ordenadas pela proximidade do player. */
  hostiles(maxAgeMs = this.maxAgeMs) {
    const snapshot = this.snapshot();
    if (!snapshot) return [];
    if (Number.isFinite(maxAgeMs) && snapshot.ageMs > maxAgeMs) return [];
    const player = snapshot.position;
    const list = snapshot.creatures.filter(c => c
      && c.type === 1
      && c.canAttack === true
      && Number.isFinite(c.healthPercent) && c.healthPercent > 0
      && Number.isFinite(c.id) && c.id > 0);
    if (player && Number.isFinite(player.x) && Number.isFinite(player.y)) {
      list.sort((a, b) => {
        const da = Math.abs((a.pos?.x ?? 1e9) - player.x)
          + Math.abs((a.pos?.y ?? 1e9) - player.y);
        const db = Math.abs((b.pos?.x ?? 1e9) - player.x)
          + Math.abs((b.pos?.y ?? 1e9) - player.y);
        return da - db;
      });
    }
    return list;
  }

  /**
   * Ataca um alvo pelo id. Devolve { status, dispatched, verified, elapsedMs }.
   *
   * status segue o vocabulario do protocolo do fornecedor:
   *   0 = despachado
   *   1 = entrada invalida (id nao inteiro positivo)
   *   2 = bridge nao pronta
   *   3 = runtime do jogo nao despachou (ready=0, alvo morto, entidade sumiu)
   */
  async attack(targetId, options = {}) {
    if (!Number.isInteger(targetId) || targetId <= 0) {
      return { status: 1, dispatched: false, verified: false, message: 'targetId invalido' };
    }
    const state = this.ready();
    if (!state.ready) {
      return { status: 2, dispatched: false, verified: false, message: state.reason };
    }

    const mode = options.mode === 'follow' ? 1 : 0;
    const before = this.readLoopLog().length;
    this.counter += 1;
    fs.writeFileSync(this.targetFile, `${targetId},${mode},${this.counter}`, 'ascii');
    const startedAt = Date.now();

    /* espera o loop registrar a chamada */
    const deadline = startedAt + this.timeoutMs;
    let line = null;
    while (Date.now() < deadline) {
      const text = this.readLoopLog();
      const fresh = text.slice(before);
      const match = fresh.match(new RegExp(`call id=${targetId} mode=${mode} -> (\\d)`));
      if (match) {
        line = { result: Number(match[1]), text: fresh };
        break;
      }
      const skip = fresh.match(new RegExp(`SKIP id=${targetId}`));
      if (skip) {
        line = { result: null, text: fresh };
        break;
      }
      await sleep(40);
    }

    const elapsedMs = Date.now() - startedAt;
    if (!line) {
      return { status: 3, dispatched: false, verified: false, elapsedMs,
        message: 'loop nao respondeu em ' + this.timeoutMs + 'ms' };
    }
    if (line.result === null) {
      return { status: 3, dispatched: false, verified: false, elapsedMs,
        message: 'runtime recusou (ready/reentry/base)' };
    }
    this.lastAttack = { targetId, mode, result: line.result, elapsedMs, at: Date.now() };
    if (line.result === 0) {
      /* despachou mas o handler devolveu 0: alvo invalido ou sem efeito */
      return { status: 3, dispatched: true, verified: false, elapsedMs,
        message: 'dispatcher retornou 0 (alvo invalido ou sem efeito)' };
    }
    return { status: 0, dispatched: true, verified: false, elapsedMs,
      message: 'despachado' };
  }

  /** Ataca o hostil mais proximo. Devolve null se nao houver alvo. */
  async attackNearest(options = {}) {
    const list = this.hostiles();
    if (!list.length) return null;
    const target = list[0];
    const result = await this.attack(target.id, options);
    return { ...result, target: { id: target.id, name: target.name,
      hp: target.healthPercent, pos: target.pos } };
  }
}

/** GetTickCount equivalente em Node: ms desde o boot do sistema. */
function getTickCount() {
  /* GetTickCount = ms desde o boot do sistema; os.uptime() usa a mesma base */
  return Math.round(os.uptime() * 1000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { NativeBridge, TARGET_FILE, LOOP_CONFIG, LOOP_LOG };





