/*
 * pka_attack_loop.c - chama o dispatcher de attack repetidamente, com alvo
 * fornecido por arquivo.
 *
 * Diferenca do pka_call_attack.dll: aquele executa UMA vez (guard `started`).
 * Para um bot de verdade o ataque precisa ser re-invocavel a cada alvo novo.
 *
 * Mecanismo
 *   Um thread poll a cada 50 ms o arquivo pka_attack_target.txt ao lado da DLL:
 *
 *       <targetId>,<mode>,<counter>
 *       1082733237,0,17
 *
 *   Quando o `counter` muda, chama o dispatcher com aquele id. O contador existe
 *   para o mesmo alvo poder ser atacado duas vezes (o runtime precisa de nova
 *   chamada a cada skill/tick).
 *
 * Cadeia (research/shiba_tap/DISPATCH_LIVE.md):
 *   msftedit+0x15280(ecx = targetId, dl = modo) -> al
 *     modo 0 = attack -> exe+0x783000
 *     modo 1 = follow -> exe+0x7831d0
 *
 * Seguranca
 *   - valida ready/reentry/base antes de cada chamada
 *   - nao chama nada ate o arquivo existir com counter maior
 *   - log de toda chamada em %TEMP%\pka_attack_loop.log
 *
 * build:
 *   zig cc -target x86_64-windows-gnu -O2 -shared -o native\pka_attack_loop.dll native\pka_attack_loop.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define READY_FLAG_RVA 0x22474Fu
#define REENTRY_FLAG_RVA 0x224A32u
#define BASE_PTR_RVA 0x224CD0u

typedef uint8_t (*dispatch_fn)(uint32_t targetId, uint8_t mode);

static char g_dir[MAX_PATH];
static volatile LONG g_calls = 0;
static volatile LONG g_ok = 0;

static void log_line(const char *fmt, ...)
{
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);

    char path[MAX_PATH];
    DWORD n = GetTempPathA((DWORD)sizeof path, path);
    if (n > 0 && n < sizeof path) {
        strncat(path, "pka_attack_loop.log", sizeof path - strlen(path) - 1);
        FILE *f = fopen(path, "a");
        if (f) {
            fprintf(f, "%lu %s\n", (unsigned long)GetTickCount(), line);
            fclose(f);
        }
    }
}

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

static uint8_t read_u8(uint64_t a) { return readable(a, 1) ? *(volatile uint8_t *)(uintptr_t)a : 0; }
static uint64_t read_u64(uint64_t a) { return readable(a, 8) ? *(volatile uint64_t *)(uintptr_t)a : 0; }

/** Le "<targetId>,<mode>,<counter>". Retorna 1 se leu os tres. */
static int read_target(uint32_t *targetId, int *mode, long *counter)
{
    char path[MAX_PATH];
    snprintf(path, sizeof path, "%spka_attack_target.txt", g_dir);
    FILE *file = fopen(path, "rb");
    if (!file) return 0;
    char line[128];
    int ok = 0;
    if (fgets(line, sizeof line, file)) {
        unsigned int id = 0;
        int m = 0;
        long c = 0;
        if (sscanf(line, "%u,%d,%ld", &id, &m, &c) == 3) {
            *targetId = id;
            *mode = m != 0;
            *counter = c;
            ok = 1;
        }
    }
    fclose(file);
    return ok;
}

static void run(void)
{
    uint32_t rva = 0x15280;
    {
        char path[MAX_PATH];
        snprintf(path, sizeof path, "%spka_attack_loop_config.txt", g_dir);
        FILE *file = fopen(path, "rb");
        if (file) {
            char line[256];
            while (fgets(line, sizeof line, file)) {
                char *eq = strchr(line, '=');
                if (!eq) continue;
                *eq = 0;
                if (!strcmp(line, "dispatcher_rva")) {
                    rva = (uint32_t)strtoul(eq + 1, NULL, 16);
                }
            }
            fclose(file);
        }
    }

    HMODULE target = GetModuleHandleA("msftedit.dll");
    if (!target) {
        log_line("ABORT: msftedit nao carregada");
        return;
    }
    uint64_t base = (uint64_t)(uintptr_t)target;
    uint64_t dispatcher = base + rva;

    if (!readable(dispatcher, 16)) {
        log_line("ABORT: dispatcher 0x%llx nao legivel", (unsigned long long)dispatcher);
        return;
    }

    dispatch_fn fn = (dispatch_fn)(void *)(uintptr_t)dispatcher;
    long lastCounter = -1;
    log_line("loop up: dispatcher=0x%llx dir=%s", (unsigned long long)dispatcher, g_dir);
    log_line("aguardando pka_attack_target.txt (id,modo,contador)");

    for (;;) {
        uint32_t targetId = 0;
        int mode = 0;
        long counter = 0;
        if (read_target(&targetId, &mode, &counter) && counter != lastCounter) {
            lastCounter = counter;

            uint8_t ready = read_u8(base + READY_FLAG_RVA);
            uint8_t reentry = read_u8(base + REENTRY_FLAG_RVA);
            uint64_t dispatchBase = read_u64(base + BASE_PTR_RVA);

            if (!ready || reentry || !dispatchBase || !targetId) {
                log_line("SKIP id=%u: ready=%u reentry=%u base=0x%llx",
                         targetId, ready, reentry, (unsigned long long)dispatchBase);
            } else {
                InterlockedIncrement(&g_calls);
                uint8_t result = fn(targetId, (uint8_t)mode);
                if (result) InterlockedIncrement(&g_ok);
                log_line("call id=%u mode=%d -> %u (%ld/%ld ok)",
                         targetId, mode, result, (long)g_ok, (long)g_calls);
            }
        }
        Sleep(50);
    }
}

static DWORD WINAPI loop_thread(LPVOID param)
{
    (void)param;
    run();
    return 0;
}

__declspec(dllexport) DWORD WINAPI PkaAttackLoop(LPVOID param)
{
    (void)param;
    static LONG started = 0;
    if (InterlockedExchange(&started, 1) == 0) {
        HANDLE thread = CreateThread(NULL, 0, loop_thread, NULL, 0, NULL);
        if (thread) CloseHandle(thread);
    }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        HMODULE self = NULL;
        if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                               (LPCSTR)(uintptr_t)&PkaAttackLoop, &self)) {
            DWORD len = GetModuleFileNameA(self, g_dir, (DWORD)sizeof g_dir);
            if (len > 0 && len < sizeof g_dir) {
                char *slash = strrchr(g_dir, '\\');
                if (slash) *(slash + 1) = 0;
            }
        }
        PkaAttackLoop(NULL);
    }
    return TRUE;
}
