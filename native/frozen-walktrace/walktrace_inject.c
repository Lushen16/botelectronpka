/*
 * walktrace_inject.c - injetor PROPRIO do tracer, separado do pka_inject.exe.
 *
 * Por que um injetor separado em vez de estender pka_inject.exe:
 *   pka_inject.c e' componente COMPARTILHADO entre as duas frentes (bot e tap),
 *   segundo o AGENTS.md. Mexer nele para acomodar o tracer arriscaria as duas.
 *   Este arquivo nao toca em nada que as outras frentes usem.
 *
 * Diferenca de comportamento em relacao ao pka_inject:
 *   - carrega a DLL E chama o export de partida, na mesma operacao;
 *   - o VA do export e' resolvido lendo a tabela de export do arquivo em disco,
 *     nao adivinhado;
 *   - reporta separadamente "carregou" e "chamou", porque sao coisas distintas.
 *
 *   walktrace_inject.exe --pid <N> --dll <abs> --call <export> [--timeout MS]
 *
 * Sem --call, apenas carrega (equivalente ao LoadLibrary, sem armar nada).
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- le a tabela de export de um PE em disco e devolve o RVA do nome ---- */
static int export_rva_from_file(const char *path, const char *want,
                                uint32_t *outRva)
{
    FILE *f = fopen(path, "rb");
    if (!f) { printf("ABRIR_FALHOU %s\n", path); return 0; }

    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0 || size > 512L * 1024 * 1024) { fclose(f); return 0; }

    unsigned char *buf = (unsigned char *)malloc((size_t)size);
    if (!buf) { fclose(f); return 0; }
    if (fread(buf, 1, (size_t)size, f) != (size_t)size) { free(buf); fclose(f); return 0; }
    fclose(f);

    int ok = 0;
    do {
        if (size < 0x40) break;
        if (buf[0] != 'M' || buf[1] != 'Z') break;
        uint32_t e_lfanew = *(uint32_t *)(buf + 0x3C);
        if (e_lfanew + 24 > (uint32_t)size) break;
        if (memcmp(buf + e_lfanew, "PE\0\0", 4) != 0) break;

        uint16_t nsec      = *(uint16_t *)(buf + e_lfanew + 6);
        uint16_t optSize   = *(uint16_t *)(buf + e_lfanew + 20);
        uint32_t optOff    = e_lfanew + 24;
        uint16_t magic     = *(uint16_t *)(buf + optOff);
        uint32_t ddOff     = optOff + (magic == 0x20B ? 112 : 96);
        if (ddOff + 8 > (uint32_t)size) break;

        uint32_t expRva = *(uint32_t *)(buf + ddOff + 0 * 8);
        uint32_t expSize = *(uint32_t *)(buf + ddOff + 0 * 8 + 4);
        if (!expRva || !expSize) break;

        uint32_t secOff = optOff + optSize;
        #define RVA2OFF(rva, outp) do {                                   \
            uint32_t _r = (rva); int _hit = 0;                            \
            for (uint16_t _i = 0; _i < nsec; _i++) {                      \
                unsigned char *_s = buf + secOff + _i * 40;               \
                uint32_t _va  = *(uint32_t *)(_s + 12);                   \
                uint32_t _vs  = *(uint32_t *)(_s + 8);                    \
                uint32_t _raw = *(uint32_t *)(_s + 20);                   \
                if (_r >= _va && _r < _va + _vs) {                        \
                    (outp) = _raw + (_r - _va); _hit = 1; break;          \
                }                                                         \
            }                                                             \
            if (!_hit) { (outp) = 0; }                                    \
        } while (0)

        uint32_t expOff = 0; RVA2OFF(expRva, expOff);
        if (!expOff || expOff + 40 > (uint32_t)size) break;

        uint32_t nNames  = *(uint32_t *)(buf + expOff + 24);
        uint32_t namesRva = *(uint32_t *)(buf + expOff + 32);
        uint32_t ordRva   = *(uint32_t *)(buf + expOff + 36);
        uint32_t fnRva    = *(uint32_t *)(buf + expOff + 28);

        uint32_t namesOff = 0; RVA2OFF(namesRva, namesOff);
        uint32_t ordOff   = 0; RVA2OFF(ordRva, ordOff);
        uint32_t fnOff    = 0; RVA2OFF(fnRva, fnOff);
        if (!namesOff || !ordOff || !fnOff) break;

        for (uint32_t i = 0; i < nNames; i++) {
            uint32_t nameRva = *(uint32_t *)(buf + namesOff + i * 4);
            uint32_t nameOff = 0; RVA2OFF(nameRva, nameOff);
            if (!nameOff || nameOff >= (uint32_t)size) continue;
            const char *nm = (const char *)(buf + nameOff);
            if (strcmp(nm, want) != 0) continue;
            uint16_t ord = *(uint16_t *)(buf + ordOff + i * 2);
            uint32_t funcRva = *(uint32_t *)(buf + fnOff + (uint32_t)ord * 4);
            if (funcRva) { *outRva = funcRva; ok = 1; }
            break;
        }
        #undef RVA2OFF
    } while (0);

    free(buf);
    return ok;
}

/* GetExitCodeThread devolve DWORD: o HMODULE de 64 bits seria TRUNCADO.
 * Por isso a base e' obtida enumerando modulos do processo alvo pelo nome do
 * arquivo, nao pelo exit code do thread remoto. */
static uint64_t module_base_in(uint64_t hprocSnapshotPid, const char *dllFile)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32,
                                           (DWORD)hprocSnapshotPid);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    MODULEENTRY32W me; me.dwSize = sizeof me;
    uint64_t base = 0;
    if (Module32FirstW(snap, &me)) {
        do {
            if (_wcsicmp(me.szModule, L"") == 0) continue;
            char nameA[MAX_PATH];
            WideCharToMultiByte(CP_ACP, 0, me.szModule, -1, nameA, sizeof nameA,
                                NULL, NULL);
            if (_stricmp(nameA, dllFile) == 0) { base = (uint64_t)me.modBaseAddr; break; }
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    return base;
}

static DWORD find_by_name(const char *name)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32 pe; pe.dwSize = sizeof pe;
    DWORD pid = 0;
    if (Process32First(snap, &pe)) {
        do {
            if (_stricmp(pe.szExeFile, name) == 0) { pid = pe.th32ProcessID; break; }
        } while (Process32Next(snap, &pe));
    }
    CloseHandle(snap);
    return pid;
}

int main(int argc, char **argv)
{
    DWORD pid = 0;
    const char *name = NULL, *dll = NULL, *call = NULL;
    int timeoutMs = 15000;

    for (int i = 1; i < argc; i++) {
        if (!_stricmp(argv[i], "--pid") && i + 1 < argc) pid = (DWORD)strtoul(argv[++i], NULL, 10);
        else if (!_stricmp(argv[i], "--name") && i + 1 < argc) name = argv[++i];
        else if (!_stricmp(argv[i], "--dll") && i + 1 < argc) dll = argv[++i];
        else if (!_stricmp(argv[i], "--call") && i + 1 < argc) call = argv[++i];
        else if (!_stricmp(argv[i], "--timeout") && i + 1 < argc) timeoutMs = atoi(argv[++i]);
        else if (!_stricmp(argv[i], "--help")) {
            printf("uso: walktrace_inject.exe --pid N --dll <abs> [--call export] [--timeout ms]\n");
            return 0;
        }
    }

    if (!pid && name) pid = find_by_name(name);
    if (!pid || !dll) {
        printf("uso: walktrace_inject.exe --pid N --dll <abs> [--call export] [--timeout ms]\n");
        return 2;
    }

    char full[MAX_PATH];
    if (!GetFullPathNameA(dll, (DWORD)sizeof full, full, NULL)) {
        printf("CAMINHO_INVALIDO %s\n", dll); return 2;
    }
    if (GetFileAttributesA(full) == INVALID_FILE_ATTRIBUTES) {
        printf("DLL_NAO_ENCONTRADA %s\n", full); return 2;
    }

    uint32_t exportRva = 0;
    if (call && !export_rva_from_file(full, call, &exportRva)) {
        printf("EXPORT_NAO_ENCONTRADO export=%s dll=%s\n", call, full);
        return 2;
    }
    printf("DLL=%s\n", full);
    if (call) printf("EXPORT_RVA=%s+0x%x\n", call, exportRva);

    HANDLE proc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                              PROCESS_VM_OPERATION | PROCESS_VM_WRITE |
                              PROCESS_VM_READ, FALSE, pid);
    if (!proc) { printf("OPENPROCESS_FALHOU err=%lu\n", GetLastError()); return 3; }

    SIZE_T size = strlen(full) + 1;
    LPVOID remote = VirtualAllocEx(proc, NULL, size, MEM_COMMIT | MEM_RESERVE,
                                   PAGE_READWRITE);
    if (!remote) { printf("VALLOC_FALHOU err=%lu\n", GetLastError()); CloseHandle(proc); return 3; }
    if (!WriteProcessMemory(proc, remote, full, size, NULL)) {
        printf("WRITE_FALHOU err=%lu\n", GetLastError());
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE); CloseHandle(proc); return 3;
    }

    HMODULE k32 = GetModuleHandleA("kernel32.dll");
    FARPROC loadLibrary = GetProcAddress(k32, "LoadLibraryA");

    HANDLE th = CreateRemoteThread(proc, NULL, 0,
        (LPTHREAD_START_ROUTINE)loadLibrary, remote, 0, NULL);
    if (!th) {
        printf("REMOTE_THREAD_FALHOU err=%lu\n", GetLastError());
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE); CloseHandle(proc); return 3;
    }
    WaitForSingleObject(th, (DWORD)timeoutMs);
    DWORD exitCode = 0;
    GetExitCodeThread(th, &exitCode);
    CloseHandle(th);
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);

    if (exitCode == 0) {
        printf("LOAD_FALHOU (LoadLibraryA retornou 0)\n");
        CloseHandle(proc); return 4;
    }

    /* Base real (64-bit) pelo nome do arquivo, nao pelo exit code. */
    const char *dllFile = strrchr(full, '\\');
    dllFile = dllFile ? dllFile + 1 : full;
    uint64_t moduleBase = module_base_in((uint64_t)pid, dllFile);
    if (!moduleBase) {
        printf("LOADED_MAS_BASE_DESCONHECIDA exitcode=0x%lx\n",
               (unsigned long)exitCode);
        CloseHandle(proc); return 4;
    }
    printf("LOADED base=0x%llx (64-bit, por enumeracao de modulo)\n",
           (unsigned long long)moduleBase);

    if (call) {
        uint64_t fnVa = moduleBase + exportRva;
        /* CreateRemoteThread recebe 1 argumento; o export e'
         * LONG WINAPI f(LPVOID) e aceita NULL. */
        HANDLE th2 = CreateRemoteThread(proc, NULL, 0,
            (LPTHREAD_START_ROUTINE)(uintptr_t)fnVa, NULL, 0, NULL);
        if (!th2) {
            printf("CALL_THREAD_FALHOU err=%lu\n", GetLastError());
            CloseHandle(proc); return 5;
        }
        WaitForSingleObject(th2, (DWORD)timeoutMs);
        DWORD ret = 0;
        GetExitCodeThread(th2, &ret);
        CloseHandle(th2);
        printf("CALL_RETURNED %s=0x%lx\n", call, (unsigned long)ret);
    }

    CloseHandle(proc);
    printf("DONE\n");
    return 0;
}
