'use strict';

/**
 * Coletor de contexto de execução — o que roda e em qual thread.
 *
 *   node tools/trace_exec_context.cjs                                  (plano)
 *   node tools/trace_exec_context.cjs --self-test                      (valida o coletor)
 *   node tools/trace_exec_context.cjs --pid <PID> --verify-ranges      (identidade + bytes)
 *   node tools/trace_exec_context.cjs --pid <PID> --run --seconds 20   (coleta curta)
 *
 * ---------------------------------------------------------------------------
 * 1. COMO O CONTEXTO É OBTIDO, E O CUSTO DISSO
 * ---------------------------------------------------------------------------
 *   Por thread, por amostra:
 *     SuspendThread(tid)                        <- thread PARA
 *     GetThreadContext(tid, CONTEXT)            <- leitura
 *     ResumeThread(tid)                         <- thread VOLTA (finally)
 *
 *   Isto NÃO é leitura sem interferência. Cada suspensão congela a thread por
 *   um instante. Se essa thread segura um lock que outra precisa, quem espera
 *   trava até o ResumeThread. Por isso:
 *     - a janela é mínima: nenhuma alocação, nenhum syscall além do
 *       GetThreadContext, nenhuma formatação de string entre suspender e
 *       retomar;
 *     - `ResumeThread` está em `finally` incondicional. Caminho de exceção,
 *       falha de leitura, KeyboardInterrupt: todos retomam;
 *     - `ResumeThread` devolve a contagem anterior de suspensão; 0xFFFFFFFF é
 *       falha e é CONTADO (`resumeFailures`);
 *     - `SuspendThread` devolve a contagem anterior; 0xFFFFFFFF é falha e é
 *       CONTADO (`suspendFailures`). Contagem anterior > 0 significa que a
 *       thread já estava suspensa por outra coisa — nosso ResumeThread apenas
 *       desfaz a NOSSA suspensão, não mexe na de outro;
 *     - duração real de cada janela é medida (`perf_counter_ns`) e reportada
 *       em `interference`. Não é "grátis";
 *     - o pior caso que sobra: se ESTE processo Python morrer entre
 *       SuspendThread e ResumeThread, a thread fica suspensa e o jogo congela.
 *       Mitigação: janela de microssegundos e o processo vive até o fim do
 *       loop. Não há como eliminar esse risco sem patch, e patch é pior.
 *
 * ---------------------------------------------------------------------------
 * 2. O QUE O SELF-TEST PROVA (três coisas diferentes)
 * ---------------------------------------------------------------------------
 *   A. LEITURA      — GetThreadContext retorna sucesso e RIP != 0.
 *   B. IDENTIDADE   — a thread amostrada é a que criamos (TID confere) E o RIP
 *                     cai dentro de um módulo CONHECIDO (kernel32.dll), cujo
 *                     intervalo vem do loader, não das amostras.
 *   C. CONTROLE NEGATIVO — classificar contra uma faixa que sabemos não conter
 *                     o RIP tem que dar ZERO. Prova que `classify()` não
 *                     responde "true" sempre.
 *
 *   O self-test antigo fazia só (A) e ainda validava a classificação contra
 *   uma faixa derivada do min/max das próprias amostras — circular. Não provava
 *   identificação de thread nem faixa real.
 *
 * ---------------------------------------------------------------------------
 * 3. CONTADORES SEPARADOS (nunca colapsar)
 * ---------------------------------------------------------------------------
 *   contextAttempts      tentativas de GetThreadContext
 *   contextValid         sucesso, RIP != 0
 *   contextFailures      GetThreadContext retornou FALSE
 *   suspendFailures      SuspendThread retornou 0xFFFFFFFF
 *   resumeFailures       ResumeThread retornou 0xFFFFFFFF
 *   openFailures         OpenThread falhou
 *   ripOutsideModule     RIP fora da imagem do jogo (ntdll, kernel32, GPU, ...)
 *   ripInModuleOutsideRanges  RIP dentro da imagem, mas em nenhuma das faixas
 *   ripInRanges          RIP dentro de uma faixa observada  <- o único que conta
 *
 *   `contextFailures === 0` NÃO significa que o caminho foi observado. Só
 *   `ripInRanges > 0` significa. E `ripInRanges === 0` com contadores limpos é
 *   INCONCLUSIVO, não negativo: uma função curta pode nunca cair numa amostra.
 *
 * ---------------------------------------------------------------------------
 * 4. IDENTIDADE ANTES DE COLETAR
 * ---------------------------------------------------------------------------
 *   `--run` sempre faz o bloco de identidade primeiro: PID, caminho do exe,
 *   arquitetura (WOW64 aborta), base/tamanho do módulo, PE TimeDateStamp,
 *   SizeOfImage, e os 8 bytes de cada faixa comparados com o build de
 *   referência gravado em `REFERENCE_BUILD`. Build diferente → recusa rodar,
 *   a menos que `--force`. PID e endereço absoluto da sessão anterior nunca são
 *   reaproveitados: base é relida do loader a cada execução.
 *
 * ---------------------------------------------------------------------------
 * 5. TIDs × windowThreads
 * ---------------------------------------------------------------------------
 *   O JSON traz as threads donas de janela visível. Comparar serve para LEVANTAR
 *   hipótese:
 *     coincidência -> "o caminho pode rodar no message loop"; não prova
 *                     scheduler, não prova que outro caminho não exista;
 *     divergência  -> "o caminho roda fora do message loop"; não é erro, é
 *                     informação sobre onde o despacho teria que ser postado.
 *   Nenhum dos dois é veredito.
 *
 * ---------------------------------------------------------------------------
 * O QUE ESTE ARQUIVO NÃO FAZ
 * ---------------------------------------------------------------------------
 *   - não instala patch ou hook
 *   - não chama função do jogo
 *   - não move o personagem
 *   - não captura foco
 *   - não envia tecla
 *   - não escreve no processo (só PROCESS_VM_READ)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'local-data');

/* ---------------------------------------------------------------------------
 * Build de referência. Fonte dos bytes: evidência
 *   local-data/trace-exec-2026-11-06T15-13-57-599Z.json
 * Não é verdade eterna: qualquer patch do jogo invalida. O `--verify-ranges`
 * compara e diz exatamente qual faixa mudou.
 * ------------------------------------------------------------------------ */
const REFERENCE_BUILD = Object.freeze({
  source: 'local-data/trace-exec-2026-11-06T15-13-57-599Z.json',
  module: 'pokealliance_dx.exe',
  process: 'pokealliance_dx.exe',
  ranges: Object.freeze([
    { name: 'wrapper-setWalkActive', start: 0x7b4740, end: 0x7b47b7, head: '40534883ec20448b' },
    { name: 'Game::walk', start: 0x77f250, end: 0x77f844, head: '48895c2408555657' },
    { name: 'lambda-autowalk-tick', start: 0x996b00, end: 0x996bf0, head: '488d05b96b9501c3' },
    { name: 'startAutoWalkLoop', start: 0x7b47c0, end: 0x7b4a48, head: '4055535657488d6c' },
    { name: 'stopAutoWalk', start: 0x7b4a50, end: 0x7b4af3, head: '48895c2408574883' },
    { name: 'setDirection-and-call', start: 0x7b6ed0, end: 0x7b6f4c, head: '48895c2408574883' },
    { name: 'input-direction-calc', start: 0x37973f, end: 0x379809, head: '01f30f1015e460f0' },
    { name: 'input-apply-dir', start: 0x744a80, end: 0x744b80, head: '4055535657415441' },
  ]),
});

const RANGES = REFERENCE_BUILD.ranges.map(r => ({
  name: r.name, start: r.start, end: r.end,
}));

const DEFAULT_SECONDS = 20;
const DEFAULT_INTERVAL_MS = 10;
const MAX_SECONDS = 120;
const INF_MS = Number.POSITIVE_INFINITY;

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const valueOf = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const PID = Number(valueOf('--pid'));
const RUN = flag('--run');
const VERIFY = flag('--verify-ranges');
const SELF_TEST = flag('--self-test');
const FORCE = flag('--force');
const MODULE = valueOf('--module') || REFERENCE_BUILD.module;
const RANGES_FILE = valueOf('--ranges');

/* Faixas por build. O build de referência envelhece; quando o cliente é
 * atualizado, `--verify-ranges` acusa e é preciso um arquivo de faixas novo.
 * Formato: { "module": "...", "ranges": [{name,start,end,head,verifiedAs}] }
 * `start`/`end` em RVA hex ou decimal. Entradas com `verified: false` são
 * CARREGADAS mas NÃO usadas para classificar — evitam que uma faixa não
 * confirmada produza um "hit" que não significa nada. */
/* Lê JSON tolerando BOM. Arquivo editado no Windows quase sempre ganha BOM, e
 * JSON.parse não aceita \uFEFF na posição 0. */
function readJsonTolerant(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return JSON.parse(text);
}

function loadRanges(file) {
  const raw = readJsonTolerant(file);
  const list = Array.isArray(raw) ? raw : raw.ranges;
  if (!Array.isArray(list) || !list.length) throw new Error('arquivo de faixas vazio');
  return list.map((r, i) => {
    const start = typeof r.start === 'string' ? parseInt(r.start, 16) : Number(r.start);
    const end = typeof r.end === 'string' ? parseInt(r.end, 16) : Number(r.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
      throw new Error('faixa ' + (r.name || i) + ' invalida');
    }
    return {
      name: String(r.name || ('range' + i)), start, end,
      head: r.head ? String(r.head).toLowerCase() : null,
      verified: r.verified !== false,
      note: r.note || null,
    };
  });
}
const SECONDS = Math.min(Number(valueOf('--seconds')) || DEFAULT_SECONDS, MAX_SECONDS);
const INTERVAL_MS = Number(valueOf('--interval-ms')) || DEFAULT_INTERVAL_MS;
/* Parse numérico sem `||`: 0 é valor válido (aborta em qualquer janela > 0),
 * e `Number(x) || default` engoliria isso. */
const num = (name, fallback) => {
  const raw = valueOf(name);
  if (raw === null) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};
const MAX_SUSPEND_US = num('--max-suspend-us', 2000);
const MAX_FAILURES = num('--max-failures', 5);
const PARTIAL_EVERY = num('--journal-every', 5);
const BUDGET_MS = valueOf('--thread-budget-ms');

let RANGES_JSON = '';
let RANGE_SOURCE_LABEL = 'build de referencia (' + REFERENCE_BUILD.source + ')';
let BUILD_MANIFEST = null;
if (RANGES_FILE) {
  try {
    const raw = readJsonTolerant(RANGES_FILE);
    const loaded = loadRanges(RANGES_FILE);
    RANGES_JSON = JSON.stringify(loaded);
    BUILD_MANIFEST = (raw && raw._build) || null;
    const verified = loaded.filter(r => r.verified).length;
    RANGE_SOURCE_LABEL = RANGES_FILE + '  ('
      + verified + '/' + loaded.length + ' verificadas)';
  } catch (error) {
    console.error('[FALHA] arquivo de faixas: ' + error.message);
    process.exit(2);
  }
}

const PY = String.raw`
import ctypes, json, sys, time, hashlib, os
from ctypes import wintypes

PID = int(sys.argv[1])
SECONDS = float(sys.argv[2])
INTERVAL = float(sys.argv[3]) / 1000.0
VERIFY = sys.argv[4] == '1'
SELF_TEST = sys.argv[5] == '1'
FORCE = sys.argv[6] == '1'
MODULE = sys.argv[7] if len(sys.argv) > 7 else 'pokealliance_dx.exe'
PARTIAL = sys.argv[8] if len(sys.argv) > 8 else ''
MAX_SUSPEND_US = float(sys.argv[9]) if len(sys.argv) > 9 else 2000.0
MAX_FAILURES = int(sys.argv[10]) if len(sys.argv) > 10 else 5
PARTIAL_EVERY = int(sys.argv[11]) if len(sys.argv) > 11 else 5
RUN = len(sys.argv) > 12 and sys.argv[12] == '1'
RANGES_JSON = sys.argv[13] if len(sys.argv) > 13 else ''

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
user32 = ctypes.WinDLL('user32', use_last_error=True)

k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenThread.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.CreateThread.restype = wintypes.HANDLE
k32.SuspendThread.restype = wintypes.DWORD
k32.ResumeThread.restype = wintypes.DWORD
k32.GetThreadContext.restype = wintypes.BOOL
k32.ReadProcessMemory.restype = wintypes.BOOL
k32.IsWow64Process.restype = wintypes.BOOL

k32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.SuspendThread.argtypes = [wintypes.HANDLE]
k32.ResumeThread.argtypes = [wintypes.HANDLE]
k32.GetThreadContext.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
k32.CloseHandle.argtypes = [wintypes.HANDLE]

TH32CS_SNAPTHREAD = 0x00000004
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
THREAD_SUSPEND_RESUME = 0x0002
THREAD_GET_CONTEXT = 0x0008
THREAD_QUERY_INFORMATION = 0x0040
PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
CONTEXT_CONTROL = 0x00100001
CONTEXT_SIZE = 1232                # sizeof(CONTEXT) x64
SUSPEND_FAILED = 0xFFFFFFFF
RESUME_FAILED = 0xFFFFFFFF

class THREADENTRY32(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                ('th32ThreadID', wintypes.DWORD), ('th32OwnerProcessID', wintypes.DWORD),
                ('tpBasePri', ctypes.c_long), ('tpDeltaPri', ctypes.c_long),
                ('dwFlags', wintypes.DWORD)]

class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('th32ModuleID', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('GlblcntUsage', wintypes.DWORD),
                ('ProccntUsage', wintypes.DWORD), ('modBaseAddr', ctypes.c_void_p),
                ('modBaseSize', wintypes.DWORD), ('hModule', wintypes.HMODULE),
                ('szModule', wintypes.WCHAR * 256), ('szExePath', wintypes.WCHAR * 260)]

class CONTEXT(ctypes.Structure):
    """Layout AMD64 até Rip (256 B) + cauda opaca até 1232 B.
    GetThreadContext escreve sizeof(CONTEXT) bytes; buffer menor falha sempre."""
    _fields_ = [
        ('P1Home', ctypes.c_ulonglong), ('P2Home', ctypes.c_ulonglong),
        ('P3Home', ctypes.c_ulonglong), ('P4Home', ctypes.c_ulonglong),
        ('P5Home', ctypes.c_ulonglong), ('P6Home', ctypes.c_ulonglong),
        ('ContextFlags', wintypes.DWORD), ('MxCsr', wintypes.DWORD),
        ('SegCs', wintypes.WORD), ('SegDs', wintypes.WORD), ('SegEs', wintypes.WORD),
        ('SegFs', wintypes.WORD), ('SegGs', wintypes.WORD), ('SegSs', wintypes.WORD),
        ('EFlags', wintypes.DWORD),
        ('Dr0', ctypes.c_ulonglong), ('Dr1', ctypes.c_ulonglong),
        ('Dr2', ctypes.c_ulonglong), ('Dr3', ctypes.c_ulonglong),
        ('Dr6', ctypes.c_ulonglong), ('Dr7', ctypes.c_ulonglong),
        ('Rax', ctypes.c_ulonglong), ('Rcx', ctypes.c_ulonglong),
        ('Rdx', ctypes.c_ulonglong), ('Rbx', ctypes.c_ulonglong),
        ('Rsp', ctypes.c_ulonglong), ('Rbp', ctypes.c_ulonglong),
        ('Rsi', ctypes.c_ulonglong), ('Rdi', ctypes.c_ulonglong),
        ('R8', ctypes.c_ulonglong), ('R9', ctypes.c_ulonglong),
        ('R10', ctypes.c_ulonglong), ('R11', ctypes.c_ulonglong),
        ('R12', ctypes.c_ulonglong), ('R13', ctypes.c_ulonglong),
        ('R14', ctypes.c_ulonglong), ('R15', ctypes.c_ulonglong),
        ('Rip', ctypes.c_ulonglong),
        ('Tail', ctypes.c_ubyte * (CONTEXT_SIZE - 256)),
    ]

assert ctypes.sizeof(CONTEXT) == CONTEXT_SIZE, 'sizeof(CONTEXT) != 1232'

def aligned_context():
    """CONTEXT alinhado em 16 B (exigência do kernel x64) + ponteiro tipado."""
    raw = ctypes.create_string_buffer(CONTEXT_SIZE + 16)
    addr = ctypes.addressof(raw)
    pad = (16 - (addr % 16)) % 16
    ptr = ctypes.cast(addr + pad, ctypes.POINTER(CONTEXT))
    ptr.contents.ContextFlags = CONTEXT_CONTROL
    return raw, ptr

def read_context(th, ctxp):
    """Devolve (ok, rip). ok=False é falha do mecanismo, não ausência de hit."""
    ctxp.contents.ContextFlags = CONTEXT_CONTROL
    if not k32.GetThreadContext(th, ctypes.byref(ctxp.contents)):
        return False, 0
    rip = int(ctxp.contents.Rip)
    return (rip != 0), rip

class SuspensionStats:
    """Duração de cada janela de suspensão. Isto é o custo de interferência."""
    __slots__ = ('calls', 'total_ns', 'max_ns', 'min_ns', 'suspend_fail',
                 'resume_fail', 'read_fail', 'read_ok', 'per_tid', 'per_tidmax')

    def __init__(self):
        self.calls = 0; self.total_ns = 0; self.max_ns = 0; self.min_ns = None
        self.suspend_fail = 0; self.resume_fail = 0
        self.read_fail = 0; self.read_ok = 0
        self.per_tid = {}; self.per_tidmax = 0

    def add(self, dur):
        self.calls += 1; self.total_ns += dur
        if dur > self.max_ns: self.max_ns = dur
        if self.min_ns is None or dur < self.min_ns: self.min_ns = dur

    def as_dict(self):
        us = lambda ns: None if ns is None else round(ns / 1000.0, 2)
        return {'calls': self.calls, 'suspendFailures': self.suspend_fail,
                'resumeFailures': self.resume_fail,
                'totalSuspendedMs': round(self.total_ns / 1e6, 2),
                'maxSuspendedUs': us(self.max_ns),
                'minSuspendedUs': us(self.min_ns),
                'avgSuspendedUs': us(self.total_ns / self.calls) if self.calls else None,
                # Cada porcao de totalSuspendedMs que uma thread especifica
                # ficou parada. O jogo não distingue "thread do render foi
                # congelada" de "thread ociosa foi congelada".
                'perThreadSuspendedMs': {str(t): round(ns / 1e6, 3)
                                         for t, ns in self.per_tid.items()},
                'maxSingleThreadMs': round(self.per_tidmax / 1e6, 3) if self.per_tidmax else 0.0}

    def add_for(self, tid, dur):
        self.add(dur)
        self.per_tid[tid] = self.per_tid.get(tid, 0) + dur
        if dur > self.per_tidmax:
            self.per_tidmax = dur

def sample_suspended(th, ctxp, stats, tid=None):
    """Suspende, lê, retoma. Devolve um dict de resultado — o estado importa.

      status: 'ok'           leitura válida
              'context-fail' GetThreadContext falhou (retomada FOI feita)
              'suspend-fail' SuspendThread falhou (nada a retomar)
              'resume-fail'  ResumeThread falhou -> chamador DEVE parar tudo

    Retomada: uma única chamada de ResumeThread, no finally, sempre. Não há
    retentativa: SuspendThread devolve a contagem anterior e um ResumeThread
    extra decrementaria a suspensão de terceiros. Se falhar, o fato é
    registrado e o chamador interrompe — nunca "conserta" no laço.
    """
    t0 = time.perf_counter_ns()
    prev = k32.SuspendThread(th)
    if prev == SUSPEND_FAILED:
        stats.suspend_fail += 1
        return {'status': 'suspend-fail', 'tid': tid,
                'err': ctypes.get_last_error(), 'rip': None}

    # prev > 0 => a thread JÁ estava suspensa por outro motivo antes de nós.
    # O nosso ResumeThread desfaz só a NOSSA suspensão.
    already = prev > 0

    ok = False
    rip = 0
    ctx_err = 0
    opened = True
    try:
        ok, rip = read_context(th, ctxp)
        if not ok:
            ctx_err = ctypes.get_last_error()
    finally:
        r = k32.ResumeThread(th)
        dur = time.perf_counter_ns() - t0
        if tid is None:
            stats.add(dur)
        else:
            stats.add_for(tid, dur)
        resume_failed = (r == RESUME_FAILED)
        resume_err = ctypes.get_last_error() if resume_failed else 0
        if resume_failed:
            stats.resume_fail += 1

    if resume_failed:
        # Não tenta de novo. O chamador para imediatamente.
        return {'status': 'resume-fail', 'tid': tid, 'err': resume_err,
                'prevSuspendCount': int(prev), 'alreadySuspended': already,
                'rip': hex(rip) if (ok and rip) else None,
                'note': 'thread pode ter ficado suspensa; NENHUMA retentativa'}
    if ok:
        stats.read_ok += 1
        return {'status': 'ok', 'tid': tid, 'rip': rip,
                'alreadySuspended': already, 'prevSuspendCount': int(prev)}
    stats.read_fail += 1
    # Retomada já ocorreu no finally. Contexto ruim não vira "sem hit".
    return {'status': 'context-fail', 'tid': tid, 'err': ctx_err,
            'alreadySuspended': already, 'rip': None}

def module_base(pid, name):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if not snap or int(snap) == 0xFFFFFFFFFFFFFFFF:
        return 0, 0, ''
    me = MODULEENTRY32W(); me.dwSize = ctypes.sizeof(MODULEENTRY32W)
    out = (0, 0, '')
    if k32.Module32FirstW(ctypes.c_void_p(snap), ctypes.byref(me)):
        while True:
            if me.szModule.lower() == name.lower():
                out = (int(me.modBaseAddr), int(me.modBaseSize), me.szExePath); break
            if not k32.Module32NextW(ctypes.c_void_p(snap), ctypes.byref(me)): break
    k32.CloseHandle(ctypes.c_void_p(snap))
    return out

def threads_of(pid):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    if not snap or int(snap) == 0xFFFFFFFFFFFFFFFF:
        return []
    te = THREADENTRY32(); te.dwSize = ctypes.sizeof(THREADENTRY32)
    out = []
    if k32.Thread32First(ctypes.c_void_p(snap), ctypes.byref(te)):
        while True:
            if te.th32OwnerProcessID == pid:
                out.append(int(te.th32ThreadID))
            if not k32.Thread32Next(ctypes.c_void_p(snap), ctypes.byref(te)): break
    k32.CloseHandle(ctypes.c_void_p(snap))
    return out

def window_threads(pid):
    out = []
    proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, lparam):
        owner = wintypes.DWORD(0)
        tid = user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            tid = int(tid)
            if tid and tid not in out:
                out.append(tid)
        return True
    user32.EnumWindows(proc(cb), 0)
    return out

RANGES = [
    ('wrapper-setWalkActive', 0x7b4740, 0x7b47b7, '40534883ec20448b'),
    ('Game::walk', 0x77f250, 0x77f844, '48895c2408555657'),
    ('lambda-autowalk-tick', 0x996b00, 0x996bf0, '488d05b96b9501c3'),
    ('startAutoWalkLoop', 0x7b47c0, 0x7b4a48, '4055535657488d6c'),
    ('stopAutoWalk', 0x7b4a50, 0x7b4af3, '48895c2408574883'),
    ('setDirection-and-call', 0x7b6ed0, 0x7b6f4c, '48895c2408574883'),
    ('input-direction-calc', 0x37973f, 0x379809, '01f30f1015e460f0'),
    ('input-apply-dir', 0x744a80, 0x744b80, '4055535657415441'),
]

# Faixas fornecidas por arquivo (build novo). So entram as verified:true na
# classificação; as não verificadas são reportadas mas NÃO produzem hit.
RANGES_SOURCE = 'reference'
UNVERIFIED = []
if RANGES_JSON:
    supplied = json.loads(RANGES_JSON)
    keep = []
    for r in supplied:
        name = str(r.get('name', 'range'))
        a = int(r['start']); b = int(r['end'])
        head = (r.get('head') or '').lower()
        if r.get('verified') is False:
            UNVERIFIED.append(name)
            continue
        keep.append((name, a, b, head))
    if not keep:
        print(json.dumps({'ok': False,
                          'error': 'arquivo de faixas nao tem nenhuma verificada'}))
        sys.exit(0)
    RANGES = keep
    RANGES_SOURCE = 'file'

def classify(rva, ranges=None):
    for entry in (ranges or RANGES):
        name, a, b = entry[0], entry[1], entry[2]
        if a <= rva < b:
            return name
    return None

def bucket(rip, base, size, ranges):
    """Única fonte de verdade do balde de um RIP. Usada pela coleta E pelo
    self-test — assim [E] exercita o mesmo caminho de produção, não uma cópia.

    Devolve (kind, rangeName, rva):
      ('outside', None, None)                    RIP fora da imagem
      ('inModuleNoRange', None, rva)             na imagem, sem faixa
      ('inRange', name, rva)                     numa faixa
    """
    if not (base <= rip < base + size):
        return 'outside', None, None
    rva = rip - base
    return ('inRange', classify(rva, ranges), rva) if classify(rva, ranges) \
        else ('inModuleNoRange', None, rva)

# ---------------------------------------------------------------------------
def decide(res, this_us, counters, max_suspend_us, max_failures):
    """DECISÃO PURA do laço, sem I/O. Fonte única usada pela coleta e pelo
    self-test [F] — assim o critério testado é o critério real.

    Devolve (action, stop_reason, resume_fatal) com action em:
      'stop-resume'    ResumeThread falhou -> parar TUDO agora
      'stop-suspend'   janela > orçamento  -> parar
      'stop-suspendfail' suspeitas acumuladas -> parar
      'count-suspendfail' conta e segue
      'count-contextfail' conta e segue (retomada já feita)
      'continue'        nada a decidir aqui
    """
    # 1. ResumeThread falhou: para imediatamente, não espera limite.
    if res['status'] == 'resume-fail':
        counters['resumeFailures'] += 1
        return ('stop-resume',
                'resume-fail: tid=%d err=%d prevSuspend=%d - interrompido na '
                'primeira ocorrencia'
                % (res['tid'], res['err'], res.get('prevSuspendCount', -1)),
                res)

    # 2. Orçamento de janela declarado.
    if this_us > max_suspend_us:
        return ('stop-suspend',
                'suspension-too-long: tid=%d %.0fus > %.0fus (orcamento de '
                'janela declarado)' % (res['tid'], this_us, max_suspend_us),
                None)

    # 3. SuspendThread falhou: conta; só para no teto.
    if res['status'] == 'suspend-fail':
        counters['suspendFailures'] += 1
        if counters['suspendFailures'] >= max_failures:
            return ('stop-suspendfail',
                    'suspend-fail >= %d (ultima: tid=%d err=%d)'
                    % (max_failures, res['tid'], res['err']), None)
        return ('count-suspendfail', None, None)

    # 4. GetThreadContext falhou: conta. A retomada JÁ foi feita no finally.
    if res['status'] == 'context-fail':
        counters['contextFailures'] += 1
        return ('count-contextfail', None, None)

    return ('continue', None, None)

# SELF-TEST: três verificações separadas
# ---------------------------------------------------------------------------
def self_test():
    """Quatro verificações independentes. Nenhuma deriva da outra:

    A. LEITURA        GetThreadContext retorna sucesso e RIP != 0, com janela
                      de suspensão medida.
    B. IDENTIDADE     o TID amostrado é o TID que criamos.
    C. FAIXA CONHECIDA o RIP cai dentro de uma página cujo intervalo NÓS
                      definimos ANTES de qualquer amostra. A primeira tentativa
                      errou aqui: criando a thread em Sleep, o RIP vai para
                      ntdll!NtDelayExecution (syscall), não para o módulo de
                      Sleep. Faixa tem que vir de fora, não de palpite nem da
                      própria amostra.
    D. CONTROLE NEGATIVO classificar contra uma faixa alheia dá zero.
    """
    report = {'read': None, 'identity': None, 'knownModule': None,
              'negativeControl': None, 'verdict': None, 'target': None}

    # Pagina executavel propria com jmp $ (EB FE). A unica instrucao e saltar
    # para si mesma, então o RIP TEM que ficar em base+0 enquanto roda.
    PAGE = 0x1000
    MEM_COMMIT_RESERVE = 0x3000
    PAGE_EXECUTE_READWRITE = 0x40
    MEM_RELEASE = 0x8000
    k32.VirtualAlloc.restype = ctypes.c_void_p
    k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
                                 wintypes.DWORD, wintypes.DWORD]
    k32.VirtualFree.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
    page = k32.VirtualAlloc(None, PAGE, MEM_COMMIT_RESERVE, PAGE_EXECUTE_READWRITE)
    if not page:
        report['read'] = {'ok': False, 'reason': 'VirtualAlloc falhou'}
        report['verdict'] = {'ok': False, 'reason': 'sem pagina de teste'}
        return report
    page = int(page)
    ctypes.memmove(ctypes.c_void_p(page), b'\xEB\xFE' + b'\x90' * 62, 64)
    expected = (page, page + PAGE)
    report['target'] = {'kind': 'pagina propria com jmp $',
                        'base': hex(expected[0]), 'end': hex(expected[1]),
                        'bytes': 'eb fe', 'note': 'faixa definida antes da amostragem'}

    tid_out = wintypes.DWORD(0)
    hthread = k32.CreateThread(None, 0, ctypes.c_void_p(page), None,
                               0, ctypes.byref(tid_out))
    if not hthread:
        k32.VirtualFree(ctypes.c_void_p(page), 0, MEM_RELEASE)
        report['read'] = {'ok': False, 'reason': 'CreateThread falhou'}
        report['verdict'] = {'ok': False, 'reason': 'sem thread de teste'}
        return report

    created_tid = int(tid_out.value)
    th = k32.OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT
                        | THREAD_QUERY_INFORMATION, False, created_tid)

    stats = SuspensionStats()
    rips = []
    try:
        if not th:
            report['read'] = {'ok': False, 'reason': 'OpenThread falhou'}
        else:
            time.sleep(0.05)
            raw, ctxp = aligned_context()
            for _ in range(40):
                r = sample_suspended(th, ctxp, stats)
                if r['status'] == 'resume-fail':
                    report['resumeFatal'] = r
                    break
                if r['status'] == 'ok':
                    rips.append(r['rip'])
                time.sleep(0.001)

            # A. LEITURA — só isso. Nenhuma conclusão sobre identidade aqui.
            report['read'] = {
                'ok': (stats.read_fail == 0 and stats.suspend_fail == 0
                       and stats.resume_fail == 0 and len(rips) > 0),
                'attempts': stats.calls, 'valid': stats.read_ok,
                'failures': stats.read_fail,
                'suspendFailures': stats.suspend_fail,
                'resumeFailures': stats.resume_fail,
                'interference': stats.as_dict()}

            # B. IDENTIDADE — TID da thread que amostramos é a que criamos.
            report['identity'] = {'ok': created_tid == int(tid_out.value),
                                  'createdTid': created_tid,
                                  'note': 'OpenThread usou este TID'}

            # C. FAIXA CONHECIDA — RIP dentro da nossa página, offset 0.
            inside = [r for r in rips if expected[0] <= r < expected[1]]
            report['knownModule'] = {
                'ok': len(rips) > 0 and len(inside) == len(rips),
                'module': 'pagina propria (jmp $)',
                'base': hex(expected[0]), 'size': PAGE,
                'inside': len(inside), 'denominator': len(rips),
                'sampleRips': [hex(x) for x in rips[:5]],
                'exactOffsetHits': sum(1 for r in rips if r == expected[0]),
                'note': 'todo RIP deve ser base+0, a instrucao EB FE'}

            # D. CONTROLE NEGATIVO — faixa alheia tem que dar zero.
            FALSE_RANGE = [('must-not-match', 0x1000, 0x2000)]
            false_hits = sum(1 for rip in rips if classify(rip, FALSE_RANGE))
            report['negativeControl'] = {'ok': false_hits == 0,
                                         'range': '0x1000..0x2000',
                                         'hits': false_hits,
                                         'note': 'classify() tem que dar 0 aqui'}

            # E. ENCANAMENTO DOS CONTADORES — a mesma lógica de bucket que a
            # coleta usa, exercitada com RIPs sintéticos contra base/módulo/
            # faixas falsos. Prova que "fora do módulo", "dentro sem faixa" e
            # "dentro com faixa" caem em baldes distintos. Sem isso os
            # contadores são intenção de código, não comportamento verificado.
            fbase, fsize = 0x10000000, 0x1000
            # classify() recebe RVA (rip - base), igual a coleta real.
            frank = [('hit-a', 0x10, 0x20), ('hit-b', 0x200, 0x210)]
            synthetic = [
                (0x05000000, 'outside'),          # fora do módulo
                (0x10000800, 'inModuleNoRange'),  # dentro, nenhuma faixa
                (0x10000015, 'inRange:hit-a'),    # dentro de hit-a
                (0x10000205, 'inRange:hit-b'),    # dentro de hit-b
                (0x10000010, 'inRange:hit-a'),    # limite inferior INCLUSIVO
                (0x10000020, 'inModuleNoRange'),  # limite superior EXCLUSIVO
            ]
            buckets = {'ripOutsideModule': 0, 'ripInModuleOutsideRanges': 0,
                       'ripInRanges': 0}
            wrong = []
            for srip, want in synthetic:
                kind, rname, _rva = bucket(srip, fbase, fsize, frank)
                if kind == 'outside':
                    got = 'outside'; buckets['ripOutsideModule'] += 1
                elif kind == 'inRange':
                    got = 'inRange:' + rname; buckets['ripInRanges'] += 1
                else:
                    got = 'inModuleNoRange'; buckets['ripInModuleOutsideRanges'] += 1
                if got != want:
                    wrong.append({'rip': hex(srip), 'want': want, 'got': got})
            report['counterPlumbing'] = {
                'ok': not wrong, 'buckets': buckets, 'wrong': wrong,
                'total': len(synthetic),
                'note': 'usa bucket(), a mesma funcao da coleta'}

            # F. CRITÉRIOS DE INTERRUPÇÃO — decide() é a função que a coleta
            # usa de fato. Aqui ela roda com resultados sintéticos.
            cases = []

            def run_case(name, res, us, expected_action,
                         counters0=None, max_suspend=2000, max_fail=5):
                c = dict(counters0 or {'suspendFailures': 0, 'resumeFailures': 0,
                                       'contextFailures': 0})
                act, reason, fatal = decide(res, us, c, max_suspend, max_fail)
                cases.append({'name': name, 'got': act, 'want': expected_action,
                              'ok': act == expected_action, 'reason': reason,
                              'fatalIsRes': fatal is res})

            okres = lambda tid=1: {'status': 'ok', 'tid': tid, 'rip': 0x1234,
                                   'err': 0, 'prevSuspendCount': 0,
                                   'alreadySuspended': False}
            # resume-fail para na PRIMEIRA, mesmo com contador zerado e mesmo
            # que a janela seja curta.
            run_case('resume-fail para de imediato', {
                'status': 'resume-fail', 'tid': 9, 'err': 6,
                'prevSuspendCount': 1, 'alreadySuspended': True, 'rip': None},
                10.0, 'stop-resume')
            # suspend-fail NÃO para na primeira: acumula até 5.
            run_case('suspend-fail 1 de 5 acumula', {
                'status': 'suspend-fail', 'tid': 9, 'err': 5, 'rip': None},
                10.0, 'count-suspendfail')
            run_case('suspend-fail 5 de 5 para', {
                'status': 'suspend-fail', 'tid': 9, 'err': 5, 'rip': None},
                10.0, 'stop-suspendfail',
                counters0={'suspendFailures': 4, 'resumeFailures': 0,
                           'contextFailures': 0})
            # context-fail conta e segue; nunca para.
            run_case('context-fail conta e segue', {
                'status': 'context-fail', 'tid': 9, 'err': 6, 'rip': None},
                10.0, 'count-contextfail',
                counters0={'suspendFailures': 0, 'resumeFailures': 0,
                           'contextFailures': 99})
            # orçamento de janela
            run_case('janela > orcamento para', okres(), 2001.0, 'stop-suspend')
            run_case('janela == orcamento segue', okres(), 2000.0, 'continue')
            run_case('leitura normal segue', okres(), 20.0, 'continue')

            report['stopCriteria'] = {
                'ok': all(c['ok'] for c in cases), 'cases': cases,
                'note': 'decide() e a mesma funcao usada pela coleta'}
    finally:
        if th:
            k32.CloseHandle(ctypes.c_void_p(th))
        k32.TerminateThread(ctypes.c_void_p(hthread), 0)
        k32.CloseHandle(ctypes.c_void_p(hthread))
        k32.VirtualFree(ctypes.c_void_p(page), 0, MEM_RELEASE)

    keys = ('read', 'identity', 'knownModule', 'negativeControl', 'counterPlumbing',
            'stopCriteria')
    report['verdict'] = {
        'readOk': bool((report.get('read') or {}).get('ok')),
        'identityOk': bool((report.get('identity') or {}).get('ok')),
        'knownModuleOk': bool((report.get('knownModule') or {}).get('ok')),
        'negativeOk': bool((report.get('negativeControl') or {}).get('ok')),
        'plumbingOk': bool((report.get('counterPlumbing') or {}).get('ok')),
        'criteriaOk': bool((report.get('stopCriteria') or {}).get('ok')),
        'ok': all(bool((report.get(k) or {}).get('ok')) for k in keys),
    }
    return report

if SELF_TEST:
    print(json.dumps({'ok': True, 'selfTest': self_test()}, ensure_ascii=False))
    sys.exit(0)

# ---------------------------------------------------------------------------
# IDENTIDADE DO ALVO (sempre antes de coletar)
# ---------------------------------------------------------------------------
result = {'ok': True, 'pid': PID, 'identity': {}, 'verify': None,
          'counters': {}, 'threads': 0, 'windowThreads': [], 'sweeps': 0,
          'hits': [], 'summary': [], 'perThread': [], 'interference': {},
          'durationMs': 0}

k32.IsWow64Process.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
k32.GetProcessTimes.argtypes = [wintypes.HANDLE,
                                ctypes.POINTER(wintypes.FILETIME),
                                ctypes.POINTER(wintypes.FILETIME),
                                ctypes.POINTER(wintypes.FILETIME),
                                ctypes.POINTER(wintypes.FILETIME)]
hproc = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, PID)
if not hproc:
    print(json.dumps({'ok': False, 'error': 'OpenProcess'}))
    sys.exit(0)

wow = wintypes.BOOL(0)
k32.IsWow64Process(hproc, ctypes.byref(wow))

# Identidade da INSTANCIA: dois processos com o mesmo exe tem o mesmo build,
# mas so um tem este CreationTime. E o que distingue "PID 24800" de "outro
# PID 24800 depois de reiniciar".
ct = wintypes.FILETIME(); et = wintypes.FILETIME()
kt = wintypes.FILETIME(); ut = wintypes.FILETIME()
have_times = bool(k32.GetProcessTimes(hproc, ctypes.byref(ct), ctypes.byref(et),
                                      ctypes.byref(kt), ctypes.byref(ut)))

def filetime_to_unix(ft):
    v = (ft.dwHighDateTime << 32) | ft.dwLowDateTime
    return (v - 116444736000000000) // 10000000 if v else 0
created_unix = filetime_to_unix(ct) if have_times else 0
created_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(created_unix)) \
    if created_unix else None

base, size, modpath = module_base(PID, MODULE)
if not base:
    print(json.dumps({'ok': False, 'error': 'modulo do jogo nao encontrado'}))
    sys.exit(0)

def read(a, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(hproc, ctypes.c_void_p(a), buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''

# PE: e_lfanew @0x3C, TimeDateStamp em FileHeader+8, Checksum em OptHdr+64,
# SizeOfImage em OptHdr+56 (PE32+).
pe = {}
head = read(base, 0x400)
if len(head) >= 0x100:
    e_lfanew = int.from_bytes(head[0x3C:0x40], 'little')
    if 0 < e_lfanew < 0x3F0 and head[e_lfanew:e_lfanew + 4] == b'PE\x00\x00':
        fh = e_lfanew + 4
        oh = fh + 20
        magic = int.from_bytes(head[oh:oh + 2], 'little')
        pe = {'timeDateStamp': int.from_bytes(head[fh + 8:fh + 12], 'little'),
              'sizeOfImage': int.from_bytes(head[oh + 56:oh + 60], 'little'),
              'checksum': int.from_bytes(head[oh + 64:oh + 68], 'little'),
              'magic': hex(magic),
              'pointerToSymbolTableSha': hashlib.sha256(head[:0x400]).hexdigest()[:16]}

result['identity'] = {
    'pid': PID, 'wow64': bool(wow.value),
    'arch': 'x86 (WOW64)' if wow.value else 'x64',
    'module': MODULE, 'moduleBase': hex(base),
    'moduleSize': size, 'modulePath': modpath, 'pe': pe,
    'processCreatedUnix': created_unix,
    'processCreatedIso': created_iso,
    'uptimeSeconds': int(time.time() - created_unix) if created_unix else None,
}

# SHA256 do arquivo em disco. Serve para casar com o manifesto do arquivo de
# faixas. CUIDADO: se o exe foi substituido depois que o processo iniciou, o
# hash do disco NAO descreve a imagem em memoria — por isso o resultado é
# comparado tambem com o mtime, e o campo onDiskAfterStart avisa.
if modpath:
    try:
        h = hashlib.sha256()
        with open(modpath, 'rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                h.update(chunk)
        result['identity']['sha256'] = h.hexdigest()
        st = os.stat(modpath)
        result['identity']['fileSize'] = st.st_size
        result['identity']['fileMtimeUnix'] = int(st.st_mtime)
        result['identity']['onDiskAfterStart'] = bool(
            created_unix and st.st_mtime > created_unix + 1)
    except Exception as exc:
        result['identity']['sha256'] = None
        result['identity']['sha256Error'] = str(exc)

checks = []
mismatches = []
for name, a, b, expected in RANGES:
    d = read(base + a, 8)
    actual = d.hex()
    # Sem head declarado (ex.: faixa ancorada so por .pdata), o byte check nao
    # se aplica: fica match:null e NAO entra em mismatches. Dizer "bate" sem
    # ter com o que comparar seria mentira.
    match = (actual == expected) if (d and expected) else None
    entry = {'name': name, 'rva': hex(a), 'bytes': actual,
             'expected': expected or None, 'match': match, 'readable': bool(d)}
    checks.append(entry)
    if match is False:
        mismatches.append(name)
result['verify'] = {'ranges': checks, 'mismatches': mismatches,
                   'allMatch': not mismatches,
                   'source': RANGES_SOURCE,
                   'unverified': UNVERIFIED,
                   'byteChecked': sum(1 for c in checks if c['match'] is not None),
                   'byteMismatched': len(mismatches)}

# Arquitetura errada invalida todos os RVAs.
if wow.value:
    result['ok'] = False
    result['error'] = 'processo e WOW64/x86; RVAs x64 nao se aplicam'
    print(json.dumps(result, ensure_ascii=False)); sys.exit(0)

# Build diferente: recusa coletar, a menos que --force.
if mismatches and not FORCE:
    result['ok'] = False
    result['error'] = ('bytes de faixa divergem do build de referencia: '
                       + ', '.join(mismatches) + '; use --force se souber o que faz')
    print(json.dumps(result, ensure_ascii=False)); sys.exit(0)

# Chegar aqui com VERIFY=0 significa coleta (self-test ja saiu antes; o Node
# so invoca este script para --self-test, --verify-ranges ou --run).
if not VERIFY:
    pass  # coleta abaixo

# --verify-ranges puro: identidade + bytes, nenhum handle de thread, nenhuma
# amostragem. Contadores de coleta ficam ausentes de proposito.
if VERIFY and not RUN:
    k32.CloseHandle(hproc)
    result['counters'] = None
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0)

# ---------------------------------------------------------------------------
# COLETA
# ---------------------------------------------------------------------------
tids = threads_of(PID)
handles = []
counters = {'contextAttempts': 0, 'contextValid': 0, 'contextFailures': 0,
            'suspendFailures': 0, 'resumeFailures': 0, 'openFailures': 0,
            'ripOutsideModule': 0, 'ripInModuleOutsideRanges': 0, 'ripInRanges': 0}
for tid in tids:
    th = k32.OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT
                        | THREAD_QUERY_INFORMATION, False, tid)
    if th:
        handles.append((tid, th))
    else:
        counters['openFailures'] += 1

result['threads'] = len(tids)
result['windowThreads'] = window_threads(PID)

# ---------------------------------------------------------------------------
# CRITÉRIOS DE INTERRUPÇÃO
#
#   MAX_SUSPEND_US (padrão 2000 µs = 2 ms)
#     ORÇAMENTO DE JANELA DECLARADO. Não é "1 frame": a 60 Hz um frame dura
#     ~16,67 ms, não 2 ms. 2 ms é apenas o teto que aceitamos congelar uma
#     thread por amostra. O pior já medido foi 931 µs; 2 ms é ~2x isso e, acima
#     dele, o laço de suspensão está degradando (máquina carregada, page fault,
#     driver). Aborta e reporta a janela culpada.
#   MAX_FAILURES (padrão 5) — SÓ para SuspendThread e para GetThreadContext.
#     SuspendThread falhando é estado inconsistente do alvo (thread morta,
#     handle inválido). Acumula até 5 e então aborta; não há thread suspensa a
#     recuperar nesse caso, porque a suspensão nunca aconteceu.
#   ResumeThread falhando NÃO espera 5. Aborta na PRIMEIRA ocorrência.
#     Motivo: é o único caso em que uma thread pode ter ficado suspensa. A
#     retomada pendente é registrada (TID + erro + contagem anterior) e o laço
#     para imediatamente. NÃO se tenta um segundo ResumeThread: SuspendThread
#     devolve a contagem anterior, então uma retomada extra decrementaria a
#     suspensão de terceiros (por exemplo a de um depurador).
#   Interrupção = para de coletar na hora, marca stopReason, grava e sai.
#   Nada é repetido automaticamente.
# ---------------------------------------------------------------------------
stop_reason = None
last_ctx_err = None

def journal_write(force=False):
    """Grava o estado parcial em disco. Chamado a cada PARTIAL_EVERY sweeps e
    no fim normal. Isto é o que sobrevive a morte abrupta do processo: o
    o finally do Python NAO roda em TerminateProcess, kill -9, crash do
    interpretador, ou falha de energia. Só o que já está no disco sobrevive."""
    if not PARTIAL:
        return
    snap = dict(result)
    snap['counters'] = counters
    snap['interference'] = stats.as_dict()
    snap['partial'] = True
    snap['partialSweeps'] = result['sweeps']
    snap['stopReason'] = stop_reason
    snap['journalUpdatedAtIso'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    snap['summary'] = [{'tid': t, 'range': r, 'count': n}
                       for (t, r), n in sorted(hits.items(), key=lambda kv: -kv[1])]
    tmp = PARTIAL + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        fh.write(json.dumps(snap, ensure_ascii=False, indent=1))
        fh.flush()
    os.replace(tmp, PARTIAL)

stats = SuspensionStats()
raw, ctxp = aligned_context()
hits = {}
per_tid = {}
started = time.time()
started_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
result['startedAtIso'] = started_iso
worst_this_run = 0
resume_fatal = None

try:
    while time.time() - started < SECONDS:
        result['sweeps'] += 1
        for tid, th in handles:
            t0 = time.perf_counter_ns()
            r = sample_suspended(th, ctxp, stats, tid)
            this_us = (time.perf_counter_ns() - t0) / 1000.0
            if this_us > worst_this_run:
                worst_this_run = this_us
            counters['contextAttempts'] += 1

            action, reason, fatal = decide(res=r, this_us=this_us,
                                           counters=counters,
                                           max_suspend_us=MAX_SUSPEND_US,
                                           max_failures=MAX_FAILURES)
            if fatal is not None:
                resume_fatal = fatal
            if reason:
                stop_reason = reason
            if action in ('stop-resume', 'stop-suspend', 'stop-suspendfail'):
                break
            if action == 'count-contextfail':
                last_ctx_err = {'tid': tid, 'err': r['err']}
                continue
            if action == 'count-suspendfail':
                continue

            rip = r['rip']
            counters['contextValid'] += 1
            kind, where, rva = bucket(rip, base, size, RANGES)
            if kind == 'outside':
                counters['ripOutsideModule'] += 1
                continue
            if kind == 'inModuleNoRange':
                counters['ripInModuleOutsideRanges'] += 1
                continue
            counters['ripInRanges'] += 1
            per_tid[tid] = per_tid.get(tid, 0) + 1
            key = (tid, where)
            hits[key] = hits.get(key, 0) + 1
            if len(result['hits']) < 120:
                result['hits'].append({
                    'tid': tid, 'range': where, 'rva': hex(rva), 'rip': hex(rip),
                    'elapsedMs': int((time.time() - started) * 1000),
                    'atIso': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                    'alreadySuspended': r.get('alreadySuspended', False),
                    'rbx': hex(ctxp.contents.Rbx), 'rcx': hex(ctxp.contents.Rcx),
                    'rdx': hex(ctxp.contents.Rdx), 'rdi': hex(ctxp.contents.Rdi),
                    'rsi': hex(ctxp.contents.Rsi)})
        if stop_reason:
            break
        if result['sweeps'] % PARTIAL_EVERY == 0:
            journal_write()
        time.sleep(INTERVAL)
finally:
    # Este finally NÃO é garantia de nada em morte abrupta. Serve para o caso
    # normal e para exceção Python. O que sobrevive a kill/crash é o journal.
    for _, th in handles:
        k32.CloseHandle(ctypes.c_void_p(th))
    k32.CloseHandle(hproc)

result['counters'] = counters
result['interference'] = stats.as_dict()
result['interference']['worstWindowThisRunUs'] = round(worst_this_run, 2)
result['durationMs'] = int((time.time() - started) * 1000)
result['endedAtIso'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
result['stopReason'] = stop_reason
result['aborted'] = bool(stop_reason)
result['resumeFatal'] = resume_fatal
result['lastContextFailure'] = last_ctx_err
result['limits'] = {'maxSuspendUs': MAX_SUSPEND_US, 'maxFailures': MAX_FAILURES,
                    'intervalMs': INTERVAL * 1000.0, 'secondsRequested': SECONDS}
result['summary'] = [{'tid': tid, 'range': rng, 'count': n}
                     for (tid, rng), n in sorted(hits.items(), key=lambda kv: -kv[1])]
result['perThread'] = [{'tid': t, 'inRangeSamples': n}
                       for t, n in sorted(per_tid.items(), key=lambda kv: -kv[1])]
journal_write()

print(json.dumps(result, ensure_ascii=False))
`;

function printPlan() {
  const lines = [
    '=== coletor de contexto de execucao ===',
    '',
    'OBJETIVO',
    '  Qual thread executa o caminho de caminhada?',
    '  NAO responde: se funciona sem foco/minimizado, nem valida nosso executor.',
    '',
    'MECANISMO E INTERFERENCIA',
    '  SuspendThread -> GetThreadContext -> ResumeThread, por thread.',
    '  Cada janela congela a thread por dezenas de microssegundos e e MEDIDA',
    '  (interference.avg/max/totalSuspendedMs + perThreadSuspendedMs).',
    '  ResumeThread fica em finally.',
    '  ATENCAO: finally NAO e garantia em morte abrupta. Python morto por',
    '  TerminateProcess, kill, crash ou queda de energia nao executa finally,',
    '  e a thread alvo fica suspensa. Ver RECUPERACAO abaixo.',
    '',
    'CRITERIOS DE INTERRUPCAO (padrao)',
    '  --max-suspend-us 2000  ORCAMENTO DE JANELA declarado: uma suspensao',
    '    acima de 2 ms aborta. Nao e "1 frame": a 60 Hz um frame dura ~16,67 ms.',
    '    2 ms e so o teto que aceitamos congelar uma thread por amostra; o pior',
    '    medido ate agora foi 931 us, entao 2 ms e ~2x isso e indica degradacao',
    '    (maquina carregada, page fault, driver).',
    '  --max-failures 5  SOMENTE para SuspendThread e GetThreadContext. Falhas',
    '    desses acumulam ate 5; nao ha thread suspensa a recuperar porque a',
    '    suspensao nunca aconteceu.',
    '  ResumeThread falhando ABORTA NA PRIMEIRA. E o unico caso em que uma',
    '    thread pode ficar suspensa: o TID, o erro e a contagem anterior sao',
    '    registrados na hora. NAO se tenta um segundo ResumeThread, porque',
    '    SuspendThread devolve a contagem anterior e uma retomada extra',
    '    alteraria a suspensao de terceiros.',
    '  Interrupcao para a coleta na hora, grava stopReason e NAO repete.',
    '',
    'RECUPERACAO SE O COLETOR MORRER NO MEIO',
    '  1. O journal `local-data/trace-exec-partial-<data>.json` e escrito a cada',
    '     --journal-every sweeps (padrao 5). E o registro que sobrevive.',
    '  2. Sintoma de thread presa: janela do jogo nao responde, CPU alta.',
    '  3. Acao: fechar o processo do jogo (Fechar janela / Gerenciador de',
    '     tarefas). Nada fica gravado no jogo; reiniciar desfaz.',
    '  4. O journal pode estar em `.tmp` se a morte caiu no meio da escrita:',
    '     nesse caso o ultimo journal bom e o `.json` anterior.',
    '  5. Nenhum estado nosso fica no processo do jogo: sem patch, sem alloc.',
    '     A unica heranca possivel e uma thread suspensa no cliente.',
    '',
    'SELF-TEST PROVA CINCO COISAS SEPARADAS',
    '  A. leitura: GetThreadContext retorna sucesso e RIP != 0, com a janela',
    '     de suspensao medida em us (avg/max/total)',
    '  B. identidade: o TID amostrado e o TID que criamos',
    '  C. faixa conhecida: RIP cai numa pagina nossa com jmp $, cujo intervalo',
    '     foi definido ANTES da amostragem (todo RIP = base+0)',
    '  D. controle negativo: faixa alheia 0x1000..0x2000 tem que dar ZERO',
    '  E. encanamento: RIPs sinteticos caem nos baldes certos, com limite',
    '     inferior inclusivo e superior exclusivo',
    '',
    'IDENTIDADE ANTES DE COLETAR',
    '  --run sempre le PID, arquitetura (WOW64 aborta), base, tamanho, PE',
    '  timestamp, SizeOfImage, checksum e os 8 bytes de cada faixa.',
    '  Byte divergente do build de referencia -> RECUSA, a menos que --force.',
    '  Base e relida do loader a cada execucao; nunca reaproveitada.',
    '',
    'FAIXAS (build de referencia: ' + REFERENCE_BUILD.source + ')',
    ...RANGES.map(r => `  ${r.name.padEnd(26)} 0x${r.start.toString(16)}..0x${r.end.toString(16)}`),
    '',
    'PROCEDIMENTO',
    '  1. node tools/trace_exec_context.cjs --self-test',
    '  2. node tools/trace_exec_context.cjs --pid <PID> --verify-ranges',
    '     (PID, arquitetura, PE, base e 8 bytes de cada faixa)',
    '  3. node tools/trace_exec_context.cjs --pid <PID> --run --seconds 20',
    '',
    'ACAO MANUAL (passo 3)',
    '  Clique na janela do jogo, ande DIGITANDO as setas do teclado:',
    '    3-4 rajadas de ~2 s, com ~1 s de pausa entre elas.',
    '  O coletor nao envia tecla nem rouba foco; voce tem que agir.',
    '  Sem isso o teste nao exercita o caminho e zero hits nao significa nada.',
    '',
    'LIMITES',
    `  ${DEFAULT_SECONDS} s por padrao, teto de ${MAX_SECONDS} s, amostragem a cada ${DEFAULT_INTERVAL_MS} ms por thread.`,
    '  Custo cresce com numero de threads: veja interference no JSON.',
    '',
    'RESTAURACAO',
    '  nenhuma alteracao persistente. Nenhum patch, nenhuma escrita.',
    '',
    'LEITURA DO RESULTADO (contadores sao baldes distintos, nao um so)',
    '  contextAttempts            tentativas de GetThreadContext',
    '  contextValid               sucesso e RIP != 0',
    '  contextFailures            GetThreadContext retornou FALSE',
    '  suspendFailures/resumeFailures  SuspendThread/ResumeThread = 0xFFFFFFFF',
    '  ripOutsideModule           RIP fora da imagem do jogo (ntdll, GPU, ...)',
    '  ripInModuleOutsideRanges   RIP na imagem, em nenhuma faixa observada',
    '  ripInRanges                RIP numa faixa observada  <-- o unico que conta',
    '',
    '  ripInRanges > 0                  -> houve observacao (ver summary)',
    '  contextFailures > 0              -> INCONCLUSIVO, nao negativo',
    '  ripInRanges == 0 e contadores ok -> INCONCLUSIVO: funcao curta pode',
    '                                      nunca cair numa amostra',
    '  tid == windowThreads             -> HIPOTESE de message loop; nao prova',
    '                                      scheduler, nao exclui outro caminho',
    '  tid != windowThreads             -> despacho precisaria de fila; nao e erro',
  ];
  console.log(lines.join('\n'));
}

function main() {
  const needsPid = RUN || VERIFY;
  if (needsPid && (!Number.isInteger(PID) || PID <= 0)) {
    console.error('--pid obrigatorio');
    printPlan();
    return 2;
  }
  if (!RUN && !VERIFY && !SELF_TEST) {
    printPlan();
    return 0;
  }
  const script = path.join(process.env.TEMP || '.', 'opencode', 'trace_exec_context.py');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, PY, 'utf8');

  /* Journal: grava estado parcial durante a coleta. É o ÚNICO registro que
   * sobrevive se o processo for morto abruptamente — `finally` do Python não
   * roda em TerminateProcess, kill -9, crash do interpretador ou queda de
   * energia. Nome fixo e previsível para poder ser lido depois. */
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const partial = RUN
    ? path.join(OUT_DIR, 'trace-exec-partial-' + stamp + '.json')
    : '';
  if (partial) fs.mkdirSync(OUT_DIR, { recursive: true });

  let raw;
  try {
    raw = execFileSync('python', [script, String(PID || 0), String(SECONDS),
      String(INTERVAL_MS), VERIFY ? '1' : '0', SELF_TEST ? '1' : '0',
      FORCE ? '1' : '0', MODULE, partial,
      String(MAX_SUSPEND_US), String(MAX_FAILURES), String(PARTIAL_EVERY),
      RUN ? '1' : '0', RANGES_JSON],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: (SECONDS + 45) * 1000 });
  } catch (error) {
    console.error('[FALHA] ' + (error.message || error));
    if (partial) {
      console.error('[JOURNAL] estado parcial (se houver): ' + partial);
      try {
        const j = JSON.parse(fs.readFileSync(partial, 'utf8'));
        console.error('[JOURNAL] sweeps=' + j.partialSweeps + ' stopReason='
          + (j.stopReason || '(nenhum)') + ' hits=' + (j.summary?.length || 0));
        console.error('[JOURNAL] processos com thread suspensa: verificar o jogo; '
          + 'se travado, encerrar o cliente é a recuperação.');
      } catch { console.error('[JOURNAL] journal ilegivel ou ausente'); }
    }
    return 1;
  }
  const line = raw.replace(/^\uFEFF/u, '').trim().split(/\r?\n/u).pop();
  let result;
  try { result = JSON.parse(line); }
  catch { console.error('[FALHA] saida sem JSON'); console.error(raw.slice(0, 800)); return 1; }

  if (SELF_TEST) {
    const st = result.selfTest || {};
    const v = st.verdict || {};
    const t = st.target || {};
    const mark = ok => (ok ? 'PASS' : 'FAIL');
    console.log('=== self-test do coletor ===');
    console.log('  alvo: ' + (t.kind || '?') + ' @ ' + (t.base || '?')
      + ' bytes=' + (t.bytes || '?'));
    console.log('        faixa ' + (t.base || '?') + '..' + (t.end || '?')
      + ' definida ANTES da amostragem');
    console.log('');
    console.log('[A] leitura de contexto');
    const r = st.read || {};
    console.log('  ' + mark(r.ok) + '  GetThreadContext  validas='
      + (r.valid ?? 0) + '/' + (r.attempts ?? 0) + ' falhas=' + (r.failures ?? 0)
      + ' suspendFail=' + (r.suspendFailures ?? 0) + ' resumeFail='
      + (r.resumeFailures ?? 0));
    if (r.interference) {
      console.log('        janela: avg=' + r.interference.avgSuspendedUs + 'us  max='
        + r.interference.maxSuspendedUs + 'us  total='
        + r.interference.totalSuspendedMs + 'ms');
    }
    console.log('');
    console.log('[B] identidade da thread');
    const id = st.identity || {};
    console.log('  ' + mark(id.ok) + '  TID criado == TID amostrado: ' + id.createdTid);
    console.log('');
    console.log('[C] RIP dentro de modulo conhecido');
    const km = st.knownModule || {};
    console.log('  ' + mark(km.ok) + '  ' + km.module + '  dentro=' + km.inside
      + '/' + km.denominator + '  base=' + km.base);
    console.log('        amostras: ' + JSON.stringify(km.sampleRips));
    console.log('');
    console.log('[D] controle negativo');
    const nc = st.negativeControl || {};
    console.log('  ' + mark(nc.ok) + '  faixa ' + nc.range + ' hits=' + nc.hits);
    console.log('');
    console.log('[E] encanamento dos contadores');
    const cp = st.counterPlumbing || {};
    console.log('  ' + mark(cp.ok) + '  ' + cp.total + ' RIPs sinteticos -> '
      + JSON.stringify(cp.buckets));
    if (cp.wrong?.length) console.log('        erros: ' + JSON.stringify(cp.wrong));
    console.log('');
    console.log('[F] criterios de interrupcao (decide(), a mesma da coleta)');
    const sc = st.stopCriteria || {};
    for (const tc of (sc.cases || [])) {
      console.log('  ' + mark(tc.ok) + '  ' + tc.name.padEnd(34)
        + ' -> ' + tc.got + (tc.ok ? '' : '  (esperado ' + tc.want + ')'));
    }
    console.log('');
    if (v.ok) {
      console.log('VEREDITO: coletor VALIDADO em A, B, C, D, E e F.');
      return 0;
    }
    console.log('VEREDITO: coletor NAO validado. Nao colete no jogo.');
    console.log('  leitura=' + v.readOk + ' identidade=' + v.identityOk
      + ' modulo=' + v.knownModuleOk + ' negativo=' + v.negativeOk
      + ' contadores=' + v.plumbingOk);
    return 4;
  }

  const ident = result.identity || {};
  if (result.ok === false) {
    console.error('[RECUSA] ' + (result.error || 'identidade do alvo invalida'));
    if (result.verify?.ranges) printVerify(result.verify);
    return 5;
  }

  console.log('=== identidade do alvo ===');
  console.log('  pid            ' + ident.pid);
  console.log('  arquitetura    ' + ident.arch + (ident.wow64 ? '  <-- ABORTAR' : ''));
  console.log('  modulo         ' + ident.module + ' @ ' + ident.moduleBase
    + ' size=' + ident.moduleSize);
  console.log('  caminho        ' + ident.modulePath);
  console.log('  instancia      criado ' + (ident.processCreatedIso || '?')
    + '  (uptime ' + (ident.uptimeSeconds ?? '?') + ' s)');
  if (ident.pe) {
    console.log('  PE timestamp   ' + ident.pe.timeDateStamp + ' ('
      + new Date(ident.pe.timeDateStamp * 1000).toISOString() + ')');
    console.log('  PE SizeOfImage ' + ident.pe.sizeOfImage + '  magic=' + ident.pe.magic);
    console.log('  PE checksum    ' + ident.pe.checksum);
    console.log('  header hash    ' + ident.pe.pointerToSymbolTableSha);
  }

  printVerify(result.verify);

  /* Confirmação AUTOMÁTICA de build. Não depende de ninguém lembrar qual PID
   * ou qual build era o atual: compara o que está rodando com o manifesto do
   * arquivo de faixas. Divergência = recusa, sem coletar. */
  if (BUILD_MANIFEST) {
    const problems = [];
    if (BUILD_MANIFEST.sha256 && ident.sha256
        && BUILD_MANIFEST.sha256.toLowerCase() !== ident.sha256.toLowerCase()) {
      problems.push('sha256 do exe difere do manifesto');
    }
    if (BUILD_MANIFEST.moduleSize && ident.moduleSize !== BUILD_MANIFEST.moduleSize) {
      problems.push('moduleSize ' + ident.moduleSize + ' != manifesto '
        + BUILD_MANIFEST.moduleSize);
    }
    if (BUILD_MANIFEST.peTimeDateStamp && ident.pe
        && ident.pe.timeDateStamp
        && BUILD_MANIFEST.peTimeDateStamp !== ident.pe.timeDateStamp) {
      problems.push('PE TimeDateStamp difere');
    }
    if (ident.onDiskAfterStart) {
      problems.push('exe no disco foi modificado DEPOIS do processo iniciar; '
        + 'hash do disco nao descreve a imagem em memoria');
    }
    console.log('');
    console.log('=== confirmacao automatica de build ===');
    if (problems.length) {
      console.log('  FALHA: ' + problems.join('; '));
      if (!FORCE) {
        console.error('[RECUSA] build nao corresponde ao manifesto do arquivo '
          + 'de faixas. Reancorar antes de coletar, ou --force consciente.');
        return 5;
      }
      console.log('  --force: seguindo mesmo assim (faixas podem nao valer).');
    } else {
      console.log('  ok: build confere com o manifesto ('
        + BUILD_MANIFEST.sha256.slice(0, 12) + '..., size '
        + BUILD_MANIFEST.moduleSize + ')');
    }
  }

  if (!RUN) return 0;

  const c = result.counters || {};
  const i = result.interference || {};

  /* Orçamento REAL por thread, derivado do que aconteceu, não do que foi
   * pedido. `sweeps` é quantas varreduras couberam; com 5 s e intervalo de
   * 10 ms o alvo é ~500, mas o custo de suspender N threads alonga cada sweep.
   * O número honesto é attempts/threads e o tempo de parede gasto. */
  const threads = result.threads || 0;
  const attempts = c.contextAttempts || 0;
  const sweeps = result.sweeps || 0;
  const perThreadAttempts = threads ? (attempts / threads) : 0;
  const nominalSweeps = INTERVAL_MS > 0
    ? Math.floor(((result.limits?.secondsRequested || 0) * 1000) / INTERVAL_MS)
    : 0;
  const effHz = perThreadAttempts && result.durationMs
    ? (perThreadAttempts / (result.durationMs / 1000)) : 0;

  console.log('');
  console.log('=== coleta ===');
  console.log('  inicio/fim     ' + (result.startedAtIso || '?') + '  ->  '
    + (result.endedAtIso || '?'));
  console.log('  duracao        ' + result.durationMs + ' ms  (pedido: '
    + (result.limits?.secondsRequested ?? '?') + ' s)');
  console.log('  sweeps         ' + sweeps + '  (nominal max: ' + nominalSweeps + ')');
  console.log('  threads        ' + threads + '  (windowThreads: '
    + JSON.stringify(result.windowThreads) + ')');
  console.log('');
  console.log('=== orcamento por thread ===');
  console.log('  tentativas/thread        ' + perThreadAttempts.toFixed(1)
    + '  (total ' + attempts + ' / ' + threads + ' threads)');
  console.log('  frequencia efetiva       ' + effHz.toFixed(1) + ' Hz por thread'
    + '  (alvo ' + (1000 / INTERVAL_MS).toFixed(0) + ' Hz)');
  console.log('  intervalo pedido         ' + INTERVAL_MS + ' ms entre sweeps');
  if (effHz && effHz < (1000 / INTERVAL_MS) * 0.5) {
    console.log('  ATENCAO: frequencia efetiva < 50% do alvo. O custo de suspender');
    console.log('  ' + threads + ' threads domina o intervalo. Funcoes curtas ficam');
    console.log('  ainda menos provaveis de serem capturadas.');
  }
  console.log('');
  console.log('=== contadores (separados de proposito) ===');
  console.log('  contextAttempts          ' + c.contextAttempts);
  console.log('  contextValid             ' + c.contextValid);
  console.log('  contextFailures          ' + c.contextFailures);
  console.log('  suspendFailures          ' + c.suspendFailures);
  console.log('  resumeFailures           ' + c.resumeFailures);
  console.log('  openFailures             ' + c.openFailures);
  console.log('  ripOutsideModule         ' + c.ripOutsideModule);
  console.log('  ripInModuleOutsideRanges ' + c.ripInModuleOutsideRanges);
  console.log('  ripInRanges              ' + c.ripInRanges + '   <-- unico que conta');
  console.log('');
  console.log('=== interferencia ===');
  console.log('  janelas de suspensao     ' + i.calls);
  console.log('  total suspenso           ' + i.totalSuspendedMs + ' ms  ('
    + (result.durationMs ? (i.totalSuspendedMs / result.durationMs * 100).toFixed(1) : '?')
    + '% do tempo de parede somado entre threads)');
  console.log('  media / max por janela   ' + i.avgSuspendedUs + ' us / '
    + i.maxSuspendedUs + ' us');
  console.log('  pior janela desta rodada ' + i.worstWindowThisRunUs + ' us'
    + '  (limite ' + (result.limits?.maxSuspendUs ?? '?') + ' us)');
  const perThread = i.perThreadSuspendedMs || {};
  const worstTids = Object.entries(perThread)
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (worstTids.length) {
    console.log('  top threads por tempo suspenso:');
    for (const [tid, ms] of worstTids) {
      console.log('    tid=' + tid + '  ' + ms + ' ms');
    }
  }

  if (result.aborted) {
    console.log('');
    console.log('=== COLETA INTERROMPIDA ===');
    console.log('  motivo: ' + result.stopReason);
    if (result.resumeFatal) {
      const rf = result.resumeFatal;
      console.log('');
      console.log('  RESUME-FAIL (o caso critico):');
      console.log('    tid              ' + rf.tid);
      console.log('    GetLastError     ' + rf.err);
      console.log('    suspensao previa ' + rf.prevSuspendCount
        + (rf.alreadySuspended ? '  (ja suspensa por terceiro)' : ''));
      console.log('    rip no momento   ' + (rf.rip || 'nao lido'));
      console.log('  Nenhuma retentativa foi feita. Essa thread PODE ter ficado');
      console.log('  suspensa. Se o jogo travar, fechar o processo e a recuperacao.');
      console.log('  Nao houve ResumeThread adicional: isso alteraria a suspensao');
      console.log('  de terceiros.');
    }
    console.log('  Dados acima sao PARCIAIS (' + (result.sweeps || 0) + ' sweeps de '
      + nominalSweeps + ' nominais).');
    console.log('  Nada foi repetido. Avaliar antes de qualquer nova rodada.');
    if (result.summary?.length) {
      console.log('  Havia ' + result.summary.length + ' combinacao(oes) tid+faixa');
      console.log('  registradas antes do aborto; ver hits abaixo.');
    } else {
      console.log('  Nenhum hit antes do aborto. Isso NAO e resultado negativo:');
      console.log('  a coleta foi curta demais para concluir qualquer coisa.');
    }
  }

  if (result.summary?.length) {
    console.log('');
    console.log('=== hits ===');
    for (const s of result.summary) {
      console.log('  tid=' + s.tid + '  ' + s.range + '  n=' + s.count);
    }
    console.log('');
    console.log('  amostras (faixa, RIP, TID, horario):');
    for (const h of result.hits.slice(0, 15)) {
      console.log('    ' + h.atIso + '  tid=' + h.tid + '  ' + h.range
        + '  rip=' + h.rip + '  rva=' + h.rva + '  +' + h.elapsedMs + 'ms');
    }
    const windowSet = new Set(result.windowThreads || []);
    const hitTids = [...new Set(result.summary.map(s => s.tid))];
    console.log('');
    console.log('=== tid x windowThreads (registro, nao conclusao) ===');
    for (const t of hitTids) {
      console.log('  tid=' + t + (windowSet.has(t)
        ? '  coincide com thread de janela'
        : '  nao coincide com thread de janela'));
    }
    console.log('  Coincidencia NAO comprova message loop: a thread pode executar');
    console.log('  o trecho por outro motivo (timer, callback, pool).');
    console.log('  Divergencia NAO comprova necessidade de fila: so diz que o');
    console.log('  trecho rodou fora da thread dona da janela nesta amostra.');
    console.log('  Nada aqui demonstra como agendar nosso comando nessa thread.');
  } else {
    console.log('');
    if (result.aborted) {
      /* Já explicado no bloco de interrupção. Não repetir como "inconclusivo":
       * interrompido e inconclusivo são desfechos distintos. */
    } else {
      console.log('=== resultado: INCONCLUSIVO ===');
      console.log('  ripInRanges == 0.');
      if (c.contextFailures || c.suspendFailures || c.resumeFailures) {
        console.log('  Houve falhas de mecanismo: isto nao e negativo, e medicao quebrada.');
      } else {
        console.log('  Mecanismo limpo, ' + (c.contextValid || 0) + ' leituras validas.');
        console.log('  Zero capturas NAO prova ausencia: amostragem pode perder');
        console.log('  funcao de curta duracao. Ver avaliacao de chance abaixo.');
      }
    }
  }

  /* Avaliação de chance razoável — feita com números, não com otimismo. */
  console.log('');
  console.log('=== chance de capturar funcao curta nesta configuracao ===');
  const windowUs = (i.avgSuspendedUs || 0);
  const samplePeriodMs = perThreadAttempts && result.durationMs
    ? (result.durationMs / perThreadAttempts) : (INF_MS);
  console.log('  periodo entre amostras de UMA thread: ~'
    + samplePeriodMs.toFixed(1) + ' ms');
  console.log('  uma funcao que roda por X ms e amostrada com probabilidade');
  console.log('  ~X/periodo. Ex: funcao de 1 ms -> ~'
    + (samplePeriodMs ? (1 / samplePeriodMs * 100).toFixed(1) : '?') + '% por ocorrencia.');
  console.log('  Com ' + (c.contextValid || 0) + ' leituras validas e movimentos');
  console.log('  manuais breves, o caminho tem que estar ativo em varias amostras');
  console.log('  para aparecer. Ausencia de hit e compativel com funcao curta.');

  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR,
      'trace-exec-' + new Date().toISOString().replace(/[:.]/gu, '-') + '.json');
    fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log('\nevidencia: ' + file);
    if (partial && fs.existsSync(partial)) {
      console.log('journal:  ' + partial);
    }
  } catch { /* stdout basta */ }

  if (result.aborted) return 6;
  return result.summary?.length ? 0 : 3;
}

function printVerify(verify) {
  if (!verify) return;
  console.log('');
  console.log('=== faixas ===');
  for (const r of verify.ranges) {
    const state = r.match === true ? 'ok   '
      : r.match === false ? 'DIFF '
        : 'BYTE?';   /* sem head declarado: nao houve comparacao de bytes */
    console.log('  ' + state + r.name.padEnd(26) + r.rva + '  '
      + (r.bytes || '(ilegivel)')
      + (r.match === false ? '  esperado=' + r.expected : ''));
  }
  console.log('  fonte          ' + (verify.source === 'file'
    ? RANGE_SOURCE_LABEL : REFERENCE_BUILD.source));
  console.log('  byte-checked   ' + verify.byteChecked + ' de '
    + verify.ranges.length);
  if (verify.unverified?.length) {
    console.log('  NAO verificadas (nao geram hit): '
      + verify.unverified.join(', '));
  }
  if (!verify.allMatch) {
    console.log('  DIVERGENCIA em: ' + verify.mismatches.join(', '));
  } else if (verify.byteChecked === 0) {
    console.log('  Nenhuma comparacao de bytes possivel: faixas sem head.');
  } else {
    console.log('  todas as ' + verify.byteChecked + ' faixas com head batem');
  }
}

process.exit(main());
