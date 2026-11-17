/*
 * pka_dispatch_trace.c - registra as chamadas ao trampolim de dispatch.
 *
 * POR QUE HARDWARE BREAKPOINT E NAO INLINE HOOK
 * O alvo vive dentro do runtime do fornecedor (msftedit stomped). Escrever
 * bytes la' e' irreversivel na sessao e arrisca crash com o bot rodando.
 * Debug register (DR0) observa execucao SEM modificar codigo: nenhum byte do
 * jogo muda, e o efeito termina quando o processo fecha.
 *
 * O QUE REGISTRA
 * Toda entrada em msftedit!0x1db40 (o trampolim de dispatch), com os registros
 * de argumento no momento da chamada:
 *
 *   rcx = ponteiro para a estrutura (tipo)
 *   rdx = destino do resultado
 *   r8  = chave / targetId
 *   r9  = argumento extra
 *
 * E tambem o estado do dispatcher naquele instante:
 *   [msftedit+0x224d14] tipo corrente
 *   [msftedit+0x224d10] offset em uso
 *   [msftedit+0x224cd0] base
 *
 * Como o codigo restaura [0x224d10] depois de cada chamada, polling nunca ve
 * o valor. O breakpoint ve.
 *
 * SEGURANCA
 *   - so' le e registra: nao altera registrador de proposito
 *   - seta o Resume Flag (RF) para nao re-disparar em loop
 *   - limite de eventos (PKA_RARE_MAX, default 20000) para nao encher disco
 *   - se o alvo nao for achado, nao arma nada e sai limpo
 *
 * Env
 *   PKA_RARE_OUT    arquivo jsonl (default: ao lado da DLL, pka_dispatch_<pid>.jsonl)
 *   PKA_RARE_MAX    maximo de eventos (default 20000)
 *   PKA_RARE_RVA    RVA do trampolim em msftedit (default 0x1db40)
 *
 * build:
 *   zig cc -target x86_64-windows-gnu -O2 -shared -o native\pka_dispatch_trace.dll native\pka_dispatch_trace.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Ponto de quebra: 0x1dbdd = `call r10`.
 *
 * Ali o r10 JA' contem o ALVO FINAL (base + handler_rva), entao o registro
 * mostra para onde o dispatch realmente vai. Quebrar na entrada (0x1db40) le
 * [0x224d10] antes de ser preenchido e sempre devolve 0 - foi o erro da
 * primeira tentativa no jogo (20.000 eventos, offset=0 em todos).
 */
#define DEFAULT_RVA 0x1DBDDu
#define TYPE_RVA 0x224D14u
#define OFF_RVA 0x224D10u
#define BASE_RVA 0x224CD0u

static uint64_t g_target = 0;      /* VA do trampolim */
static uint64_t g_moduleBase = 0;
static char g_outPath[MAX_PATH];
static FILE *g_out = NULL;
static CRITICAL_SECTION g_lock;
static volatile LONG g_ready = 0;
static volatile LONG g_hits = 0;
static volatile LONG g_maxHits = 20000;
static PVOID g_veh = NULL;

static void trace_log(const char *fmt, ...)
{
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);

    char path[MAX_PATH];
    DWORD n = GetTempPathA((DWORD)sizeof path, path);
    if (n > 0 && n < sizeof path) {
        strncat(path, "pka_rare_boot.log", sizeof path - strlen(path) - 1);
        FILE *f = fopen(path, "a");
        if (f) {
            fprintf(f, "%lu %s\n", (unsigned long)GetTickCount(), line);
            fclose(f);
        }
    }
    OutputDebugStringA(line);
}

/* leitura segura: mingw/zig nao suporta __try/__except, entao validamos a
 * pagina com VirtualQuery antes de tocar. Se a regiao nao for legivel,
 * devolve 0 em vez de derrubar o processo do jogo. */
static int readable(uint64_t address, size_t size)
{
    if (!address) return 0;
    MEMORY_BASIC_INFORMATION mbi;
    if (!VirtualQuery((LPCVOID)(uintptr_t)address, &mbi, sizeof mbi)) return 0;
    if (mbi.State != MEM_COMMIT) return 0;
    if (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)) return 0;
    uint64_t end = (uint64_t)(uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    return (uint64_t)address + size <= end;
}

static uint32_t read_u32(uint64_t address)
{
    if (!readable(address, sizeof(uint32_t))) return 0;
    return *(volatile uint32_t *)(uintptr_t)address;
}

static uint64_t read_u64(uint64_t address)
{
    if (!readable(address, sizeof(uint64_t))) return 0;
    return *(volatile uint64_t *)(uintptr_t)address;
}

static LONG CALLBACK veh_handler(EXCEPTION_POINTERS *info)
{
    if (!info || !info->ExceptionRecord) return EXCEPTION_CONTINUE_SEARCH;
    if (info->ExceptionRecord->ExceptionCode != EXCEPTION_SINGLE_STEP)
        return EXCEPTION_CONTINUE_SEARCH;
    if (!g_target) return EXCEPTION_CONTINUE_SEARCH;

    CONTEXT *ctx = info->ContextRecord;
    if ((uint64_t)ctx->Rip != g_target) return EXCEPTION_CONTINUE_SEARCH;

    uint64_t target = (uint64_t)ctx->R10;

    /* FILTRO: o alvo dominante (~0x7bbd80) recebe 99,9% das chamadas e enche o
     * arquivo em 5 segundos. Ele e' o tick do loop, nao uma acao. Ignoramos o
     * alvo mais frequente para sobrar espaco para os raros - que sao os que
     * carregam informacao (inclusive o ataque). O alvo e' aprendido nas
     * primeiras 200 chamadas e descartado dali em diante. */
    static uint64_t g_hotTarget = 0;
    static LONG g_calibrate = 0;
    if (!g_hotTarget) {
        if (InterlockedIncrement(&g_calibrate) == 200) g_hotTarget = target;
        if (g_calibrate >= 200) { /* segue para gravar */ }
    }

    LONG index = InterlockedIncrement(&g_hits);
    if (target == g_hotTarget && g_hotTarget) {
        ctx->EFlags |= 0x10000;
        return EXCEPTION_CONTINUE_EXECUTION;
    }

    if (index <= g_maxHits && g_out) {
        uint32_t type = read_u32(g_moduleBase + TYPE_RVA);
        uint32_t offset = read_u32(g_moduleBase + OFF_RVA);
        uint64_t base = read_u64(g_moduleBase + BASE_RVA);


        EnterCriticalSection(&g_lock);
        fprintf(g_out,
                "{\"t\":%lu,\"n\":%ld,\"tid\":%lu,"
                "\"rcx\":%llu,\"rdx\":%llu,\"r8\":%llu,\"r9\":%llu,"
                "\"target\":%llu,\"type\":%u,\"offset\":%u,\"base\":%llu}\n",
                (unsigned long)GetTickCount(), index,
                (unsigned long)GetCurrentThreadId(),
                (unsigned long long)ctx->Rcx,
                (unsigned long long)ctx->Rdx,
                (unsigned long long)ctx->R8,
                (unsigned long long)ctx->R9,
                (unsigned long long)target,
                type, offset, (unsigned long long)base);

        fflush(g_out);   /* flush sempre: poucas chamadas e o buffer escondia tudo */
        LeaveCriticalSection(&g_lock);
    } else if (index == g_maxHits + 1) {
        trace_log("limite de %ld eventos atingido; parando de registrar", g_maxHits);
        if (g_out) fflush(g_out);
    }

    /* sem RF a mesma instrucao dispara de novo infinitamente */
    ctx->EFlags |= 0x10000;   /* Resume Flag */
    return EXCEPTION_CONTINUE_EXECUTION;
}

/** Seta DR0/DR7 neste thread. Precisa rodar NO thread alvo. */
static void arm_current_thread(void)
{
    CONTEXT ctx;
    memset(&ctx, 0, sizeof ctx);
    ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;

    HANDLE thread = GetCurrentThread();
    if (!GetThreadContext(thread, &ctx)) return;

    ctx.Dr0 = g_target;
    ctx.Dr7 = 0x1;              /* L0 = 1, RW0 = 00 (executar), LEN0 = 00 */
    ctx.Dr6 = 0;

    SetThreadContext(thread, &ctx);
}

/** Arma em todos os threads do processo.
 *
 * IMPORTANTE: SetThreadContext em thread viva NAO aplica os debug registers de
 * forma confiavel - GetThreadContext devolve o contexto SALVO (que reflete o
 * que escrevemos), mas a CPU so' carrega DR0..DR7 no proximo switch-in. Por
 * isso a thread precisa estar SUSPENSA durante o SetThreadContext. Foi o que
 * fez o tracer parecer "armado" (tap_check_dr via DR0 setado) e nunca disparar.
 */
static int arm_all_threads(void)
{
    DWORD pid = GetCurrentProcessId();
    DWORD self = GetCurrentThreadId();
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;

    THREADENTRY32 te;
    te.dwSize = sizeof te;
    int armed = 0;

    if (Thread32First(snap, &te)) {
        do {
            if (te.th32OwnerProcessID != pid) continue;
            if (te.th32ThreadID == self) continue;   /* si mesmo: sem suspend */

            HANDLE thread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT |
                                       THREAD_SET_CONTEXT, FALSE, te.th32ThreadID);
            if (!thread) continue;

            DWORD suspended = SuspendThread(thread);
            if (suspended == (DWORD)-1) {
                CloseHandle(thread);
                continue;
            }

            CONTEXT ctx;
            memset(&ctx, 0, sizeof ctx);
            ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS;
            if (GetThreadContext(thread, &ctx)) {
                if (ctx.Dr0 != g_target || !(ctx.Dr7 & 1)) {
                    ctx.Dr0 = g_target;
                    ctx.Dr7 = 0x1;      /* L0=1, RW0=00 (exec), LEN0=00 */
                    ctx.Dr6 = 0;
                    if (SetThreadContext(thread, &ctx)) armed++;
                } else {
                    armed++;            /* ja' estava armado */
                }
            }

            ResumeThread(thread);
            CloseHandle(thread);
        } while (Thread32Next(snap, &te));
    }
    CloseHandle(snap);
    return armed;
}

/** Rearma periodicamente: threads novas nascem sem DR0. */
static DWORD WINAPI rearm_thread(LPVOID param)
{
    (void)param;
    for (;;) {
        Sleep(1500);
        arm_all_threads();
    }
    return 0;
}

static void init_once(void)
{
    InitializeCriticalSection(&g_lock);

    /* ambiente quase nunca chega (processo ja' rodando); deriva do PID */
    const char *out = getenv("PKA_RARE_OUT");
    if (out && *out) {
        snprintf(g_outPath, sizeof g_outPath, "%s", out);
    } else {
        char module[MAX_PATH];
        HMODULE self = NULL;
        if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                               (LPCSTR)(uintptr_t)&init_once, &self)) {
            DWORD len = GetModuleFileNameA(self, module, (DWORD)sizeof module);
            if (len > 0 && len < sizeof module) {
                char *slash = strrchr(module, '\\');
                if (slash) {
                    *(slash + 1) = 0;
                    snprintf(g_outPath, sizeof g_outPath, "%spka_rare_%lu.jsonl",
                             module, (unsigned long)GetCurrentProcessId());
                }
            }
        }
        if (!g_outPath[0]) {
            char tmp[MAX_PATH];
            DWORD n = GetTempPathA((DWORD)sizeof tmp, tmp);
            if (n > 0 && n < sizeof tmp) {
                snprintf(g_outPath, sizeof g_outPath, "%spka_rare_%lu.jsonl",
                         tmp, (unsigned long)GetCurrentProcessId());
            }
        }
    }

    /* Configuracao por ARQUIVO, nao por ambiente.
     * Processo ja' em execucao nao herda env: PKA_RARE_MODULE/RVA nunca chegam
     * na injecao. Lemos pka_rare_config.txt ao lado da DLL (fallback %TEMP%):
     *
     *   module=msftedit.dll
     *   rva=1db40
     *   max=20000
     */
    char configPath[MAX_PATH];
    configPath[0] = 0;
    {
        char module[MAX_PATH];
        HMODULE selfMod = NULL;
        if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                               (LPCSTR)(uintptr_t)&init_once, &selfMod)) {
            DWORD len = GetModuleFileNameA(selfMod, module, (DWORD)sizeof module);
            if (len > 0 && len < sizeof module) {
                char *slash = strrchr(module, '\\');
                if (slash) {
                    *(slash + 1) = 0;
                    snprintf(configPath, sizeof configPath, "%spka_rare_config.txt", module);
                }
            }
        }
    }

    char moduleNameBuf[128];
    snprintf(moduleNameBuf, sizeof moduleNameBuf, "msftedit.dll");
    uint32_t rva = DEFAULT_RVA;
    LONG maxHits = 20000;

    FILE *config = configPath[0] ? fopen(configPath, "rb") : NULL;
    if (!config) {
        char tmp[MAX_PATH];
        DWORD n = GetTempPathA((DWORD)sizeof tmp, tmp);
        if (n > 0 && n < sizeof tmp) {
            snprintf(configPath, sizeof configPath, "%spka_rare_config.txt", tmp);
            config = fopen(configPath, "rb");
        }
    }
    if (config) {
        char line[256];
        while (fgets(line, sizeof line, config)) {
            char *eq = strchr(line, '=');
            if (!eq) continue;
            *eq = 0;
            char *key = line;
            char *value = eq + 1;
            /* trim */
            while (*key == ' ' || *key == '\t') key++;
            char *end = key + strlen(key);
            while (end > key && (end[-1] == ' ' || end[-1] == '\t')) *--end = 0;
            while (*value == ' ' || *value == '\t') value++;
            end = value + strlen(value);
            while (end > value && (end[-1] == '\r' || end[-1] == '\n' ||
                                   end[-1] == ' ' || end[-1] == '\t')) *--end = 0;

            if (!strcmp(key, "module") && *value) {
                snprintf(moduleNameBuf, sizeof moduleNameBuf, "%s", value);
            } else if (!strcmp(key, "rva") && *value) {
                rva = (uint32_t)strtoul(value, NULL, 16);
            } else if (!strcmp(key, "max") && *value) {
                long parsed = strtol(value, NULL, 10);
                if (parsed > 0) maxHits = parsed;
            }
        }
        fclose(config);
    }
    const char *moduleName = moduleNameBuf;
    g_maxHits = maxHits;

    HMODULE target = GetModuleHandleA(moduleName);
    if (!target) {
        trace_log("modulo %s nao carregado; tracer nao armado (config=%s)",
                  moduleName, configPath[0] ? configPath : "(sem arquivo)");
        return;
    }
    g_moduleBase = (uint64_t)(uintptr_t)target;
    g_target = g_moduleBase + rva;

    g_out = fopen(g_outPath, "w");
    g_ready = 1;

    g_veh = AddVectoredExceptionHandler(1, veh_handler);
    if (!g_veh) {
        trace_log("AddVectoredExceptionHandler falhou: %lu", GetLastError());
        if (g_out) { fclose(g_out); g_out = NULL; }
        g_ready = 0;
        return;
    }

    arm_current_thread();
    int armed = arm_all_threads();

    trace_log("tracer up pid=%lu alvo=0x%llx (%s+0x%x) threads=%d out=%s",
              (unsigned long)GetCurrentProcessId(),
              (unsigned long long)g_target, moduleName, rva, armed, g_outPath);

    CreateThread(NULL, 0, rearm_thread, NULL, 0, NULL);
}

__declspec(dllexport) DWORD WINAPI PkaRareStart(LPVOID param)
{
    (void)param;
    static LONG started = 0;
    if (InterlockedExchange(&started, 1) == 0) init_once();
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)inst;
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        PkaRareStart(NULL);
    }
    return TRUE;
}





