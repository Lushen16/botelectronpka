/*
 * walktrace_target.c - executavel auxiliar de teste do tracer.
 *
 * NAO tem relacao com o jogo. Serve para provar, de forma reproduzivel:
 *
 *   1. o tracer detecta execucao da funcao alvo;
 *   2. identifica a thread correta (a que chamou);
 *   3. ignora eventos que nao sao dele;
 *   4. preserva um slot de debug ja' ocupado por terceiro;
 *   5. encerra por limite de eventos e por tempo;
 *   6. aceita parada repetida;
 *   7. sobrevive a saida de thread e a armamento parcial;
 *   8. depois do desarme nao sobrou breakpoint nosso;
 *   9. a funcao continua executando, sem eventos residuais.
 *
 * Como o tracer precisa armas threads existentes, o alvo cria threads ANTES
 * de o tracer iniciar. Cada thread chama a funcao alvo periodicamente.
 *
 * Uso:
 *   walktrace_target.exe <segundos> <threads> <modo>
 *
 *   modo 0 = cada thread chama a funcao alvo a cada ~50 ms
 *   modo 1 = a funcao alvo NAO e' chamada (controle negativo)
 *   modo 2 = uma thread ocupa DR0 antes de o tracer iniciar (conflito)
 *   modo 3 = threads de vida curta: algumas morrem durante a observacao
 *
 * Imprime uma linha de estado por segundo e, ao sair, um resumo em JSON.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_WORKERS 16

static volatile LONG g_targetCalls = 0;
static volatile LONG g_stop = 0;
static volatile LONG g_aliveThreads = 0;
static volatile LONG g_rounds = 0;

/* A funcao alvo. O tracer arma no entry dela.
 * `volatile` de proposito: impede o compilador de inlinar/eliminar. */
__declspec(noinline) int target_function(int value)
{
    InterlockedIncrement(&g_targetCalls);
    /* corpo trivial, mas nao vazio: e' um alvo legitimo de entry breakpoint */
    volatile int acc = value * 3 + 1;
    acc ^= (int)GetCurrentThreadId();
    return acc;
}

/* Funcao vizinha que o tracer NAO deve observar. Usada no controle negativo
 * de "ignora eventos que nao sao meus". */
__declspec(noinline) int unrelated_function(int value)
{
    volatile int acc = value + 7;
    return acc;
}

static DWORD WINAPI worker(LPVOID param)
{
    int id = (int)(intptr_t)param;
    InterlockedIncrement(&g_aliveThreads);
    while (InterlockedCompareExchange(&g_stop, 1, 1) == 0) {
        if (id >= 0) target_function(id);
        else unrelated_function(-id);
        Sleep(50);
    }
    InterlockedDecrement(&g_aliveThreads);
    return 0;
}

/* Thread de vida curta: chama a funcao, espera um pouco e sai. */
static DWORD WINAPI short_lived(LPVOID param)
{
    (void)param;
    InterlockedIncrement(&g_aliveThreads);
    for (int i = 0; i < 4 && InterlockedCompareExchange(&g_stop, 1, 1) == 0; i++) {
        target_function(i);
        Sleep(120);
    }
    InterlockedDecrement(&g_aliveThreads);
    return 0;
}

/* Ocupa DR0 + DR7.L0 nesta thread, como faria um depurador de terceiro. */
static int occupy_debug_slot(void)
{
    CONTEXT ctx; memset(&ctx, 0, sizeof ctx);
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    HANDLE self = GetCurrentThread();
    if (!GetThreadContext(self, &ctx)) return 0;
    /* alvo fictício: a propria funcao, so' para marcar DR0 ocupado */
    ctx.Dr0 = (uint64_t)(uintptr_t)&unrelated_function;
    ctx.Dr7 |= 0x1;      /* L0 */
    ctx.Dr6 = 0;
    return SetThreadContext(self, &ctx) ? 1 : 0;
}

__declspec(dllexport) int WalkingTraceTargetEntry(int v)
{
    return target_function(v);
}

int main(int argc, char **argv)
{
    int seconds = argc > 1 ? atoi(argv[1]) : 6;
    int threads = argc > 2 ? atoi(argv[2]) : 3;
    int mode    = argc > 3 ? atoi(argv[3]) : 0;

    if (threads < 1) threads = 1;
    if (threads > MAX_WORKERS) threads = MAX_WORKERS;
    if (seconds < 1) seconds = 1;

    LONG occupied = 0;
    if (mode == 2) {
        occupied = occupy_debug_slot();
    }

    HANDLE handles[MAX_WORKERS];
    int spawned = 0;

    if (mode == 3) {
        for (int i = 0; i < threads && i < MAX_WORKERS; i++)
            handles[i] = CreateThread(NULL, 0, short_lived, NULL, 0, NULL);
        spawned = threads > MAX_WORKERS ? MAX_WORKERS : threads;
    } else {
        for (int i = 0; i < threads; i++) {
            int id = (mode == 1) ? -(i + 1) : i;
            handles[i] = CreateThread(NULL, 0, worker,
                                      (LPVOID)(intptr_t)id, 0, NULL);
            if (handles[i]) spawned++;
        }
    }

    printf("READY pid=%lu threads=%d mode=%d dr0_occupied=%ld\n",
           (unsigned long)GetCurrentProcessId(), spawned, mode,
           (long)occupied);
    fflush(stdout);

    ULONGLONG start = GetTickCount64();
    int tick = 0;
    while (GetTickCount64() - start < (ULONGLONG)seconds * 1000ULL) {
        Sleep(200);
        InterlockedIncrement(&g_rounds);
        if ((GetTickCount64() - start) / 500 > (ULONGLONG)tick) {
            tick = (int)((GetTickCount64() - start) / 500);
            printf("MON pid=%lu tick=%d calls=%ld alive=%ld\n",
                   (unsigned long)GetCurrentProcessId(),
                   (int)((GetTickCount64() - start) / 1000),
                   (long)g_targetCalls, (long)g_aliveThreads);
            fflush(stdout);
        }
        /* modo 3: as threads de vida curta ja' morreram; continua vivo para
         * que o tracer possa desarmar um conjunto parcial */
    }

    InterlockedExchange(&g_stop, 1);
    WaitForMultipleObjects((DWORD)spawned, handles, TRUE, 4000);

    CONTEXT ctx; memset(&ctx, 0, sizeof ctx);
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    LONG dr0 = -1, dr7 = -1;
    if (GetThreadContext(GetCurrentThread(), &ctx)) { dr0 = (LONG)ctx.Dr0; dr7 = (LONG)ctx.Dr7; }

    printf("SUMMARY pid=%lu calls=%ld rounds=%ld aliveAtExit=%ld dr0=0x%lx dr7=0x%lx\n",
           (unsigned long)GetCurrentProcessId(), (long)g_targetCalls,
           (long)g_rounds, (long)g_aliveThreads, (unsigned long)dr0,
           (unsigned long)dr7);
    fflush(stdout);

    for (int i = 0; i < spawned; i++)
        if (handles[i]) CloseHandle(handles[i]);
    return 0;
}
