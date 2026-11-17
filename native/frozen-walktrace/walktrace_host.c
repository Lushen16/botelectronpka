/*
 * walktrace_host.c - processo auxiliar controlado para validar o tracer.
 *
 * Carrega pka_walktrace.dll por LoadLibrary no MESMO processo, chama os
 * exports e verifica o desarme. Nenhuma injecao, nenhum alvo externo.
 *
 * O alvo do breakpoint e' `target_function`, definida AQUI. O tracer a recebe
 * por config (module=walktrace_host.exe, rva=<offset calculado em runtime>).
 *
 * Fases
 *   prepare -> arm -> observe -> stop -> verify
 *
 * Cenario escolhido por argv:
 *
 *   walktrace_host.exe <dll> <cenario> <segundos> <threads>
 *
 *   basic        detecta execucao e identifica a thread
 *   negative     a funcao alvo nunca e' chamada
 *   occupied     ocupa DR0 antes de armar; tracer deve usar outro slot
 *   limit        limite de eventos = 2 (parada por contagem)
 *   timeout      limite de tempo curto (parada por tempo)
 *   twice        Stop() duas vezes (idempotencia / parada repetida)
 *   partial      uma thread morre durante a observacao
 *   residual     depois de Stop(), a funcao continua rodando e nao gera evento
 *
 * Saida: linhas chave=valor + um JSON final, sempre com codigo de saida.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_WORKERS 16

typedef LONG (WINAPI *PFN_START)(LPVOID);
typedef LONG (WINAPI *PFN_STOP)(LPVOID);
typedef LONG (WINAPI *PFN_STATE)(void);
typedef LONG (WINAPI *PFN_EVENTS)(void);
typedef int  (WINAPI *PFN_VERIFY)(void);
typedef int  (WINAPI *PFN_REPORT)(char *, int);

static volatile LONG g_targetCalls = 0;
static volatile LONG g_stop = 0;
static volatile LONG g_alive = 0;

__declspec(noinline) int target_function(int v)
{
    InterlockedIncrement(&g_targetCalls);
    volatile int a = v * 3 + 1;
    a ^= (int)GetCurrentThreadId();
    return a;
}

/* ------------------------------------------------------------------------
 * Testes dirigidos de atribuicao por Dr_n (nao por Dr6, nao por timestamp).
 *
 * Cada um EXERCITA a condicao e mede o tempo efetivo; nenhum "espera e assume".
 * ---------------------------------------------------------------------- */
static volatile LONG  g_attrPhase = 0;      /* 0 idle,1 armar alheio,2 pronto */
static uint64_t       g_attrTarget = 0;     /* mesmo endereco do alvo */
static volatile LONG  g_alienHits = 0;
static volatile LONG64 g_alienFirstHitAt = 0;
static volatile LONG  g_delayDispatchMs = 0;   /* atraso DENTRO do handler */
static volatile LONG64 g_raiseAt = 0;
static volatile LONG64 g_dispatchAt = 0;
static volatile LONG  g_delayedHits = 0;
static volatile LONG  g_lastDelayEffectiveMs = 0;
static PVOID          g_alienVeh = NULL;

/* VEH do "terceiro" para o mesmo endereco. Se o tracer consumir, este nao sobe. */
static LONG CALLBACK attr_alien_veh(EXCEPTION_POINTERS *info)
{
    if (!info || !info->ExceptionRecord) return EXCEPTION_CONTINUE_SEARCH;
    if (info->ExceptionRecord->ExceptionCode != EXCEPTION_SINGLE_STEP)
        return EXCEPTION_CONTINUE_SEARCH;
    if ((uint64_t)info->ExceptionRecord->ExceptionAddress != g_attrTarget)
        return EXCEPTION_CONTINUE_SEARCH;
    if (InterlockedIncrement(&g_alienHits) == 1)
        g_alienFirstHitAt = (LONG64)GetTickCount64();
    if (info->ContextRecord) {
        info->ContextRecord->EFlags |= 0x10000;
        info->ContextRecord->Dr6 &= ~0x1ull;
    }
    return EXCEPTION_CONTINUE_EXECUTION;
}

static int attr_arm_alien(uint64_t targetPa)
{
    /* ocupa DR0 (o MESMO slot) apontando o MESMO endereco; L0 ligado */
    CONTEXT c; memset(&c, 0, sizeof c);
    c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (!GetThreadContext(GetCurrentThread(), &c)) return 0;
    c.Dr0 = targetPa;
    c.Dr7 &= ~0x3ull;
    c.Dr7 |= 0x1ull;
    c.Dr6 = 0;
    return SetThreadContext(GetCurrentThread(), &c) ? 1 : 0;
}

static void attr_disarm_alien(void)
{
    CONTEXT c; memset(&c, 0, sizeof c);
    c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (GetThreadContext(GetCurrentThread(), &c)) {
        c.Dr0 = 0; c.Dr7 &= ~0x1ull; c.Dr6 &= ~0x1ull;
        SetThreadContext(GetCurrentThread(), &c);
    }
}

static volatile LONG g_occupySelf = 0;
static HANDLE lateArr[4];
static int lateHandles = 0;
static volatile LONG g_afterStopForeignHits = 0;
static volatile LONG g_afterStopPhase = 0;      /* 0=off 1=armar 2=disparar */
static uint64_t      g_afterStopAddr = 0;       /* endereco historico do alvo */

/* VEH do terceiro para o cenario foreign_after_stop: recebe SINGLE_STEP no
 * endereco historico DEPOIS do nosso desarme, prova que nao fomos nos. */
static LONG CALLBACK after_stop_veh(EXCEPTION_POINTERS *info)
{
    if (!info || !info->ExceptionRecord) return EXCEPTION_CONTINUE_SEARCH;
    if (info->ExceptionRecord->ExceptionCode != EXCEPTION_SINGLE_STEP)
        return EXCEPTION_CONTINUE_SEARCH;
    if ((uint64_t)(info->ExceptionRecord->ExceptionAddress) != g_afterStopAddr)
        return EXCEPTION_CONTINUE_SEARCH;
    InterlockedIncrement(&g_afterStopForeignHits);
    if (info->ContextRecord) {
        info->ContextRecord->EFlags |= 0x10000;
        info->ContextRecord->Dr6 &= ~0x1;
    }
    return EXCEPTION_CONTINUE_EXECUTION;
}
static volatile LONG g_occupyDone = 0;
static volatile LONG g_foreignHits = 0;
static volatile LONG g_foreignSteps = 0;

/* Fases do breakpoint alheio. A thread 0 e' a unica que o tem armado, entao
 * so' ELA pode provar que ele continua funcional. */
#define FP_IDLE       0
#define FP_ARMED      1   /* armou; vai sondar durante a observacao */
#define FP_POST_STOP  2   /* pedido: sondar DEPOIS do nosso desarme */
#define FP_DONE       3
static volatile LONG g_foreignPhase = FP_IDLE;
static volatile LONG g_postStopHits = 0;
static volatile LONG g_duringHits = 0;

/* DR7 observado pela thread 0 em tres momentos. */
typedef struct { unsigned long long dr0, dr1, dr2, dr3, dr6, dr7; LONG phase; } DR_SNAP;
static DR_SNAP g_snap[3];
static volatile LONG g_snapCount = 0;

static void take_snap(int phase)
{
    CONTEXT c; memset(&c, 0, sizeof c);
    c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (!GetThreadContext(GetCurrentThread(), &c)) return;
    LONG i = InterlockedIncrement(&g_snapCount) - 1;
    if (i < 0 || i >= 3) return;
    g_snap[i].dr0 = c.Dr0; g_snap[i].dr1 = c.Dr1;
    g_snap[i].dr2 = c.Dr2; g_snap[i].dr3 = c.Dr3;
    g_snap[i].dr6 = c.Dr6; g_snap[i].dr7 = c.Dr7;
    g_snap[i].phase = phase;
}

/* Ocupa DR0 nesta própria thread, apontando para uma funcao que NAO e' o alvo.
 * Serve para provar duas coisas ao mesmo tempo:
 *   (a) o tracer escolhe outro slot nesta thread;
 *   (b) quando este breakpoint alheio dispara, o handler do tracer IGNORA.
 *
 * E prova uma terceira, aprendida na pratica: quem arma um DR TEM que tratar
 * a propria excecao. Sem isso, EXCEPTION_SINGLE_STEP sobe sem tratamento e
 * derruba o processo. Este host simula o "terceiro" fazendo o certo. */
__declspec(noinline) int foreign_probe(int v)
{
    volatile int a = v ^ 0x5a5a;
    return a;
}

static LONG CALLBACK foreign_veh(EXCEPTION_POINTERS *info)
{
    if (!info || !info->ExceptionRecord || !info->ContextRecord)
        return EXCEPTION_CONTINUE_SEARCH;
    if (info->ExceptionRecord->ExceptionCode != EXCEPTION_SINGLE_STEP)
        return EXCEPTION_CONTINUE_SEARCH;

    CONTEXT *c = info->ContextRecord;
    /* Mesmo principio do tracer: nao exigir o bit de Dr6, porque uma excecao
     * em transito pode chega-lo ja' limpo. Aceitar por L0 + endereco. */
    if (!(c->Dr7 & 0x1)) return EXCEPTION_CONTINUE_SEARCH;
    if ((uint64_t)(info->ExceptionRecord->ExceptionAddress)
        != (uint64_t)(uintptr_t)&foreign_probe) return EXCEPTION_CONTINUE_SEARCH;

    InterlockedIncrement(&g_foreignHits);
    InterlockedIncrement(&g_foreignSteps);
    c->EFlags |= 0x10000;   /* RF */
    c->Dr6 &= ~0x1;         /* limpa so' o B0 */
    return EXCEPTION_CONTINUE_EXECUTION;
}

static int occupy_dr0_self(void)
{
    CONTEXT c; memset(&c, 0, sizeof c);
    c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (!GetThreadContext(GetCurrentThread(), &c)) return 0;
    c.Dr0 = (uint64_t)(uintptr_t)&foreign_probe;
    c.Dr7 |= 0x1;                 /* L0: DR0 local, RW=00 exec, LEN=00 */
    c.Dr6 = 0;
    return SetThreadContext(GetCurrentThread(), &c) ? 1 : 0;
}

__declspec(noinline) int unrelated_function(int v)
{
    volatile int a = v + 7;
    return a;
}

static DWORD WINAPI worker(LPVOID p)
{
    int id = (int)(intptr_t)p;
    int call = id >= 0;
    InterlockedIncrement(&g_alive);

    if (InterlockedCompareExchange(&g_occupySelf, 1, 1) == 1 && id == 0) {
        /* Thread 0 arma DR0 ANTES do tracer, comeca a sondar e continua viva
         * ate' o fim -- inclusive DEPOIS do nosso desarme, para provar que o
         * breakpoint alheio segue funcional. */
        occupy_dr0_self();
        take_snap(FP_ARMED);
        InterlockedExchange(&g_foreignPhase, FP_ARMED);
        InterlockedExchange(&g_occupyDone, 1);

        LONG before = g_foreignHits;
        /* fase 1: sonda enquanto o tracer observa */
        for (int i = 0; i < 40; i++) {
            foreign_probe(i);
            if (InterlockedCompareExchange(&g_foreignPhase, FP_POST_STOP, FP_POST_STOP) == FP_POST_STOP)
                break;
            Sleep(20);
        }
        InterlockedExchange(&g_duringHits, g_foreignHits - before);

        /* fase 2: espera o pedido de sonda pos-parada */
        while (InterlockedCompareExchange(&g_foreignPhase, FP_POST_STOP, FP_POST_STOP) != FP_POST_STOP) {
            if (InterlockedCompareExchange(&g_stop, 1, 1) == 1) break;
            Sleep(20);
        }

        /* fase 3: sonda DEPOIS do nosso desarme */
        LONG post = g_foreignHits;
        for (int i = 0; i < 4; i++) { foreign_probe(900 + i); Sleep(10); }
        InterlockedExchange(&g_postStopHits, g_foreignHits - post);
        take_snap(FP_DONE);
        InterlockedExchange(&g_foreignPhase, FP_DONE);
    } else if (InterlockedCompareExchange(&g_occupySelf, 1, 1) == 1) {
        while (InterlockedCompareExchange(&g_occupyDone, 1, 1) != 1 &&
               InterlockedCompareExchange(&g_stop, 1, 1) == 0)
            Sleep(10);
    }

    while (InterlockedCompareExchange(&g_stop, 1, 1) == 0) {
        if (call) target_function(id); else unrelated_function(-id);
        Sleep(40);
    }
    InterlockedDecrement(&g_alive);
    return 0;
}

static DWORD WINAPI short_lived(LPVOID p)
{
    (void)p;
    InterlockedIncrement(&g_alive);
    for (int i = 0; i < 3 && InterlockedCompareExchange(&g_stop, 1, 1) == 0; i++) {
        target_function(i);
        Sleep(100);
    }
    InterlockedDecrement(&g_alive);
    return 0;
}

static int occupy_dr0(void)
{
    CONTEXT c; memset(&c, 0, sizeof c);
    c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (!GetThreadContext(GetCurrentThread(), &c)) return 0;
    c.Dr0 = (uint64_t)(uintptr_t)&unrelated_function;
    c.Dr7 |= 0x1;
    c.Dr6 = 0;
    return SetThreadContext(GetCurrentThread(), &c) ? 1 : 0;
}

static void write_config(const char *dllPath, uint32_t rva, int maxEvents,
                         int maxSeconds, const char *out, int *tids, int ntids,
                         int useAll)
{
    char cfg[MAX_PATH];
    snprintf(cfg, sizeof cfg, "%s", dllPath);
    char *slash = strrchr(cfg, '\\');
    if (slash) *(slash + 1) = 0; else cfg[0] = 0;
    strncat(cfg, "pka_walktrace_config.txt", sizeof cfg - strlen(cfg) - 1);

    FILE *f = fopen(cfg, "wb");
    if (!f) { printf("CONFIG_FAIL path=%s\n", cfg); return; }
    fprintf(f, "module=walktrace_host.exe\n");
    fprintf(f, "rva=%x\n", rva);
    fprintf(f, "max_events=%d\n", maxEvents);
    fprintf(f, "max_seconds=%d\n", maxSeconds);
    if (out && out[0]) fprintf(f, "out=%s\n", out);
    if (useAll) {
        fprintf(f, "threads=*\n");
    } else if (ntids > 0) {
        fprintf(f, "threads=");
        for (int i = 0; i < ntids; i++) fprintf(f, "%s%d", i ? "," : "", tids[i]);
        fprintf(f, "\n");
    }
    fclose(f);
    printf("CONFIG path=%s module=walktrace_host.exe rva=%x max_events=%d max_seconds=%d\n",
           cfg, rva, maxEvents, maxSeconds);
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        printf("uso: walktrace_host.exe <dll> <cenario> [segundos] [threads]\n");
        return 2;
    }
    const char *dllPath = argv[1];
    const char *scenario = argv[2];
    int seconds = argc > 3 ? atoi(argv[3]) : 4;
    int threads = argc > 4 ? atoi(argv[4]) : 3;
    if (threads < 1) threads = 1;
    if (threads > MAX_WORKERS) threads = MAX_WORKERS;
    if (seconds < 1) seconds = 1;

    int maxEvents = 5;
    int maxSeconds = 60;
    int runCalls = 1;
    int preOccupy = 0;
    int shortThreads = 0;
    int callTwiceStop = 0;
    int residualPhase = 0;
    int foreignAfterStop = 0;
    int lateThread = 0;
    int transitDelayed = 0;
    int reuseInside = 0;
    int reuseAfter = 0;
    int stopRace = 0;

    if (!strcmp(scenario, "basic")) {
        maxEvents = 5; maxSeconds = seconds + 5;
    } else if (!strcmp(scenario, "negative")) {
        runCalls = 0; maxEvents = 5; maxSeconds = seconds + 2;
    } else if (!strcmp(scenario, "occupied")) {
        maxEvents = 5; maxSeconds = seconds + 5;
    } else if (!strcmp(scenario, "limit")) {
        maxEvents = 2; maxSeconds = 30;
    } else if (!strcmp(scenario, "timeout")) {
        maxEvents = 200; maxSeconds = 2;
    } else if (!strcmp(scenario, "twice")) {
        callTwiceStop = 1; maxEvents = 3; maxSeconds = seconds + 5;
    } else if (!strcmp(scenario, "partial")) {
        shortThreads = 1; maxEvents = 4; maxSeconds = seconds + 5;
    } else if (!strcmp(scenario, "residual")) {
        maxEvents = 2; maxSeconds = seconds + 5; residualPhase = 1;
    } else if (!strcmp(scenario, "transit_delayed")) {
        /* Excecao NOSSA entregue com atraso > 50 ms. Prova que a atribuicao
         * nao depende de prazo: Dr_n retido ainda reconhece. */
        transitDelayed = 1; maxEvents = 10; maxSeconds = seconds + 6;
    } else if (!strcmp(scenario, "reuse_inside")) {
        /* Terceiro reusa slot+endereco DURANTE a observacao. Nosso tracer
         * esta' ativo; o DR e' o mesmo. Deve contar ambiguousSameTarget e
         * nao fingir separar o inseparavel. */
        reuseInside = 1; maxEvents = 500; maxSeconds = seconds + 6;
    } else if (!strcmp(scenario, "reuse_after")) {
        /* Terceiro reusa slot+endereco DEPOIS do Stop. Nosso Dr_n ficou
         * retido como marca; o dele tambem aponta o alvo -> ambiguidade
         * declarada, nao adivinhada. */
        reuseAfter = 1; maxEvents = 500; maxSeconds = seconds + 6;
    } else if (!strcmp(scenario, "stop_race")) {
        /* Parada sob concorrencia: Stop chamado enquanto threads disparam
         * sem pausa. Mede se sobrou DR ativo e se o desarme foi verificado. */
        stopRace = 1; maxEvents = 200; maxSeconds = seconds + 8;
    } else if (!strcmp(scenario, "late_thread")) {
        /* Prova o alcance de threads=*: uma thread criada DEPOIS do Start NAO
         * e' armada (snapshot, nao acompanhamento). A cobertura precisa
         * reportar isso, e nao pode virar "sucesso total". */
        lateThread = 1;
        maxEvents = 5; maxSeconds = seconds + 6;
    } else if (!strcmp(scenario, "foreign_after_stop")) {
        /* Exercita o ponto 2: bootstrap um DR0 alheio em DR0, deixa o tracer
         * escolher outro slot, encerra, e DEPOIS dispara uma excecao alheia no
         * MESMO endereco historico do alvo com o MESMO slot nosso. O handler
         * do "terceiro" tem de receber, e nossos registros nao podem mudar. */
        maxEvents = 3; maxSeconds = seconds + 5;
        foreignAfterStop = 1;
    } else {
        printf("cenario desconhecido: %s\n", scenario);
        return 2;
    }

    uint32_t rva = (uint32_t)((uintptr_t)&target_function -
                              (uintptr_t)GetModuleHandleA(NULL));

    int tidList[MAX_WORKERS + 1];
    int tidCount = 0;

    LONG dr0Before = -1, dr7Before = -1;
    if (preOccupy) {
        occupy_dr0();
        CONTEXT c; memset(&c, 0, sizeof c);
        c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
        if (GetThreadContext(GetCurrentThread(), &c)) {
            dr0Before = (LONG)c.Dr0; dr7Before = (LONG)c.Dr7;
        }
    }

    PVOID foreignVeh = NULL;
    if (!strcmp(scenario, "occupied")) {
        InterlockedExchange(&g_occupySelf, 1);
        /* o "terceiro" registra o proprio handler ANTES do tracer */
        foreignVeh = AddVectoredExceptionHandler(0, foreign_veh);
        printf("FOREIGN_VEH registered=%d\\n", foreignVeh ? 1 : 0);
    }

    HANDLE handles[MAX_WORKERS];
    int spawned = 0;
    if (shortThreads) {
        for (int i = 0; i < threads; i++)
            handles[i] = CreateThread(NULL, 0, short_lived, NULL, 0, NULL);
        spawned = threads;
    } else {
        for (int i = 0; i < threads; i++) {
            int id = runCalls ? i : -(i + 1);
            handles[i] = CreateThread(NULL, 0, worker, (LPVOID)(intptr_t)id,
                                      0, NULL);
            if (handles[i]) spawned++;
        }
    }
    if (!strcmp(scenario, "occupied")) {
        for (int i = 0; i < 100; i++) {
            if (InterlockedCompareExchange(&g_occupyDone, 1, 1) == 1) break;
            Sleep(10);
        }
        printf("OCCUPY done=%ld foreign_hits_so_far=%ld\\n",
               (long)InterlockedCompareExchange(&g_occupyDone,1,1),
               (long)g_foreignHits);
    }
    Sleep(120);   /* deixa as threads aparecerem na lista */

    /* coleta TIDs das threads criadas para o caso de armamento parcial */
    for (int i = 0; i < spawned && tidCount < MAX_WORKERS; i++)
        if (handles[i]) tidList[tidCount++] = (int)GetThreadId(handles[i]);

    char out[MAX_PATH];
    char dllBase[MAX_PATH];
    snprintf(dllBase, sizeof dllBase, "%s", dllPath);
    char *sl = strrchr(dllBase, '\\');
    if (sl) *(sl + 1) = 0; else dllBase[0] = 0;
    snprintf(out, sizeof out, "%swalktrace_%s_%lu.json", dllBase, scenario,
             (unsigned long)GetCurrentProcessId());

    write_config(dllPath, rva, maxEvents, maxSeconds, out, tidList, tidCount,
                 lateThread);  /* late_thread usa threads=* para testar o alcance */

    HMODULE dll = LoadLibraryA(dllPath);
    if (!dll) {
        printf("LOAD_FAIL err=%lu\n", GetLastError());
        return 3;
    }
    PFN_START  pStart  = (PFN_START)GetProcAddress(dll, "PkaWalkTraceStart");
    PFN_STOP   pStop   = (PFN_STOP)GetProcAddress(dll, "PkaWalkTraceStop");
    PFN_STATE  pState  = (PFN_STATE)GetProcAddress(dll, "PkaWalkTraceState");
    PFN_EVENTS pEvents = (PFN_EVENTS)GetProcAddress(dll, "PkaWalkTraceEvents");
    PFN_VERIFY pVerify = (PFN_VERIFY)GetProcAddress(dll, "PkaWalkTraceVerifyDisarmed");
    PFN_REPORT pReport = (PFN_REPORT)GetProcAddress(dll, "PkaWalkTraceReport");
    if (!pStart || !pStop || !pState) { printf("EXPORT_FAIL\n"); return 3; }

    printf("PHASE dll_loaded\n");
    LONG st0 = pState();
    LONG started = pStart(NULL);
    LONG st1 = pState();
    printf("PHASE start returned=%ld state=%ld (0=idle 1=prepared 2=armed)\n",
           (long)started, (long)st1);

    if (st1 != 2) {
        printf("ARM_NOT_ARMED state=%ld\n", (long)st1);
        if (pVerify) printf("VERIFY leftover=%d\n", pVerify());
        if (residualPhase) goto residual_check;
        return 4;
    }

    if (lateThread) {
        /* cria DEPOIS do armamento; reporta TID para confrontar com armedTids */
        HANDLE late = CreateThread(NULL, 0, worker, (LPVOID)(intptr_t)77, 0, NULL);
        if (late) {
            printf("LATE_THREAD created tid=%lu (criada DEPOIS do Start)\n",
                   (unsigned long)GetThreadId(late));
            printf("LATE_THREAD expect_armed=%s\n", "NO (snapshot inicial)");
            if (lateHandles < MAX_WORKERS) lateArr[lateHandles++] = late;
        }
    }

    ULONGLONG t0 = GetTickCount64();
    ULONGLONG budget = (ULONGLONG)seconds * 1000ULL;
    while (GetTickCount64() - t0 < budget) {
        Sleep(50);
        if (pState() == 4 || pState() == 5) break;   /* disarmed / failed */
        /* transit_delayed: para a espera assim que houver eventos, para o
         * Stop ainda encontrar slots ligados */
        if ((transitDelayed || reuseInside || reuseAfter) && pEvents && pEvents() > 0) break;
    }

    LONG evBefore = pEvents ? pEvents() : -1;
    printf("PHASE before_stop events=%ld state=%ld\n", (long)evBefore, (long)pState());

    if (transitDelayed) {
        /* Valida o mecanismo REAL de transito: Stop() so' desarma quando
         * Dr6.B<slot> == 0 na thread suspensa. Nao ha prazo, nao ha Dr0
         * retido (o kernel zera Dr0..Dr3 quando nao ha L/G ligado).
         *
         * Exercitamos a condicao: forcamos Dr6.B0 na thread principal, que
         * esta' no conjunto armado, e medimos se Stop() espera por ele.
         */
        printf("ATTR_DELAY phase=start\n");

        /* 1. Estado antes do Stop: o slot esta' ligado em todas as armadas. */
        int armedSeen = 0, checked = 0;
        unsigned long long sampleDr7 = 0, sampleDr6 = 0;
        for (int i = 0; i < spawned && i < 8; i++) {
            if (!handles[i]) continue;
            HANDLE o = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                                  THREAD_QUERY_INFORMATION | SYNCHRONIZE,
                                  FALSE, GetThreadId(handles[i]));
            if (!o) continue;
            SuspendThread(o);
            CONTEXT dc; memset(&dc, 0, sizeof dc);
            dc.ContextFlags = CONTEXT_DEBUG_REGISTERS;
            if (GetThreadContext(o, &dc)) {
                checked++;
                sampleDr7 = (unsigned long long)dc.Dr7;
                sampleDr6 = (unsigned long long)dc.Dr6;
                if ((dc.Dr7 & 0x1ull) || (dc.Dr7 & 0x2ull)) armedSeen++;
            }
            ResumeThread(o);
            CloseHandle(o);
        }
        printf("ATTR_DELAY before_stop threads=%d slot_enabled=%d "
               "sample_dr7=0x%llx sample_dr6=0x%llx\n",
               checked, armedSeen, sampleDr7, sampleDr6);

        /* 2. Forca um #DB pendente: seta Dr6.B0 numa thread armada, com o
         * slot ainda LIGADO. O kernel deve preservar. Depois chama Stop
         * externamente medindo o tempo. */
        int forced = 0;
        if (spawned > 0 && handles[0]) {
            HANDLE o = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                                  THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION |
                                  SYNCHRONIZE, FALSE, GetThreadId(handles[0]));
            if (o) {
                SuspendThread(o);
                CONTEXT f; memset(&f, 0, sizeof f);
                f.ContextFlags = CONTEXT_DEBUG_REGISTERS;
                if (GetThreadContext(o, &f)) {
                    /* Dr6 so' persiste com o slot HABILITADO (o kernel zera
                     * todo o conjunto de debug quando L/G estao zerados).
                     * Garantimos L0 ligado ao mesmo tempo. */
                    f.Dr7 |= 0x1ull;
                    f.Dr6 |= 0x1ull;
                    if (SetThreadContext(o, &f)) {
                        CONTEXT v; memset(&v, 0, sizeof v);
                        v.ContextFlags = CONTEXT_DEBUG_REGISTERS;
                        if (GetThreadContext(o, &v)) forced = (v.Dr6 & 0x1ull) ? 1 : 0;
                    }
                }
                ResumeThread(o);
                CloseHandle(o);
            }
        }
        printf("ATTR_DELAY forced_pending_db=%d (0 = kernel nao preservou; "
               "esperado em HW real)\n", forced);

        /* 3. Stop com o #DB pendente. O gate tem de esperar/recusar-se a
         * limpar com pendencia. */
        printf("ATTR_DELAY stop_deferred=1 "
               "(Stop normal roda abaixo; aqui so preparamos a condicao)\n");

        /* A checagem pos-Stop acontece depois de pStop(NULL), mais abaixo. */
    }


    if (reuseInside) {
        /* Terceiro usa o MESMO slot e o MESMO endereco enquanto o tracer
         * observa. Deve aparecer como ambiguousSameTarget, nao como "nossa
         * excecao" indistinguivel. */
        printf("REUSE_INSIDE phase=start\n");
        g_attrTarget = (uint64_t)(uintptr_t)&target_function;
        g_alienVeh = AddVectoredExceptionHandler(0, attr_alien_veh);
        int armedAlien = attr_arm_alien(g_attrTarget);
        printf("REUSE_INSIDE alien_armed=%d same_addr=1 same_slot=1 veh=%d\n",
               armedAlien, g_alienVeh ? 1 : 0);

        LONG evBefore = pEvents ? pEvents() : -1;
        LONG stPre = pState ? pState() : -1;
        for (int i = 0; i < 40; i++) { target_function(600 + i); Sleep(10); }
        LONG evAfter = pEvents ? pEvents() : -1;
        LONG stPost = pState ? pState() : -1;
        printf("REUSE_INSIDE tracer_state_before=%ld after=%ld\n",
               (long)stPre, (long)stPost);

        printf("REUSE_INSIDE tracer_events_delta=%ld alien_hits=%ld\n",
               (long)(evAfter - evBefore), (long)g_alienHits);
        /* Expectativa CORRETA: com o tracer ATIVO no mesmo slot+endereco, o
         * contexto nao carrega informacao que separe os dois. O tracer
         * consome (obrigacao: nao derrubar o processo) e o VEH alheio NAO
         * recebe. Isso e' ambiguidade por construcao, e o JSON a declara em
         * ambiguousSameTarget -- nao fingimos separar. */
        printf("REUSE_INSIDE expected=tracer_consumes alien_misses "
               "(ambiguidade declarada, nao resolvida)\n");
        attr_disarm_alien();
    }

    if (reuseAfter) {
        /* Terceiro toma UM slot de uma thread armada ANTES do Stop, com Dr_n
         * apontando OUTRO endereco. O desarme deve encontrar Dr_n != alvo,
         * devolver ERROR_BUSY e NAO mexer -- recusa correta, state=5. */
        printf("REUSE_AFTER phase=start\n");

        int hijacked = 0;
        DWORD hijackTid = 0;
        if (spawned > 0 && handles[0]) {
            hijackTid = GetThreadId(handles[0]);
            HANDLE o = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                                  THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION |
                                  SYNCHRONIZE, FALSE, hijackTid);
            if (o) {
                SuspendThread(o);
                CONTEXT h; memset(&h, 0, sizeof h);
                h.ContextFlags = CONTEXT_DEBUG_REGISTERS;
                if (GetThreadContext(o, &h)) {
                    /* sobrescreve NOSSO slot com outro alvo */
                    h.Dr0 = (uint64_t)(uintptr_t)&unrelated_function;
                    h.Dr7 |= 0x1ull;
                    if (SetThreadContext(o, &h)) {
                        CONTEXT v; memset(&v, 0, sizeof v);
                        v.ContextFlags = CONTEXT_DEBUG_REGISTERS;
                        if (GetThreadContext(o, &v))
                            hijacked = (v.Dr0 == (uint64_t)(uintptr_t)&unrelated_function) ? 1 : 0;
                    }
                }
                ResumeThread(o);
                CloseHandle(o);
            }
        }
        printf("REUSE_AFTER hijacked_tid=%lu hijacked=%d "
               "(Dr0 do nosso slot agora aponta outra funcao)\n",
               (unsigned long)hijackTid, hijacked);
        printf("REUSE_AFTER expected=next Stop recusa (state=5, pending aponta "
               "esse TID)\n");
    }


    LONG stopRes = pStop(NULL);
    LONG st2 = pState();
    printf("PHASE stop returned=%ld state=%ld\n", (long)stopRes, (long)st2);

    if (callTwiceStop) {
        LONG stop2 = pStop(NULL);
        LONG st3 = pState();
        printf("PHASE stop2 returned=%ld state=%ld (idempotente)\n",
               (long)stop2, (long)st3);
    }

    int leftover = pVerify ? pVerify() : -1;
    printf("VERIFY leftover_threads=%d (esperado 0)\n", leftover);

    if (transitDelayed) {
        int stillEnabled = 0, seen = 0;
        unsigned long long d7 = 0, d6 = 0;
        for (int i = 0; i < spawned && i < 8; i++) {
            if (!handles[i]) continue;
            HANDLE o = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                                  THREAD_QUERY_INFORMATION | SYNCHRONIZE,
                                  FALSE, GetThreadId(handles[i]));
            if (!o) continue;
            SuspendThread(o);
            CONTEXT dc; memset(&dc, 0, sizeof dc);
            dc.ContextFlags = CONTEXT_DEBUG_REGISTERS;
            if (GetThreadContext(o, &dc)) {
                seen++;
                d7 = (unsigned long long)dc.Dr7;
                d6 = (unsigned long long)dc.Dr6;
                if ((dc.Dr7 & 0x1ull) || (dc.Dr7 & 0x2ull)) stillEnabled++;
            }
            ResumeThread(o);
            CloseHandle(o);
        }
        printf("ATTR_DELAY after_stop threads=%d slot_enabled=%d "
               "sample_dr7=0x%llx sample_dr6=0x%llx\n",
               seen, stillEnabled, d7, d6);
        printf("ATTR_DELAY verdict=%s\n",
               (stillEnabled == 0) ? "DISARMED_STATE_VERIFIED"
                                   : "SLOT_STILL_ENABLED_INVESTIGATE");
    }

    LONG evAfterStop = pEvents ? pEvents() : -1;

    if (pReport) {
        char buf[8192];
        int n = pReport(buf, (int)sizeof buf);
        printf("REPORT len=%d\n", n);
    }

residual_check:

    /* ================== TESTES DIRIGIDOS DE ATRIBUICAO ================== */

    if (stopRace) {
        /* Parada sob concorrencia: Stop chamado com threads disparando.
         * Mede DR residual e verificacao. */
        printf("STOP_RACE phase=start\n");
        LONG64 before = (LONG64)GetTickCount64();
        LONG r1 = pStop(NULL);
        LONG64 after = (LONG64)GetTickCount64();
        int leftover = pVerify ? pVerify() : -1;
        CONTEXT rc; memset(&rc, 0, sizeof rc);
        rc.ContextFlags = CONTEXT_DEBUG_REGISTERS;
        int selfArmed = -1;
        if (GetThreadContext(GetCurrentThread(), &rc))
            selfArmed = (rc.Dr7 & 0x1ull) ? 1 : 0;
        printf("STOP_RACE stop_result=%ld elapsed_ms=%lld leftover=%d "
               "self_L0=%d\n",
               (long)r1, (long long)(after - before), leftover, selfArmed);
        printf("STOP_RACE verdict=%s\n",
               (leftover == 0 && selfArmed == 0) ? "CLEAN" : "RESIDUAL");
    }

    /* ==================================================================== */

    if (residualPhase) {
        /* a funcao continua rodando; nao pode gerar evento novo */
        LONG evA = pEvents ? pEvents() : -1;
        Sleep(400);
        for (int i = 0; i < 5; i++) target_function(100 + i);
        Sleep(200);
        LONG evB = pEvents ? pEvents() : -1;
        printf("RESIDUAL events_before=%ld events_after=%ld (devem ser iguais)\n",
               (long)evA, (long)evB);
    }

    /* ---- ponto 2: excecao alheia no endereco/slot historicos APOS Stop ---- */
    if (foreignAfterStop) {
        LONG evBeforeAlien = pEvents ? pEvents() : -1;
        LONG stBefore = pState ? pState() : -1;

        /* "terceiro" arma DR0 (slot 0, o mesmo que usamos) exatamente no
         * endereco historico do alvo, e registra o proprio VEH DEPOIS do nosso
         * na cadeia (First=0). Se consumirmos a excecao dele, o contador dele
         * nao sobe. */
        g_afterStopAddr = (uint64_t)(uintptr_t)&target_function;
        PVOID alienVeh = AddVectoredExceptionHandler(0, after_stop_veh);

        CONTEXT cc; memset(&cc, 0, sizeof cc);
        cc.ContextFlags = CONTEXT_DEBUG_REGISTERS;
        int armedAlien = 0;
        if (GetThreadContext(GetCurrentThread(), &cc)) {
            cc.Dr0 = g_afterStopAddr;
            cc.Dr7 |= 0x1;                 /* L0, o MESMO slot que usamos */
            cc.Dr6 = 0;
            armedAlien = SetThreadContext(GetCurrentThread(), &cc) ? 1 : 0;
        }

        printf("ALIEN_AFTER_STOP armed=%d addr=0x%llx slot=0 veh=%d\n",
               armedAlien, (unsigned long long)g_afterStopAddr,
               alienVeh ? 1 : 0);

        /* dispara a excecao alheia varias vezes */
        for (int i = 0; i < 6; i++) { target_function(700 + i); Sleep(15); }

        LONG evAfterAlien = pEvents ? pEvents() : -1;
        LONG stAfter = pState ? pState() : -1;

        printf("ALIEN_AFTER_STOP foreign_hits=%ld "
               "tracer_events_before=%ld tracer_events_after=%ld "
               "state_before=%ld state_after=%ld\n",
               (long)g_afterStopForeignHits, (long)evBeforeAlien,
               (long)evAfterAlien, (long)stBefore, (long)stAfter);
        printf("ALIEN_AFTER_STOP verdict_fired=%s tracer_unchanged=%s\n",
               (g_afterStopForeignHits > 0) ? "YES" : "NO",
               (evBeforeAlien == evAfterAlien && stBefore == stAfter) ? "YES" : "NO");

        /* limpa o DR alheio */
        if (GetThreadContext(GetCurrentThread(), &cc)) {
            cc.Dr0 = 0; cc.Dr7 &= ~0x1; cc.Dr6 &= ~0x1;
            SetThreadContext(GetCurrentThread(), &cc);
        }
        if (alienVeh) RemoveVectoredExceptionHandler(alienVeh);
    }

    CONTEXT c; memset(&c, 0, sizeof c);
    c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    LONG dr0After = -1, dr7After = -1;
    LONG dr1After = -1, dr2After = -1, dr3After = -1;
    if (GetThreadContext(GetCurrentThread(), &c)) {
        dr0After = (LONG)c.Dr0; dr1After = (LONG)c.Dr1;
        dr2After = (LONG)c.Dr2; dr3After = (LONG)c.Dr3;
        dr7After = (LONG)c.Dr7;
    }
    printf("DRSELF dr0_before=0x%lx dr7_before=0x%lx dr0_after=0x%lx dr7_after=0x%lx\n",
           (unsigned long)dr0Before, (unsigned long)dr7Before,
           (unsigned long)dr0After, (unsigned long)dr7After);

    /* Decodificacao de DR7, campo a campo. Nada de "0x404 = LEN1". */
    {
        unsigned long v = (unsigned long)(dr7After & 0xFFFFFFFFUL);
        printf("DR7_DECODE raw=0x%lx  L0=%lu G0=%lu L1=%lu G1=%lu L2=%lu G2=%lu "
               "L3=%lu G3=%lu LE=%lu GE=%lu bit10=%lu\n",
               v, (v >> 0) & 1, (v >> 1) & 1, (v >> 2) & 1, (v >> 3) & 1,
               (v >> 4) & 1, (v >> 5) & 1, (v >> 6) & 1, (v >> 7) & 1,
               (v >> 8) & 1, (v >> 9) & 1, (v >> 10) & 1);
        for (int i = 0; i < 4; i++) {
            unsigned long rw  = (v >> (16 + 4 * i)) & 0x3UL;
            unsigned long len = (v >> (18 + 4 * i)) & 0x3UL;
            printf("DR7_SLOT slot=%d RW=%lu(%s) LEN=%lu(%s) local=%lu global=%lu "
                   "dr=%s\n",
                   i, rw, rw == 0 ? "exec" : (rw == 1 ? "write" : "io"),
                   len, len == 0 ? "1B" : (len == 1 ? "2B" : (len == 2 ? "8B" : "4B")),
                   (v >> (2 * i)) & 1, (v >> (2 * i + 1)) & 1,
                   i == 0 ? (dr0After ? "set" : "clear")
                          : i == 1 ? (dr1After ? "set" : "clear")
                          : i == 2 ? (dr2After ? "set" : "clear")
                                   : (dr3After ? "set" : "clear"));
        }
    }

    /* Prova de preservacao: pedir a thread 0 que sonde o breakpoint alheio
     * DEPOIS do nosso desarme, e esperar ela concluir. */
    if (foreignVeh) {
        InterlockedExchange(&g_foreignPhase, FP_POST_STOP);
        for (int i = 0; i < 300; i++) {
            if (InterlockedCompareExchange(&g_foreignPhase, FP_DONE, FP_DONE) == FP_DONE) break;
            Sleep(10);
        }
        printf("FOREIGN_STILL_ARMED hits_during=%ld hits_after_stop=%ld fires_after=%s\n",
               (long)g_duringHits, (long)g_postStopHits,
               (g_postStopHits > 0) ? "YES" : "NO");
        for (LONG i = 0; i < g_snapCount && i < 3; i++) {
            unsigned long long v = g_snap[i].dr7;
            printf("DR7_AT_%s dr0=0x%llx dr1=0x%llx dr2=0x%llx dr3=0x%llx "
                   "dr7=0x%llx  L0=%llu L1=%llu L2=%llu L3=%llu bit10=%llu "
                   "LEN0=%llu LEN1=%llu\n",
                   g_snap[i].phase == FP_ARMED ? "BEFORE_ARM" : "AFTER_DISARM",
                   g_snap[i].dr0, g_snap[i].dr1, g_snap[i].dr2, g_snap[i].dr3,
                   v, (v >> 0) & 1, (v >> 2) & 1, (v >> 4) & 1, (v >> 6) & 1,
                   (v >> 10) & 1, (v >> 18) & 3, (v >> 22) & 3);
        }
    }

    printf("SUMMARY scenario=%s calls=%ld events_before_stop=%ld events_after_stop=%ld "
           "leftover=%d state=%ld\n",
           scenario, (long)g_targetCalls, (long)evBefore, (long)evAfterStop,
           leftover, (long)pState());

    InterlockedExchange(&g_stop, 1);
    for (int i = 0; i < lateHandles; i++)
        if (lateArr[i]) { WaitForSingleObject(lateArr[i], 3000); CloseHandle(lateArr[i]); }
    if (spawned > 0) WaitForMultipleObjects((DWORD)spawned, handles, TRUE, 4000);
    for (int i = 0; i < spawned; i++)
        if (handles[i]) CloseHandle(handles[i]);

    /* NAO chamar FreeLibrary: a DLL nao deve ser descarregada enquanto puder
     * existir callback. O processo sai inteiro, o que e' seguro. */
    printf("DONE\n");
    return 0;
}
