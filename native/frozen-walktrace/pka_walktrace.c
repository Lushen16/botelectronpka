/*
 * pka_walktrace.c - observador dirigido por hardware breakpoint, com ciclo de
 * vida explicito e desarme verificavel.
 *
 * NAO e' um hook. Nenhum byte do alvo e' alterado. O unico estado que existe
 * vive nos registradores de depuracao das threads, que morrem com o processo.
 *
 * CICLO DE VIDA
 *
 *   IDLE --Prepare()--> PREPARED --Arm()--> ARMED
 *   ARMED --Stop()--> STOPPING --disarm+verify--> DISARMED
 *                                              \-> DISARM_FAILED
 *
 *   PREPARED --Stop()--> DISARMED (nada armado)
 *   DISARMED/DISARM_FAILED --Stop()--> mesmo resultado (idempotente)
 *
 * O HANDLER E' MINIMO
 *   Registra num array pre-alocado e limitado. Nao abre arquivo, nao suspende
 *   thread, nao chama a parada completa. Ao atingir o limite apenas levanta
 *   `g_stopRequested`; quem faz o trabalho e' a thread de servico.
 *
 * IDENTIFICACAO DA NOSSA EXCECAO (quatro condicoes, nao uma)
 *   1. ExceptionCode == EXCEPTION_SINGLE_STEP
 *   2. ExceptionAddress == alvo (VA, nao so RIP)
 *   3. bit B<slot> setado em Dr6 (o hardware diz que foi o NOSSO slot)
 *   4. ThreadId pertence ao conjunto armado
 *
 * PRESERVACAO DE RECURSOS ALHEIOS
 *   - escolhe um slot livre olhando Dr0..Dr3 e Dr7 (L e G) de TODAS as threads
 *     alvo; se nenhum slot estiver livre em todas, RECUSA armar
 *   - Dr7: read-modify-write apenas dos bits do nosso slot. Nunca atribuicao
 *     cega (o pka_dispatch_trace.c antigo fazia `Dr7 = 0x1` e apagava os
 *     outros slots)
 *   - Dr6: limpa SOMENTE o bit B<slot>, nunca o registrador inteiro
 *   - VEH: registrado por ULTIMO na cadeia (First=0) e devolve
 *     EXCEPTION_CONTINUE_SEARCH para qualquer coisa que nao seja nossa
 *
 * DESARME
 *   Stop() e' idempotente e verifica: depois de limpar os bits, relê Dr7 de
 *   cada thread e confirma que L<slot> e G<slot> estao zerados. Se qualquer
 *   thread falhar na verificacao, o estado vira DISARM_FAILED, a lista de
 *   pendencias e' gravada e NADA e' declarado limpo. O handler so' e' removido
 *   depois da verificacao e depois de g_inHandler voltar a zero.
 *
 * O QUE NAO E' GARANTIDO
 *   - DLL_PROCESS_DETACH nao roda em TerminateProcess. Por isso o desarme NAO
 *     depende dele: existe parada explicita, e a thread de servico tambem
 *     chama Stop() sozinha no limite de tempo.
 *   - Esta DLL NUNCA e' descarregada por codigo nosso (sem FreeLibrary). Se o
 *     processo morrer, o estado vai junto.
 *   - Morte abrupta entre SuspendThread e ResumeThread pode deixar a thread
 *     suspensa. Mesma janela de microssegundos, e o pior caso continua sendo
 *     "fechar o jogo".
 *
 * BUILD
 *   node tools/build_walktrace.cjs
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_ARMED      512
#define MAX_EVENTS     256
#define MAX_PENDING    512
#define MAX_VERIFY     512

enum {
    ST_IDLE = 0, ST_PREPARED, ST_ARMED, ST_STOPPING, ST_DISARMED, ST_DISARM_FAILED
};

enum {
    STOP_NONE = 0, STOP_EVENTS, STOP_TIME, STOP_EXPLICIT, STOP_ERROR
};

#define DR7_LOCAL(n)   (1u << (2 * (n)))
#define DR7_GLOBAL(n)  (1u << (2 * (n) + 1))
#define DR6_BIT(n)     (1u << (n))

typedef struct {
    uint64_t tickMs;
    uint64_t rip;
    uint32_t tid;
    uint32_t rva;
    uint32_t dr6;
    uint32_t dr7;
    uint64_t rdx;
    uint64_t r8;
    uint64_t rcx;
    LONG     index;
} EVENT;

typedef struct {
    uint32_t tid;
    uint32_t err;
    int      kind;   /* 0 = ok, 1 = gone, 2 = failed */
    uint32_t stage;  /* 0 open, 1 suspend, 2 context, 3 setctx, 4 verify */
} PENDING;

static CRITICAL_SECTION g_lock;
static int                g_lockReady = 0;

static volatile LONG g_state = ST_IDLE;
static volatile LONG g_finalResult = -1;
static volatile LONG g_stopRequested = 0;
static volatile LONG g_stopReason = STOP_NONE;
static volatile LONG g_eventCount = 0;      /* excecoes observadas (todas) */
static volatile LONG g_recorded = 0;        /* aceitas no buffer */
static volatile LONG64 g_stopRequestedAtMs = 0;
static volatile LONG64 g_disarmedAtMs = 0;
static volatile LONG g_overflow = 0;
/* GATE DE ENTRADA (fase unica, sem corrida)
 *
 *   g_gateOpen  1 = o handler PODE atender e contar
 *   g_inHandler numero de callbacks do handler neste instante
 *
 * Protocolo do handler (leitor):
 *     for(;;){ if(!gateOpen) return SEARCH;
 *              inHandler++;
 *              if(gateOpen) break;      // confirmou depois de contar
 *              inHandler--; }           // escritor fechou no meio: desiste
 *
 * Protocolo do Stop (escritor):
 *     gateOpen = 0;                     // 1) fecha a porta
 *     wait inHandler == 0;              // 2) drena quem ja' entrou
 *     ... desarma, remove VEH ...
 *
 * Por que o contador sozinho nao bastava: entre if(gateOpen) e
 * inHandler++ existe uma janela. O escritor podia fechar depois do teste e
 * ver inHandler==0 antes do incremento, removendo o VEH com um callback a
 * caminho -> o proximo SingleStep subiria sem tratamento. O padrao acima
 * (incrementa e revalida) fecha isso: quem incrementou depois do fechamento
 * percebe e desiste; quem incrementou antes ja' e' visivel ao dreno. */
static volatile LONG g_gateOpen = 0;
static volatile LONG g_inHandler = 0;
/* g_armed: existe pelo menos uma thread com o NOSSO DR escrito. Coincide com
 * g_armedCount > 0, mantido separado porque o handler le sem lock. */
static volatile LONG g_armed = 0;
static volatile LONG g_concurrentEntries = 0;
static volatile LONG g_droppedWhileClosing = 0;

/* ------------------------------------------------------------------------
 * CONTRATO DE ESTADO (campos do JSON, um conceito por campo)
 *
 *   handlerRegistered  1 = o VEH esta registrado no processo. Depois do Stop
 *                          ele CONTINUA 1: nao desregistramos (ver Stop).
 *                          Na pratica este campo e' sempre 1 apos Prepare.
 *   recordingEnabled   1 = o gate aceita gravar novos eventos.
 *                          1 somente entre Start (armado) e Stop.
 *   armedThreads       quantidade de threads com o nosso DR escrito AGORA.
 *                          Vai a 0 no desarme bem-sucedido.
 *   disarmVerified     1 = releitura de DR7 confirmou slot livre em todas as
 *                          threads armadas, e a contagem bateu.
 *
 * Nao existe mais `handlerRemoved`: ele misturava "nao registrado" com
 * "inativo", que sao coisas diferentes.
 *
 * REGRA DE RECONHECIMENTO APOS O DESARME (ponto 2)
 *
 *   O reconhecimento exige, sempre, as QUATRO condicoes:
 *     (a) ExceptionCode == SINGLE_STEP
 *     (b) ExceptionAddress == g_targetVA
 *     (c) GetCurrentThreadId pertence a g_armedTid[0..g_armedCount)
 *     (d) hitStamp > 0  (ver abaixo)
 *
 *   `g_armedCount` e' ZERADO no desarme bem-sucedido. Com a lista vazia, (c)
 *   falha para qualquer thread, e o handler devolve CONTINUE_SEARCH. Ou seja:
 *   depois do desarme, nada em g_targetVA e' tratado como nosso -- mesmo que o
 *   endereco coincida com o historico e o slot coincida com o historico.
 *
 *   EXCECOES NOSSAS EM TRANSITO
 *
 *   Uma excecao ja' levantada pelo hardware pode chegar DEPOIS do desarme.
 *   Nao usamos janela de tempo nem carimbo de recebimento para isso -- ver a
 *   secao "ATRIBUICAO POR Dr0 VIVO" abaixo. Resumo: o desarme desliga L0 do
 *   slot e MANTEM Dr0 apontando o alvo. Excecao em transito chega com
 *   Dr0 == alvo e e' consumida; excecao futura de terceiro tem Dr0 diferente
 *   (ou slot desligado por outro dono) e e' delegada.
 * --------------------------------------------------------------------- */
static volatile LONG  g_handlerRegistered = 0;
static volatile LONG  g_recordingEnabled = 0;
static volatile LONG  g_disarmVerified = 0;

/* ------------------------------------------------------------------------
 * ATRIBUICAO POR Dr0 VIVO (substitui a janela de tempo e o Dr6)
 *
 * Medicoes que motivaram a troca (ver docs/WALKTRACE_TRANSITO.md):
 *   - Dr6.B<n> escrito pelo hardware E' visivel no handler, mas some quando
 *     outra thread limpa Dr6 durante a entrega: 803 de 25138 excecoes
 *     chegaram com B0 zerado. Dr6 NAO e' identidade estavel.
 *   - Timestamp de recebimento nao vincula a excecao ao armamento que a
 *     originou. E' so' hora de chegada.
 *
 * O que E' estavel: o proprio Dr0 do contexto entregue ao handler.
 *   12235 excecoes: Dr0 == alvo e L0 ligado      -> disparo nosso, ativo
 *     115 excecoes: Dr0 == 0                     -> nossa, levantada antes
 *                                                   de o desarme limpar
 *       0 excecoes ambiguas
 *
 * Consequencia para o desenho do desarme: DESLIGAR L0 e MANTER Dr0.
 *   - L0 = 0  => a CPU nao gera mais #DB. Para de disparar.
 *   - Dr0 mantido => excecao que ja' estava no pipeline chega com
 *     Dr0 == alvo e ainda e' reconhecida como nossa.
 * Sem timer, sem tolerancia empirica, sem carimbo.
 *
 * Limite declarado: se um TERCEIRO apontar Dr0 para o MESMO endereco, a
 * atribuicao fica ambigua por construcao -- ambos monitoram o mesmo ponto.
 * Nao ha informacao no contexto que separe os dois. Isso e' registrado como
 * `ambiguousSameTarget` e nao ha tentativa de adivinhar.
 * --------------------------------------------------------------------- */
static volatile LONG  g_ambiguousSameTarget = 0;
static volatile LONG  g_recognizedTransit = 0;
/* Instrumentacao do gate de pendencia: prova que a condicao foi EXERCITADA,
 * nao apenas que o desarme terminou limpo. */
static volatile LONG  g_pendingDbSeen = 0;      /* vezes com #DB pendente */
static volatile LONG  g_pendingDbWaitedMs = 0;  /* soma do tempo esperado */
static volatile LONG  g_pendingDbTimeout = 0;   /* vezes que estourou budget */
static volatile LONG  g_gateChecks = 0;         /* vezes que o gate rodou */

static uint64_t g_moduleBase = 0;
static uint64_t g_targetVA = 0;
static uint32_t g_targetRva = 0;
static int      g_slot = -1;

static LONG g_maxEvents = 5;
static LONG g_maxSeconds = 60;

static uint32_t g_armedTid[MAX_ARMED];
static int      g_armedCount = 0;
/* Snapshot de quem foi armado NO START. `g_armedCount` vai a 0 no desarme
 * (e' o que torna o VEH inerte), entao a cobertura precisa deste registro
 * separado -- senao o relatorio final diria "0 threads armadas" e perderia
 * justamente a informacao que qualifica o resultado. */
static uint32_t g_startArmedTid[MAX_ARMED];
static int      g_startArmedCount = 0;
static uint32_t g_reqTid[MAX_ARMED];
static int      g_reqCount = 0;
static int      g_allowAll = 0;      /* threads=* */
static int      g_coverageMode = -1; /* 0 = lista, 1 = todas */

static PENDING  g_armFailed[MAX_PENDING];
static int      g_armFailedCount = 0;
/* Cobertura de threads=*, contada de forma explicita. Cobertura parcial nao
 * pode ser confundida com sucesso total: quem ler o JSON ve os tres numeros. */
static int g_covSnapshot = 0;   /* threads vistas no snapshot inicial */
static int g_covArmed = 0;      /* armadas com sucesso */
static int g_covRefused = 0;    /* snapshot menos armadas (falha de armamento) */
static int g_covGoneBefore = 0; /* sumiram entre snapshot e armamento */
static PENDING  g_disarmPending[MAX_PENDING];
static int      g_disarmPendingCount = 0;

static EVENT    g_events[MAX_EVENTS];
static PVOID    g_veh = NULL;
static HANDLE   g_worker = NULL;
static volatile LONG g_workerStop = 0;

static char g_outPath[MAX_PATH];
static char g_cfgPath[MAX_PATH];
static char g_moduleName[128] = "pokealliance_dx.exe";

static void ulog(const char *fmt, ...)
{
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);

    char path[MAX_PATH];
    DWORD n = GetTempPathA((DWORD)sizeof path, path);
    if (n > 0 && n < sizeof path) {
        strncat(path, "pka_walktrace_boot.log", sizeof path - strlen(path) - 1);
        FILE *f = fopen(path, "a");
        if (f) { fprintf(f, "%lu %s\n", (unsigned long)GetTickCount(), line); fclose(f); }
    }
}

static uint64_t dr_of(const CONTEXT *c, int slot)
{
    switch (slot) {
    case 0: return c->Dr0;
    case 1: return c->Dr1;
    case 2: return c->Dr2;
    case 3: return c->Dr3;
    default: return 0;
    }
}

static void set_dr(CONTEXT *c, int slot, uint64_t v)
{
    switch (slot) {
    case 0: c->Dr0 = v; break;
    case 1: c->Dr1 = v; break;
    case 2: c->Dr2 = v; break;
    case 3: c->Dr3 = v; break;
    default: break;
    }
}

static int slot_is_free(const CONTEXT *c, int slot)
{
    if (dr_of(c, slot) != 0) return 0;
    if (c->Dr7 & DR7_LOCAL(slot)) return 0;
    if (c->Dr7 & DR7_GLOBAL(slot)) return 0;
    /* RW/LEN do slot devem estar zerados tambem: 4 bits a partir de 16+4n */
    if (c->Dr7 & (0xFu << (16 + 4 * slot))) return 0;
    return 1;
}

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */
static void trim(char *s)
{
    char *p = s;
    while (*p == ' ' || *p == '\t') p++;
    if (p != s) memmove(s, p, strlen(p) + 1);
    size_t n = strlen(s);
    while (n && (s[n-1] == '\n' || s[n-1] == '\r' || s[n-1] == ' ' || s[n-1] == '\t'))
        s[--n] = 0;
}

static int read_config(void)
{
    const char *env = getenv("PKA_WALKTRACE_CONFIG");
    if (env && *env) {
        snprintf(g_cfgPath, sizeof g_cfgPath, "%s", env);
    } else {
        char module[MAX_PATH];
        HMODULE self = NULL;
        if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                               (LPCSTR)(uintptr_t)&read_config, &self)) {
            DWORD len = GetModuleFileNameA(self, module, (DWORD)sizeof module);
            if (len > 0 && len < sizeof module) {
                char *slash = strrchr(module, '\\');
                if (slash) {
                    *(slash + 1) = 0;
                    snprintf(g_cfgPath, sizeof g_cfgPath, "%spka_walktrace_config.txt", module);
                }
            }
        }
    }
    if (!g_cfgPath[0]) return 0;

    FILE *f = fopen(g_cfgPath, "rb");
    if (!f) return 0;

    char line[512];
    while (fgets(line, sizeof line, f)) {
        trim(line);
        if (!line[0] || line[0] == '#') continue;
        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = 0;
        trim(line);
        char *val = eq + 1;
        trim(val);

        if (!strcmp(line, "module")) {
            snprintf(g_moduleName, sizeof g_moduleName, "%s", val);
        } else if (!strcmp(line, "rva")) {
            g_targetRva = (uint32_t)strtoul(val, NULL, 16);
        } else if (!strcmp(line, "max_events")) {
            g_maxEvents = (LONG)strtol(val, NULL, 10);
        } else if (!strcmp(line, "max_seconds")) {
            g_maxSeconds = (LONG)strtol(val, NULL, 10);
        } else if (!strcmp(line, "out")) {
            snprintf(g_outPath, sizeof g_outPath, "%s", val);
        } else if (!strcmp(line, "threads")) {
            if (!strcmp(val, "*")) { g_allowAll = 1; continue; }
            char *p = val;
            while (*p && g_reqCount < MAX_ARMED) {
                char *end = NULL;
                unsigned long t = strtoul(p, &end, 10);
                if (end == p) break;
                g_reqTid[g_reqCount++] = (uint32_t)t;
                p = (*end == ',') ? end + 1 : end;
                while (*p == ' ') p++;
            }
        }
    }
    fclose(f);

    if (g_maxEvents < 1) g_maxEvents = 1;
    if (g_maxEvents > MAX_EVENTS) g_maxEvents = MAX_EVENTS;
    if (g_maxSeconds < 0) g_maxSeconds = 0;
    return 1;
}

static void thread_list(uint32_t *out, int *count, int cap)
{
    *count = 0;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) return;
    THREADENTRY32 te; te.dwSize = sizeof te;
    DWORD pid = GetCurrentProcessId();
    if (Thread32First(snap, &te)) {
        do {
            if (te.th32OwnerProcessID != pid) continue;
            if (*count >= cap) break;
            out[(*count)++] = te.th32ThreadID;
        } while (Thread32Next(snap, &te));
    }
    CloseHandle(snap);
}

/* ------------------------------------------------------------------ */
/* arm / disarm por thread                                             */
/* ------------------------------------------------------------------ */
static int tid_in_armed(uint32_t tid)
{
    for (int i = 0; i < g_armedCount; i++)
        if (g_armedTid[i] == tid) return 1;
    return 0;
}

/* O slot tem de estar livre em TODAS as threads alvo. */
static int pick_slot(const uint32_t *tids, int count)
{
    for (int slot = 0; slot < 4; slot++) {
        int freeEverywhere = 1;
        for (int i = 0; i < count && freeEverywhere; i++) {
            HANDLE th = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT,
                                   FALSE, tids[i]);
            if (!th) continue;   /* thread morta: nao bloqueia o slot */
            int self = (tids[i] == GetCurrentThreadId());
            DWORD prev = 0;
            if (!self) {
                prev = SuspendThread(th);
                if (prev == (DWORD)-1) { CloseHandle(th); continue; }
            }
            CONTEXT ctx; memset(&ctx, 0, sizeof ctx);
            ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
            if (GetThreadContext(th, &ctx) && !slot_is_free(&ctx, slot))
                freeEverywhere = 0;
            if (!self) ResumeThread(th);
            CloseHandle(th);
        }
        if (freeEverywhere) return slot;
    }
    return -1;
}

static int arm_one(uint32_t tid, int slot, uint32_t *err)
{
    HANDLE th = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                           THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION |
                           SYNCHRONIZE, FALSE, tid);
    if (!th) { *err = GetLastError(); return 0; }

    int self = (tid == GetCurrentThreadId());
    DWORD prev = 0;
    if (!self) {
        prev = SuspendThread(th);
        if (prev == (DWORD)-1) {
            *err = GetLastError();
            CloseHandle(th);
            return 0;
        }
    }

    int ok = 0;
    CONTEXT ctx; memset(&ctx, 0, sizeof ctx);
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (GetThreadContext(th, &ctx)) {
        if (!slot_is_free(&ctx, slot)) {
            *err = ERROR_BUSY;
        } else {
            set_dr(&ctx, slot, g_targetVA);
            ctx.Dr7 &= ~(DR7_LOCAL(slot) | DR7_GLOBAL(slot));
            ctx.Dr7 &= ~(0xFu << (16 + 4 * slot));   /* RW=00 exec, LEN=00 */
            ctx.Dr7 |= DR7_LOCAL(slot);              /* so' local */
            ctx.Dr6 &= ~DR6_BIT(slot);               /* limpa so' o nosso bit */
            if (SetThreadContext(th, &ctx)) ok = 1;
            else *err = GetLastError();
        }
    } else {
        *err = GetLastError();
    }

    if (!self) ResumeThread(th);   /* desfaz exatamente a NOSSA suspensao */
    CloseHandle(th);
    return ok;
}

/* Uma thread que ja' saiu nao pode segurar breakpoint nenhum: o estado de
 * debug morre com a thread. Tratar isso como "falha de desarme" produziria
 * falso alarme e impediria declarar encerramento limpo. Os estados de thread
 * sao: STILL_ACTIVE (259) = viva; WAIT_OBJECT_0 = sinalizada = saiu. */
static int thread_is_gone(HANDLE th)
{
    if (WaitForSingleObject(th, 0) == WAIT_OBJECT_0) return 1;
    DWORD code = 0;
    if (GetExitCodeThread(th, &code) && code != STILL_ACTIVE) return 1;
    return 0;
}

static int wait_pending_db(uint32_t tid, int slot, int budgetMs, uint32_t *err);

/* kind: 0 ok, 1 gone, 2 failed */
static int disarm_one(uint32_t tid, int slot, uint32_t *err)
{
    HANDLE th = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                           THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION |
                           SYNCHRONIZE, FALSE, tid);
    if (!th) {
        *err = GetLastError();
        /* ERROR_INVALID_PARAMETER = tid nao existe mais; qualquer falha de
         * abertura tambem implica que nao temos nada armado ali. */
        return 1;
    }
    if (thread_is_gone(th)) { CloseHandle(th); return 1; }

    int self = (tid == GetCurrentThreadId());
    DWORD prev = 0;
    if (!self) {
        prev = SuspendThread(th);
        if (prev == (DWORD)-1) {
            *err = GetLastError();
            /* corrida: saiu entre a checagem e o suspend */
            int gone = thread_is_gone(th);
            CloseHandle(th);
            return gone ? 1 : 2;
        }
    }

    int res = 0;
    CONTEXT ctx; memset(&ctx, 0, sizeof ctx);
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (GetThreadContext(th, &ctx)) {
        /* Antes de limpar: garantir que nao ha #DB nosso pendente. */
        if (ctx.Dr6 & DR6_BIT(slot)) {
            if (!self) ResumeThread(th);
            CloseHandle(th);
            /* reentra pela versao que espera; devolve 2 se nao conseguir */
            uint32_t werr = 0;
            if (!wait_pending_db(tid, slot, 500, &werr)) {
                *err = werr;
                return 2;
            }
            return disarm_one(tid, slot, err);   /* recursao: estado mudou */
        }

        /* Uma thread terminada ainda permite SuspendThread e GetThreadContext,
         * mas SetThreadContext devolve ACCESS_DENIED. O estado de debug morre
         * com a thread, entao isso e' "gone", nao "falha". */
        if (thread_is_gone(th)) { if (!self) ResumeThread(th); CloseHandle(th); return 1; }

        /* DESARME SEM PERDER ATRIBUICAO.
         *
         * Desliga L0/G0 (a CPU para de gerar #DB) mas MANTEM Dr_n apontando o
         * alvo. Dr_n retido e' a marca de origem: uma excecao ja' levantada
         * chega com Dr_n == alvo e ainda e' reconhecida; uma de terceiro no
         * mesmo endereco ja' teria Dr_n diferente ou slot desligado por ele.
         *
         * Nao zeramos Dr6: ele nao e' criterio (medido instavel). */
        if (dr_of(&ctx, slot) == g_targetVA) {
            /* LIMPEZA TOTAL do nosso slot.
             *
             * Medido (diag_dr0keep.c): o kernel ZERA Dr0..Dr3 quando nenhum
             * L/G fica ligado. Ou seja, "manter Dr_n como marca com L0 off"
             * e' impossivel -- nao existe estado de debug sem slot habilitado.
             *
             * Logo, a atribuicao de excecao em transito nao pode vir do Dr_n
             * apos o desarme. Ela vem de nao desarmar enquanto houver #DB
             * pendente: `wait_pending_db()` le Dr6.B<slot> de cada thread
             * ANTES de limpar. Ver o Stop. */
            set_dr(&ctx, slot, 0);
            ctx.Dr7 &= ~(DR7_LOCAL(slot) | DR7_GLOBAL(slot));
            ctx.Dr7 &= ~(0xFu << (16 + 4 * slot));
            ctx.Dr6 &= ~DR6_BIT(slot);
            ulog("disarm tid=%lu slot=%d ctxDr0=0x%llx ctxDr7=0x%llx",
                 (unsigned long)tid, slot,
                 (unsigned long long)ctx.Dr0, (unsigned long long)ctx.Dr7);
            if (!SetThreadContext(th, &ctx)) {
                *err = GetLastError();
                res = thread_is_gone(th) ? 1 : 2;
            }
        } else if (dr_of(&ctx, slot) == 0 &&
                   !(ctx.Dr7 & (DR7_LOCAL(slot) | DR7_GLOBAL(slot)))) {
            res = 0;   /* ja' limpo */
        } else {
            *err = ERROR_BUSY;   /* outro dono agora: nao e' nosso para limpar */
            res = 2;
        }
    } else {
        *err = GetLastError();
        res = 2;
    }

    if (!self) ResumeThread(th);
    CloseHandle(th);
    return res;
}

/* Espera nao haver #DB pendente do nosso slot nesta thread.
 *
 * POR QUE ISSO E' DETERMINISTICO E NAO UMA JANELA DE TEMPO
 *
 * O hardware seta Dr6.B<n> no instante em que levanta o #DB. So' o handler
 * limpa esse bit. Portanto:
 *
 *   thread SUSPENSA + Dr6.B<n> == 0  =>  nao existe #DB nosso a caminho.
 *
 * Uma thread suspensa nao executa a instrucao de breakpoint, entao nao pode
 * levantar um novo #DB enquanto checamos. Nao ha corrida: a decisao de limpar
 * e' tomada contra um estado congelado.
 *
 * Se Dr6.B<n> == 1, ha excecao levantada e nao entregue. Retomamos a thread
 * para o VEH consumi-la (o handler limpa o bit) e tentamos de novo. Nao
 * limpamos nada nesse meio-tempo -- que era exatamente o defeito: limpar com
 * excecao pendente fazia o handler ve-la com o bit zerado.
 *
 * Devolve 1 = seguro para desarmar, 0 = nao conseguiu (nao desarme!).
 */
static int wait_pending_db(uint32_t tid, int slot, int budgetMs, uint32_t *err)
{
    InterlockedIncrement(&g_gateChecks);
    for (int waited = 0; waited <= budgetMs; waited += 2) {
        HANDLE th = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                               THREAD_QUERY_INFORMATION | SYNCHRONIZE,
                               FALSE, tid);
        if (!th) { *err = GetLastError(); return 1; }   /* sumiu: nada pendente */
        if (thread_is_gone(th)) { CloseHandle(th); return 1; }

        DWORD prev = SuspendThread(th);
        if (prev == (DWORD)-1) {
            *err = GetLastError();
            int gone = thread_is_gone(th);
            CloseHandle(th);
            return gone ? 1 : 0;
        }

        int pending = -1;
        CONTEXT ctx; memset(&ctx, 0, sizeof ctx);
        ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
        if (GetThreadContext(th, &ctx))
            pending = (ctx.Dr6 & DR6_BIT(slot)) ? 1 : 0;

        ResumeThread(th);
        CloseHandle(th);

        if (pending == 0) return 1;   /* seguro */
        if (pending > 0) {
            InterlockedIncrement(&g_pendingDbSeen);
            /* soma simples: escritor unico e' a thread de desarme */
            g_pendingDbWaitedMs = g_pendingDbWaitedMs + 2;
        }
        if (pending < 0) { *err = GetLastError(); }
        Sleep(2);
    }
    InterlockedIncrement(&g_pendingDbTimeout);
    *err = ERROR_RETRY;              /* ainda pendente: NAO desarmar */
    return 0;
}

/* Relê Dr7 e confirma que o slot esta livre. */
static int verify_one(uint32_t tid, int slot, uint32_t *err)
{
    HANDLE th = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                      THREAD_QUERY_INFORMATION | SYNCHRONIZE, FALSE, tid);
    if (!th) return 1;                        /* nao existe: nada a verificar */
    if (thread_is_gone(th)) { CloseHandle(th); return 1; }

    int self = (tid == GetCurrentThreadId());
    DWORD prev = 0;
    if (!self) {
        prev = SuspendThread(th);
        if (prev == (DWORD)-1) {
            *err = GetLastError();
            int gone = thread_is_gone(th);
            CloseHandle(th);
            return gone ? 1 : 2;
        }
    }

    /* Desarmado = slot desligado E sem Dr_n residual E sem #DB pendente. */
    int clean = 0;
    CONTEXT ctx; memset(&ctx, 0, sizeof ctx);
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (GetThreadContext(th, &ctx)) {
        clean = (!(ctx.Dr7 & (DR7_LOCAL(slot) | DR7_GLOBAL(slot))) &&
                 dr_of(&ctx, slot) == 0 &&
                 !(ctx.Dr6 & DR6_BIT(slot))) ? 1 : 0;
        ulog("verify tid=%lu slot=%d Dr0=0x%llx Dr7=0x%llx Dr6=0x%llx clean=%d",
             (unsigned long)tid, slot, (unsigned long long)ctx.Dr0,
             (unsigned long long)ctx.Dr7, (unsigned long long)ctx.Dr6, clean);
    } else
        *err = GetLastError();

    if (!self) ResumeThread(th);
    CloseHandle(th);
    return clean ? 0 : 2;
}

/* ------------------------------------------------------------------ */
/* reconhecimento                                                     */
/* ------------------------------------------------------------------ */
/* Atribuicao: o Dr0 do slot NOSSO, no contexto da excecao, aponta para o
 * alvo? Isso e' o que o hardware diz naquele instante -- nao um relogio.
 *
 *   active  (L0 ligado)  -> disparo em curso, excecao nova
 *   L0 off, Dr0 == alvo  -> excecao levantada antes do desarme limpar L0
 *
 * Devolve 1 = nossa, 0 = de terceiro.
 */
static int origin_is_ours(const CONTEXT *c, int slot, int *wasActive)
{
    if (!c) return 0;
    if (dr_of(c, slot) != g_targetVA) return 0;
    if (wasActive) *wasActive = (c->Dr7 & DR7_LOCAL(slot)) ? 1 : 0;
    return 1;
}

/* ------------------------------------------------------------------ */
/* handler - MINIMO                                                   */
/* ------------------------------------------------------------------ */
static LONG CALLBACK walktrace_veh(EXCEPTION_POINTERS *info)
{
    if (!info || !info->ExceptionRecord || !info->ContextRecord)
        return EXCEPTION_CONTINUE_SEARCH;

    if (info->ExceptionRecord->ExceptionCode != EXCEPTION_SINGLE_STEP)
        return EXCEPTION_CONTINUE_SEARCH;

    int slot = g_slot;
    if (slot < 0) return EXCEPTION_CONTINUE_SEARCH;

    CONTEXT *c = info->ContextRecord;

    /* (b) endereco */
    if ((uint64_t)(info->ExceptionRecord->ExceptionAddress) != g_targetVA)
        return EXCEPTION_CONTINUE_SEARCH;

    /* (c) ATRIBUICAO POR Dr0 VIVO -- nao por Dr6, nao por timestamp.
     *
     * Dr6 foi descartado por medicao: sob limpeza concorrente, 803 de 25138
     * excecoes chegaram com B0 ja' zerado. Timestamp nao vincula nada a nada.
     *
     * Dr0 no contexto entregue e' estavel e sem ambiguidade (12235 disparos
     * com Dr0==alvo/L0 ligado, 115 em transito com Dr0==alvo/L0 desligado,
     * 0 ambiguos). E o que identifica a ORIGEM do disparo. */
    DWORD tid = GetCurrentThreadId();
    int wasActive = 0;
    if (!origin_is_ours(c, slot, &wasActive))
        return EXCEPTION_CONTINUE_SEARCH;
    if (!wasActive) InterlockedIncrement(&g_recognizedTransit);

    /* ATE' AQUI ja' sabemos que a excecao E' NOSSA: codigo, endereco,
     * Dr6.B<slot> e thread armada. Isso cria a obrigacao de CONSUMIR a
     * excecao, sempre. Devolver CONTINUE_SEARCH para uma excecao nossa com o
     * nosso DR ainda setado mata o processo (SINGLE_STEP sem handler,
     * 0x80000004) -- foi o que aconteceu quando o gate fechava antes de o
     * desarme terminar.
     *
     * Conclusao: o gate controla apenas REGISTRO, nunca o consumo. */
    LONG now = InterlockedIncrement(&g_inHandler);
    if (now > 1) InterlockedIncrement(&g_concurrentEntries);

    int recording = (InterlockedCompareExchange(&g_gateOpen, 1, 1) == 1);
    if (!recording) InterlockedIncrement(&g_droppedWhileClosing);

    /* g_eventCount conta TODA excecao nossa consumida.
     * g_recorded conta o que coube no buffer. Divergem de proposito:
     * g_maxEvents e' teto de REGISTROS, nao de disparos. */
    /* Contadores e sua RELACAO (precisa fechar sempre):
     *
     *   exceptionsObserved  excecoes nossas consumidas pelo handler
     *   recordsAccepted     entradas efetivamente gravadas em g_events[]
     *   recordsDiscarded    = observed - accepted
     *
     * Antes, `g_recorded` contava TENTATIVAS de gravacao, entao `limit` saia
     * com accepted=3 > maxRecords=2. Numeros que nao fecham destroem a
     * confianca no resto do JSON. Agora: reserve primeiro, e so' conte como
     * aceito o que realmente entrou no buffer. */
    LONG idx = recording ? InterlockedIncrement(&g_eventCount) : 0;
    int willStore = 0;
    LONG slotIdx = 0;
    if (recording) {
        slotIdx = InterlockedCompareExchange(&g_recorded, 0, 0);
        for (;;) {
            if (slotIdx >= g_maxEvents || slotIdx >= MAX_EVENTS) break;
            LONG prev = InterlockedCompareExchange(&g_recorded, slotIdx + 1, slotIdx);
            if (prev == slotIdx) { willStore = 1; break; }
            slotIdx = prev;
        }
    }
    if (willStore) {
        /* slotIdx e' INDICE (0-based) reservado; slotIdx+1 e' o ordinal. */
        LONG ordinal = slotIdx + 1;
        EVENT *e = &g_events[slotIdx];
        e->tickMs = GetTickCount64();
        e->rip    = (uint64_t)c->Rip;
        e->tid    = (uint32_t)tid;
        e->rva    = (uint32_t)((uint64_t)c->Rip - g_moduleBase);
        e->dr6    = c->Dr6;
        e->dr7    = (uint32_t)c->Dr7;
        e->rdx    = (uint64_t)c->Rdx;
        e->r8     = (uint64_t)c->R8;
        e->rcx    = (uint64_t)c->Rcx;
        e->index  = ordinal;
    } else if (recording) {
        InterlockedExchange(&g_overflow, 1);
    }

    /* Sem arquivo, sem suspend, sem parada completa aqui. */
    c->EFlags |= 0x10000;          /* RF: nao re-dispara na mesma instrucao */
    c->Dr6 &= ~DR6_BIT(slot);      /* so' o nosso bit */

    /* Pedido de parada assim que o buffer enche. O desarme efetivo acontece
     * depois, na thread de servico: ha uma janela em que novas excecoes ainda
     * sao atendidas e descartadas. Isso e' a corrida esperada e e' contada. */
    if (willStore && (slotIdx + 1) == g_maxEvents &&
        InterlockedCompareExchange(&g_stopRequested,1,1)==0) {
        g_stopRequestedAtMs = GetTickCount64();
        InterlockedExchange(&g_stopReason, STOP_EVENTS);
        InterlockedExchange(&g_stopRequested, 1);
    }

    InterlockedDecrement(&g_inHandler);
    return EXCEPTION_CONTINUE_EXECUTION;
}

/* ------------------------------------------------------------------ */
/* stop - idempotente, com verificacao                                */
/* ------------------------------------------------------------------ */
static void write_json(const char *path, const char *reasonTag);

static LONG do_stop(LONG reason)
{
    LONG s = InterlockedCompareExchange(&g_state, 0, 0);

    if (s == ST_DISARMED || s == ST_DISARM_FAILED)
        return g_finalResult;

    LONG expected = ST_ARMED;
    if (InterlockedCompareExchange(&g_state, ST_STOPPING, expected) != expected) {
        s = InterlockedCompareExchange(&g_state, 0, 0);
        if (s == ST_STOPPING) {
            for (int i = 0; i < 2000; i++) {
                Sleep(5);
                LONG t = InterlockedCompareExchange(&g_state, 0, 0);
                if (t == ST_DISARMED || t == ST_DISARM_FAILED) return g_finalResult;
            }
            return ST_DISARM_FAILED;
        }
        if (s == ST_IDLE) { g_finalResult = ST_IDLE; return ST_IDLE; }
        return g_finalResult;
    }

    if (reason != STOP_NONE) InterlockedExchange(&g_stopReason, reason);
    InterlockedExchange(&g_stopRequested, 1);

    /* FASE 1 do gate: fecha a porta para NOVAS entradas do handler.
     * Daqui em diante um SingleStep nosso nao e' mais atendido por nos, e o
     * handler delega com CONTINUE_SEARCH. Intencional: e' melhor delegar do
     * que correr o risco de o VEH sumir com callback em voo. */
    InterlockedExchange(&g_gateOpen, 0);

    /* FASE 2: drena o que ja' entrou. Callback legitimo dura microssegundos;
     * o teto existe so' para nao travar para sempre se algo deu muito errado.
     * Se NAO drenar, nao desarmamos nada e o estado e' DISARM_FAILED. */
    int drained = 0;
    for (int i = 0; i < 4000; i++) {
        if (InterlockedCompareExchange(&g_inHandler, 0, 0) == 0) { drained = 1; break; }
        Sleep(1);
    }
    if (!drained) {
        InterlockedExchange(&g_state, ST_DISARM_FAILED);
        g_finalResult = ST_DISARM_FAILED;
        InterlockedExchange(&g_armed, 0);
        ulog("stop: handler nao drenou (inHandler=%ld); handler mantido",
             (long)InterlockedCompareExchange(&g_inHandler, 0, 0));
        write_json(g_outPath, "handler_busy");
        return ST_DISARM_FAILED;
    }

    int anyFailed = 0;
    int slot = g_slot;

    EnterCriticalSection(&g_lock);
    for (int i = 0; i < g_armedCount; i++) {
        uint32_t err = 0;
        /* Gate de pendencia: SEMPRE antes de desarmar. Nao e' um timer -- e'
         * uma leitura de Dr6.B<slot> com a thread suspensa. Se houver #DB
         * levantado e nao entregue, retomamos a thread para o VEH consumir e
         * tentamos de novo; se nao houver, desarmamos contra estado congelado.
         * Limpar com #DB pendente era o que fazia o handler ver Dr6 zerado. */
        if (!wait_pending_db(g_armedTid[i], slot, 500, &err)) {
            if (g_disarmPendingCount < MAX_PENDING) {
                g_disarmPending[g_disarmPendingCount].tid = g_armedTid[i];
                g_disarmPending[g_disarmPendingCount].err = err;
                g_disarmPending[g_disarmPendingCount].kind = 2;
                g_disarmPending[g_disarmPendingCount].stage = 5;  /* pendente */
                g_disarmPendingCount++;
            }
            anyFailed = 1;
            continue;   /* NAO desarma esta thread */
        }
        int r = disarm_one(g_armedTid[i], slot, &err);
        if (r == 2) {
            if (g_disarmPendingCount < MAX_PENDING) {
                g_disarmPending[g_disarmPendingCount].tid = g_armedTid[i];
                g_disarmPending[g_disarmPendingCount].err = err;
                g_disarmPending[g_disarmPendingCount].kind = 2;
                g_disarmPending[g_disarmPendingCount].stage = 3;
                g_disarmPendingCount++;
            }
            anyFailed = 1;
        }
    }
    LeaveCriticalSection(&g_lock);

    /* verificacao: Dr7 relido */
    EnterCriticalSection(&g_lock);
    for (int i = 0; i < g_armedCount; i++) {
        uint32_t err = 0;
        int r = verify_one(g_armedTid[i], slot, &err);
        if (r == 2) {
            int dup = 0;
            for (int k = 0; k < g_disarmPendingCount; k++)
                if (g_disarmPending[k].tid == g_armedTid[i]) dup = 1;
            if (!dup && g_disarmPendingCount < MAX_PENDING) {
                g_disarmPending[g_disarmPendingCount].tid = g_armedTid[i];
                g_disarmPending[g_disarmPendingCount].err = err;
                g_disarmPending[g_disarmPendingCount].kind = 2;
                g_disarmPending[g_disarmPendingCount].stage = 3;
                g_disarmPendingCount++;
            }
            anyFailed = 1;
        }
    }
    LeaveCriticalSection(&g_lock);

    if (anyFailed) {
        /* NAO declaramos limpo. O handler fica, o estado e' DISARM_FAILED e a
         * lista de armados fica INTACTA (ainda pode haver DR nosso setado, e
         * essas threads continuam sendo nossas). disarmVerified = 0. */
        InterlockedExchange(&g_recordingEnabled, 0);
        InterlockedExchange(&g_disarmVerified, 0);
        InterlockedExchange(&g_state, ST_DISARM_FAILED);
        g_finalResult = ST_DISARM_FAILED;
        ulog("stop: DISARM_FAILED, %d pendencias; handler mantido", g_disarmPendingCount);
        write_json(g_outPath, "disarm_failed");
        return ST_DISARM_FAILED;
    }

    InterlockedExchange(&g_armed, 0);
    InterlockedExchange(&g_recordingEnabled, 0);

    /* O VEH NAO e' removido. Uma excecao ja' despachada pode chegar depois do
     * drain; remover o VEH agora recria o 0x80000004 (medido, 3 em 20). */

    /* NAO existe janela de tempo. A atribuicao de excecao em transito vem de
     * Dr_n, que ficou setado no desarme (ver disarm_one).
     *
     * A lista de armados AGORA e' esvaziada -- mas isso nao perde atribuicao:
     * o handler nao consulta a lista para decidir; consulta o Dr_n do proprio
     * contexto entregue (`origin_is_ours`). A lista serve para o desarme e
     * para o relatorio.
     *
     * Consequencia: uma excecao nossa em transito continua sendo consumida
     * independente de quanto tarde (nao ha prazo a expirar). Uma excecao de
     * TERCEIRO no mesmo endereco so' seria confundida se ele apontasse o
     * Dr_n para o mesmo alvo -- ambiguidade por construcao, contada em
     * g_ambiguousSameTarget, nao adivinhada. */
    EnterCriticalSection(&g_lock);
    for (int i = 0; i < g_armedCount; i++) g_armedTid[i] = 0;
    g_armedCount = 0;
    LeaveCriticalSection(&g_lock);

    InterlockedExchange(&g_disarmVerified, 1);
    g_disarmedAtMs = GetTickCount64();
    InterlockedExchange(&g_state, ST_DISARMED);
    g_finalResult = ST_DISARMED;
    write_json(g_outPath, "clean");
    return ST_DISARMED;
}

/* ------------------------------------------------------------------ */
/* relatorio (fora do handler)                                        */
/* ------------------------------------------------------------------ */
static void write_json(const char *path, const char *reasonTag)
{
    if (!path || !path[0]) return;
    char tmp[MAX_PATH];
    snprintf(tmp, sizeof tmp, "%s.tmp", path);
    FILE *f = fopen(tmp, "w");
    if (!f) return;

    LONG st = InterlockedCompareExchange(&g_state, 0, 0);
    const char *stName = st == ST_IDLE ? "idle"
        : st == ST_PREPARED ? "prepared"
        : st == ST_ARMED ? "armed"
        : st == ST_STOPPING ? "stopping"
        : st == ST_DISARMED ? "disarmed" : "disarm_failed";

    fprintf(f, "{\n  \"state\": \"%s\",\n", stName);
    fprintf(f, "  \"reason\": \"%s\",\n", reasonTag);
    fprintf(f, "  \"module\": \"%s\",\n", g_moduleName);
    fprintf(f, "  \"moduleBase\": %llu,\n", (unsigned long long)g_moduleBase);
    fprintf(f, "  \"targetRva\": %u,\n", g_targetRva);
    fprintf(f, "  \"targetVa\": %llu,\n", (unsigned long long)g_targetVA);
    fprintf(f, "  \"slot\": %d,\n", g_slot);
    fprintf(f, "  \"stopReason\": %ld,\n", (long)g_stopReason);
    /* `eventsObserved` e' tudo que o handler viu; `eventsRecorded` e' o que
     * coube no buffer. Podem diferir: quando o limite e' atingido, eventos de
     * outras threads que ja' estavam em voo ainda incrementam o observado
     * antes de a thread de servico desarmar. Isso e' honesto, e e' por isso
     * que os dois numeros existem separados. */
    fprintf(f, "  \"exceptionsObserved\": %ld,\n", (long)g_eventCount);
    fprintf(f, "  \"recordsAccepted\": %ld,\n", (long)g_recorded);
    fprintf(f, "  \"recordsDiscarded\": %ld,\n",
            (long)(g_eventCount > g_recorded ? g_eventCount - g_recorded : 0));
    fprintf(f, "  \"maxRecords\": %ld,\n", (long)g_maxEvents);
    fprintf(f, "  \"concurrentEntries\": %ld,\n", (long)g_concurrentEntries);
    fprintf(f, "  \"droppedWhileClosing\": %ld,\n", (long)g_droppedWhileClosing);
    fprintf(f, "  \"inHandlerAtReport\": %ld,\n", (long)g_inHandler);
    fprintf(f, "  \"stopRequestedAtMs\": %lld,\n", (long long)g_stopRequestedAtMs);
    fprintf(f, "  \"disarmedAtMs\": %lld,\n", (long long)g_disarmedAtMs);
    fprintf(f, "  \"maxSeconds\": %ld,\n", (long)g_maxSeconds);
    fprintf(f, "  \"overflow\": %ld,\n", (long)g_overflow);

    /* ---- contrato de estado: um conceito por campo ---- */
    fprintf(f, "  \"handlerRegistered\": %ld,\n",
            (long)g_handlerRegistered);
    fprintf(f, "  \"recordingEnabled\": %ld,\n",
            (long)g_recordingEnabled);
    fprintf(f, "  \"armedThreads\": %d,\n", g_startArmedCount);
    fprintf(f, "  \"armedThreadsLive\": %d,\n", g_armedCount);
    fprintf(f, "  \"disarmVerified\": %ld,\n", (long)g_disarmVerified);
    /* Atribuicao por Dr_n: sem janela, sem carimbo. Estes dois campos existem
     * para provar, no JSON, que a classificacao foi feita por hardware. */
    fprintf(f, "  \"recognizedTransit\": %ld,\n",
            (long)g_recognizedTransit);
    fprintf(f, "  \"gateChecks\": %ld,\n", (long)g_gateChecks);
    fprintf(f, "  \"pendingDbSeen\": %ld,\n", (long)g_pendingDbSeen);
    fprintf(f, "  \"pendingDbWaitedMs\": %ld,\n", (long)g_pendingDbWaitedMs);
    fprintf(f, "  \"pendingDbTimeout\": %ld,\n", (long)g_pendingDbTimeout);
    fprintf(f, "  \"ambiguousSameTarget\": %ld,\n",
            (long)g_ambiguousSameTarget);
    fprintf(f, "  \"attribution\": \"dr0-at-entry\",\n");
    fprintf(f, "  \"guarantee\": \"observed-not-documented\",\n");
    fprintf(f, "  \"coverageMode\": \"%s\",\n",
            g_coverageMode == 1 ? "all-threads-explicit" :
            g_coverageMode == 0 ? "explicit-list" : "none");
    fprintf(f, "  \"threadsConfigured\": %d,\n", g_reqCount);
    fprintf(f, "  \"coverage\": {\"snapshot\": %d, \"armed\": %d, "
               "\"refused\": %d, \"goneBeforeArm\": %d, "
               "\"lateThreadsArmed\": 0},\n",
            g_covSnapshot, g_covArmed, g_covRefused, g_covGoneBefore);
    fprintf(f, "  \"armedTidsAtStartCount\": %d,\n  \"armedTidsAtStart\": [",
            g_startArmedCount);
    for (int i = 0; i < g_startArmedCount; i++)
        fprintf(f, "%s%u", i ? "," : "", g_startArmedTid[i]);
    fprintf(f, "],\n  \"armedTidsLiveCount\": %d,\n  \"armedTidsLive\": [",
            g_armedCount);
    for (int i = 0; i < g_armedCount; i++)
        fprintf(f, "%s%u", i ? "," : "", g_armedTid[i]);
    fprintf(f, "],\n  \"armFailedCount\": %d,\n  \"armFailed\": [", g_armFailedCount);
    for (int i = 0; i < g_armFailedCount; i++)
        fprintf(f, "%s{\"tid\":%u,\"err\":%u}", i ? "," : "",
                g_armFailed[i].tid, g_armFailed[i].err);
    fprintf(f, "],\n  \"disarmPendingCount\": %d,\n  \"disarmPending\": [",
            g_disarmPendingCount);
    for (int i = 0; i < g_disarmPendingCount; i++)
        fprintf(f, "%s{\"tid\":%u,\"err\":%u,\"stage\":%u}", i ? "," : "",
                g_disarmPending[i].tid, g_disarmPending[i].err, g_disarmPending[i].stage);
    fprintf(f, "],\n  \"eventList\": [");
    LONG n = g_recorded;
    if (n > g_maxEvents) n = g_maxEvents;
    if (n > MAX_EVENTS) n = MAX_EVENTS;
    for (LONG i = 0; i < n; i++) {
        EVENT *e = &g_events[i];
        fprintf(f,
            "%s{\"i\":%ld,\"tickMs\":%llu,\"tid\":%u,\"rip\":%llu,\"rva\":%u,"
            "\"dr6\":%u,\"dr7\":%u,\"rdx\":%llu,\"r8\":%llu,\"rcx\":%llu}",
            i ? "," : "", e->index, (unsigned long long)e->tickMs, e->tid,
            (unsigned long long)e->rip, e->rva, e->dr6, e->dr7,
            (unsigned long long)e->rdx, (unsigned long long)e->r8,
            (unsigned long long)e->rcx);
    }
    fprintf(f, "]\n}\n");
    fclose(f);
    remove(path);
    rename(tmp, path);
}

/* ------------------------------------------------------------------ */
/* worker: observa limite de tempo e faz a parada                     */
/* ------------------------------------------------------------------ */
static DWORD WINAPI worker_thread(LPVOID arg)
{
    (void)arg;
    ULONGLONG start = GetTickCount64();
    ULONGLONG limit = (ULONGLONG)g_maxSeconds * 1000ULL;

    for (;;) {
        if (InterlockedCompareExchange(&g_workerStop, 1, 1) == 1) break;

        if (InterlockedCompareExchange(&g_stopRequested, 1, 1) == 1) {
            do_stop(STOP_NONE);
            break;
        }
        if (limit > 0 && GetTickCount64() - start >= limit) {
            do_stop(STOP_TIME);
            break;
        }
        Sleep(50);
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* exports                                                             */
/* ------------------------------------------------------------------ */
__declspec(dllexport) LONG WINAPI PkaWalkTraceState(void)
{
    return InterlockedCompareExchange(&g_state, 0, 0);
}

__declspec(dllexport) LONG WINAPI PkaWalkTraceStop(LPVOID param)
{
    (void)param;
    return do_stop(STOP_EXPLICIT);
}

__declspec(dllexport) LONG WINAPI PkaWalkTraceEvents(void)
{
    return InterlockedCompareExchange(&g_eventCount, 0, 0);
}

__declspec(dllexport) int WINAPI PkaWalkTraceReport(char *buf, int len)
{
    if (!g_outPath[0]) return 0;
    FILE *f = fopen(g_outPath, "rb");
    if (!f) return 0;
    int n = (int)fread(buf, 1, (size_t)(len - 1), f);
    fclose(f);
    buf[n > 0 ? n : 0] = 0;
    return n;
}

__declspec(dllexport) int WINAPI PkaWalkTraceVerifyDisarmed(void)
{
    if (g_slot < 0) return 0;
    int still = 0;
    for (int i = 0; i < g_armedCount; i++) {
        uint32_t err = 0;
        if (verify_one(g_armedTid[i], g_slot, &err) == 2) still++;
    }
    return still;
}

__declspec(dllexport) LONG WINAPI PkaWalkTraceStart(LPVOID param)
{
    (void)param;

    if (InterlockedCompareExchange(&g_state, ST_PREPARED, ST_IDLE) != ST_IDLE) {
        LONG s = InterlockedCompareExchange(&g_state, 0, 0);
        ulog("start recusado: estado %ld", (long)s);
        return s;
    }

    if (!g_lockReady) { InitializeCriticalSection(&g_lock); g_lockReady = 1; }

    if (!read_config()) {
        ulog("config ausente (%s); nao arma", g_cfgPath);
        InterlockedExchange(&g_state, ST_IDLE);
        return ST_IDLE;
    }

    HMODULE mod = GetModuleHandleA(g_moduleName);
    if (!mod) {
        ulog("modulo %s nao carregado; nao arma", g_moduleName);
        InterlockedExchange(&g_state, ST_IDLE);
        return ST_IDLE;
    }
    g_moduleBase = (uint64_t)(uintptr_t)mod;
    g_targetVA = g_moduleBase + g_targetRva;

    /* threads alvo */
    uint32_t all[MAX_ARMED];
    int allCount = 0;
    thread_list(all, &allCount, MAX_ARMED);

    uint32_t target[MAX_ARMED];
    int targetCount = 0;
    g_coverageMode = (g_reqCount > 0) ? 0 : (g_allowAll ? 1 : -1);
    if (g_reqCount > 0) {
        /* Lista explicita: so' essas threads. TID que nao existe hoje fica de
         * fora e entra em armFailed (nao inventamos thread). */
        for (int i = 0; i < g_reqCount && targetCount < MAX_ARMED; i++)
            target[targetCount++] = g_reqTid[i];
    } else if (g_allowAll) {
        /* Omissao de `threads=` NAO e' autorizacao silenciosa. So' arma em
         * todas se a config disser `threads=*` explicitamente. */
        for (int i = 0; i < allCount && targetCount < MAX_ARMED; i++)
            target[targetCount++] = all[i];
    } else {
        ulog("config sem 'threads' e sem 'threads=*': RECUSA armar");
        InterlockedExchange(&g_state, ST_IDLE);
        g_coverageMode = 0;
        write_json(g_outPath, "no_thread_selection");
        return ST_IDLE;
    }

    g_covSnapshot = targetCount;
    g_covArmed = 0;
    g_covRefused = 0;
    g_covGoneBefore = 0;

    int slot = pick_slot(target, targetCount);
    if (slot < 0) {
        ulog("nenhum slot de debug livre em todas as threads; RECUSA armar");
        InterlockedExchange(&g_state, ST_IDLE);
        return ST_IDLE;
    }
    g_slot = slot;

    /* VEH registrado por ultimo na cadeia. NAO e' removido no Stop (ver la'),
     * entao `handlerRegistered` fica 1 pelo resto da vida do processo. */
    g_veh = AddVectoredExceptionHandler(0, walktrace_veh);
    if (!g_veh) {
        ulog("AddVectoredExceptionHandler falhou: %lu", GetLastError());
        g_slot = -1;
        InterlockedExchange(&g_state, ST_IDLE);
        return ST_IDLE;
    }
    InterlockedExchange(&g_handlerRegistered, 1);

    /* Pre-condicao de armamento parcial: se qualquer thread falhar, o que ja'
     * foi escrito e' REVERTIDO (rollback). Nao deixamos metade armada e
     * chamamos isso de sucesso. */
    EnterCriticalSection(&g_lock);
    for (int i = 0; i < targetCount; i++) {
        uint32_t err = 0;
        /* ORDEM IMPORTA, e o teste pegou isso: o TID entra na lista de armados
         * ANTES de o DR ser escrito. Se fosse depois, existiria uma janela em
         * que a thread dispara o breakpoint que ja' esta' setado mas o handler
         * ainda nao reconhece o TID -- e devolver CONTINUE_SEARCH com o nosso
         * DR ativo mata o processo (0x80000004). Erro de corrida real,
         * reproduzido 2 em 25 execucoes antes da correcao. */
        /* O TID tem de estar VISIVEL para tid_in_armed() antes de arm_one()
         * retomar a thread. arm_one() faz ResumeThread internamente; a thread
         * pode disparar o breakpoint imediatamente. Se g_armedCount so'
         * crescesse depois, o handler veria Dr6 nosso, endereco nosso, mas
         * thread "nao armada" -> CONTINUE_SEARCH com DR ativo -> 0x80000004.
         * Isso explicava a falha intermitente (~2 em 25). */
        int slotInList = g_armedCount;
        if (slotInList < MAX_ARMED) {
            g_armedTid[slotInList] = target[i];
            g_armedCount = slotInList + 1;      /* visivel ANTES de retomar */
        }
        int armed = arm_one(target[i], slot, &err);
        if (!armed) {
            /* thread que nem existe mais: nao e' "recusada", e' "encerrada" */
            uint32_t why = err;
            HANDLE probe = OpenThread(THREAD_QUERY_INFORMATION | SYNCHRONIZE,
                                      FALSE, target[i]);
            int gone = 0;
            if (!probe) gone = 1;
            else {
                if (thread_is_gone(probe)) gone = 1;
                CloseHandle(probe);
            }
            if (gone) g_covGoneBefore++;
            else g_covRefused++;
            (void)why;
            /* remove da lista: nao ficou armada */
            if (slotInList < MAX_ARMED && g_armedCount == slotInList + 1) {
                g_armedCount = slotInList;
                g_armedTid[slotInList] = 0;
            }
            if (g_armFailedCount < MAX_PENDING) {
                g_armFailed[g_armFailedCount].tid = target[i];
                g_armFailed[g_armFailedCount].err = err;
                g_armFailed[g_armFailedCount].kind = 2;
                g_armFailed[g_armFailedCount].stage = 0;
                g_armFailedCount++;
            }
        }
    }
    LeaveCriticalSection(&g_lock);

    if (g_armFailedCount > 0) {
        /* ROLLBACK: desarma exatamente o que armamos e verifica. */
        int rollbackFail = 0;
        for (int i = 0; i < g_armedCount; i++) {
            uint32_t err = 0;
            if (disarm_one(g_armedTid[i], slot, &err) == 2) {
                rollbackFail = 1;
                if (g_disarmPendingCount < MAX_PENDING) {
                    g_disarmPending[g_disarmPendingCount].tid = g_armedTid[i];
                    g_disarmPending[g_disarmPendingCount].err = err;
                    g_disarmPending[g_disarmPendingCount].kind = 2;
                    g_disarmPending[g_disarmPendingCount].stage = 3;
                    g_disarmPendingCount++;
                }
            }
        }
        if (rollbackFail) {
            /* Nao e' seguro nem declarar idle nem remover o VEH. */
            InterlockedExchange(&g_armed, 0);
            InterlockedExchange(&g_state, ST_DISARM_FAILED);
            ulog("armamento parcial: rollback incompleto (%d pendencias)",
                 g_disarmPendingCount);
            write_json(g_outPath, "arm_rollback_failed");
            return ST_DISARM_FAILED;
        }
        /* Rollback limpo: nao ha DR nosso escrito, entao a lista de armados
         * fica vazia e nenhuma thread em transito precisa ser preservada.
         * O VEH fica registrado (nao removemos), inerte. */
        InterlockedExchange(&g_recordingEnabled, 0);
        InterlockedExchange(&g_disarmVerified, 1);
        g_armedCount = 0;
        g_slot = -1;
        InterlockedExchange(&g_armed, 0);
        InterlockedExchange(&g_state, ST_IDLE);
        ulog("armamento parcial: %d falha(s), rollback limpo; nao armado",
             g_armFailedCount);
        write_json(g_outPath, "arm_partial_rolled_back");
        return ST_IDLE;
    }

    g_covArmed = g_armedCount;

    /* snapshot de cobertura, antes de qualquer desarme */
    EnterCriticalSection(&g_lock);
    g_startArmedCount = g_armedCount;
    for (int i = 0; i < g_armedCount && i < MAX_ARMED; i++)
        g_startArmedTid[i] = g_armedTid[i];
    LeaveCriticalSection(&g_lock);

    /* Gate aberto ANTES de qualquer solicitacao de parada do worker. */
    InterlockedExchange(&g_gateOpen, 1);
    InterlockedExchange(&g_recordingEnabled, 1);
    InterlockedExchange(&g_armed, 1);
    InterlockedExchange(&g_state, ST_ARMED);
    ulog("armado slot=%d alvo=%s+0x%x threads ok=%d fail=%d",
         slot, g_moduleName, g_targetRva, g_armedCount, g_armFailedCount);

    g_worker = CreateThread(NULL, 0, worker_thread, NULL, 0, NULL);
    return ST_ARMED;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        /* Nada de trabalho aqui: a partida e' explicita, por export. */
    }
    return TRUE;
}
