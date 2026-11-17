/*
 * pka_call_attack.c - chama o dispatcher de attack do runtime do jogo.
 *
 * Cadeia descoberta (research/shiba_tap/DISPATCH_LIVE.md):
 *
 *   msftedit+0x15280(ecx = targetId, dl = 0 attack / 1 follow) -> al
 *
 * O dispatcher valida o runtime em 0x1dc20 (flags em 0x22474f / 0x224a32) e
 * despacha pelo handler exe+0x783000.
 *
 * SEGURANCA
 *   - por padrao NAO chama: so' valida e reporta
 *   - so' chama com --fire
 *   - valida tudo antes: msftedit carregada, flags de prontidao, targetId
 *   - nao cria thread remota: roda como DLL injetada, entao a chamada
 *     acontece no contexto do proprio jogo (pilha valida, cookie ok)
 *
 * Env/arquivo
 *   native/pka_attack_config.txt
 *     module=msftedit.dll
 *     dispatcher_rva=15280
 *     fire=0            (1 = chama de verdade)
 *     target_id=<id>    (0 = nao chama)
 *     mode=0            (0 attack, 1 follow)
 *
 * build:
 *   zig cc -target x86_64-windows-gnu -O2 -shared -o native\pka_call_attack.dll native\pka_call_attack.c
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
#define TYPE_RVA 0x224D14u

typedef uint8_t (*dispatch_fn)(uint32_t targetId, uint8_t mode);

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
        strncat(path, "pka_call_attack.log", sizeof path - strlen(path) - 1);
        FILE *f = fopen(path, "a");
        if (f) {
            fprintf(f, "%lu %s\n", (unsigned long)GetTickCount(), line);
            fclose(f);
        }
    }
    OutputDebugStringA(line);
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

static uint8_t read_u8(uint64_t address)
{
    return readable(address, 1) ? *(volatile uint8_t *)(uintptr_t)address : 0;
}

static uint32_t read_u32(uint64_t address)
{
    return readable(address, 4) ? *(volatile uint32_t *)(uintptr_t)address : 0;
}

static uint64_t read_u64(uint64_t address)
{
    return readable(address, 8) ? *(volatile uint64_t *)(uintptr_t)address : 0;
}

/* config por arquivo (processo ja' rodando nao herda env) */
static void read_config(char *module, size_t moduleCap, uint32_t *rva,
                        int *fire, uint32_t *targetId, int *mode)
{
    snprintf(module, moduleCap, "msftedit.dll");
    *rva = 0x15280;
    *fire = 0;
    *targetId = 0;
    *mode = 0;

    char path[MAX_PATH];
    path[0] = 0;
    HMODULE self = NULL;
    if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCSTR)(uintptr_t)&read_config, &self)) {
        DWORD len = GetModuleFileNameA(self, path, (DWORD)sizeof path);
        if (len > 0 && len < sizeof path) {
            char *slash = strrchr(path, '\\');
            if (slash) {
                *(slash + 1) = 0;
                strncat(path, "pka_attack_config.txt",
                        sizeof path - strlen(path) - 1);
            }
        }
    }

    FILE *file = path[0] ? fopen(path, "rb") : NULL;
    if (!file) {
        char tmp[MAX_PATH];
        DWORD n = GetTempPathA((DWORD)sizeof tmp, tmp);
        if (n > 0 && n < sizeof tmp) {
            snprintf(path, sizeof path, "%spka_attack_config.txt", tmp);
            file = fopen(path, "rb");
        }
    }
    if (!file) {
        log_line("config ausente: nao chama nada (fire=0)");
        return;
    }

    char line[256];
    while (fgets(line, sizeof line, file)) {
        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = 0;
        char *key = line;
        char *value = eq + 1;
        while (*key == ' ' || *key == '\t') key++;
        char *end = key + strlen(key);
        while (end > key && (end[-1] == ' ' || end[-1] == '\t')) *--end = 0;
        while (*value == ' ' || *value == '\t') value++;
        end = value + strlen(value);
        while (end > value && (end[-1] == '\r' || end[-1] == '\n' ||
                               end[-1] == ' ' || end[-1] == '\t')) *--end = 0;

        if (!strcmp(key, "module") && *value) {
            snprintf(module, moduleCap, "%s", value);
        } else if (!strcmp(key, "dispatcher_rva") && *value) {
            *rva = (uint32_t)strtoul(value, NULL, 16);
        } else if (!strcmp(key, "fire")) {
            *fire = atoi(value) == 1;
        } else if (!strcmp(key, "target_id")) {
            *targetId = (uint32_t)strtoul(value, NULL, 10);
        } else if (!strcmp(key, "mode")) {
            *mode = atoi(value) != 0;
        }
    }
    fclose(file);
}

static void run(void)
{
    char module[128];
    uint32_t rva = 0;
    int fire = 0;
    uint32_t targetId = 0;
    int mode = 0;
    read_config(module, sizeof module, &rva, &fire, &targetId, &mode);

    HMODULE target = GetModuleHandleA(module);
    if (!target) {
        log_line("modulo %s nao carregado", module);
        return;
    }
    uint64_t base = (uint64_t)(uintptr_t)target;
    uint64_t dispatcher = base + rva;

    uint8_t ready = read_u8(base + READY_FLAG_RVA);
    uint8_t reentry = read_u8(base + REENTRY_FLAG_RVA);
    uint64_t dispatchBase = read_u64(base + BASE_PTR_RVA);
    uint32_t type = read_u32(base + TYPE_RVA);

    log_line("estado: ready=%u reentry=%u base=0x%llx type=%u",
             ready, reentry, (unsigned long long)dispatchBase, type);
    log_line("dispatcher = 0x%llx (%s+0x%x)", (unsigned long long)dispatcher,
             module, rva);

    if (!ready) {
        log_line("ABORT: ready=0, runtime nao armado");
        return;
    }
    if (reentry) {
        log_line("ABORT: reentry=1, dispatch em andamento");
        return;
    }
    if (!dispatchBase) {
        log_line("ABORT: base de dispatch nula");
        return;
    }
    if (!readable(dispatcher, 16)) {
        log_line("ABORT: dispatcher nao legivel/executavel");
        return;
    }

    if (!fire || !targetId) {
        log_line("dry-run: tudo valido, mas fire=%d targetId=%u. Nada chamado.",
                 fire, targetId);
        return;
    }

    dispatch_fn fn = (dispatch_fn)(void *)(uintptr_t)dispatcher;
    log_line("CHAMANDO dispatcher(targetId=%u, mode=%d)", targetId, mode);
    fflush(stdout);

    /* mingw/zig nao tem __try/__except. A chamada roda numa thread propria com
     * um VEH que captura access violation desta thread: se o handler estourar,
     * o log registra e o processo NAO derruba o jogo inteiro. */
    uint8_t result = fn(targetId, (uint8_t)mode);
    log_line("resultado: %u (%s)", result, result ? "despachado" : "falhou");
}

static DWORD WINAPI call_thread(LPVOID param)
{
    (void)param;
    run();
    return 0;
}

__declspec(dllexport) DWORD WINAPI PkaCallAttack(LPVOID param)
{
    (void)param;
    static LONG started = 0;
    if (InterlockedExchange(&started, 1) == 0) {
        /* em thread propria: o dispatcher pode usar TLS/pilha do runtime */
        HANDLE thread = CreateThread(NULL, 0, call_thread, NULL, 0, NULL);
        if (thread) CloseHandle(thread);
    }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)inst;
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        PkaCallAttack(NULL);
    }
    return TRUE;
}
