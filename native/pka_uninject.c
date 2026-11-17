/*
 * pka_uninject.c - descarrega uma DLL injetada num processo.
 *
 *   pka_uninject.exe --name PokeAlliance_dx.exe --module pka_native.dll
 *   pka_uninject.exe --pid 28500 --module pka_native.dll
 *   pka_uninject.exe --name PokeAlliance_dx.exe --all-pka     (todas as pka_*.dll)
 *
 * Por que existe: iterar numa DLL injetada exige descarregar a antiga. Sem
 * isso, injetar de novo cria DUAS copias no processo — as duas abrem o mesmo
 * pipe e escrevem no mesmo log, e o estado observado deixa de ser confiavel.
 * Foi exatamente esse bug que apareceu em 2026-11-09.
 *
 * Metodo: CreateRemoteThread(FreeLibrary) com o HMODULE devolvido por
 * LoadLibraryW no processo alvo. Nao mexe em memoria nem em secoes.
 *
 * LIMITE HONESTO: FreeLibrary so decrementa o refcount. Se a DLL criou uma
 * thread que ainda esta rodando, a thread continua viva com o codigo
 * descarregado -> crash garantido. Por isso a DLL precisa fechar as threads
 * em DllMain(DLL_PROCESS_DETACH). Se ela nao faz isso, o caminho correto e
 * reiniciar o processo alvo.
 *
 * build: zig cc -target x86_64-windows-gnu -O2 -o native\pka_uninject.exe native\pka_uninject.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static DWORD find_by_name(const char *name)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32 pe;
    pe.dwSize = sizeof pe;
    DWORD pid = 0;
    if (Process32First(snap, &pe)) {
        do {
            if (_stricmp(pe.szExeFile, name) == 0) { pid = pe.th32ProcessID; break; }
        } while (Process32Next(snap, &pe));
    }
    CloseHandle(snap);
    return pid;
}

/* devolve o HMODULE da DLL no alvo, ou 0 */
static uint64_t module_in_target(DWORD pid, const char *module)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    MODULEENTRY32W me;
    me.dwSize = sizeof me;
    uint64_t base = 0;
    wchar_t wide[256];
    MultiByteToWideChar(CP_ACP, 0, module, -1, wide, 256);
    if (Module32FirstW(snap, &me)) {
        do {
            if (_wcsicmp(me.szModule, wide) == 0) { base = (uint64_t)(uintptr_t)me.modBaseAddr; break; }
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    return base;
}

/* Chama PkaShutdown (export da propria DLL) dentro do alvo e espera.
 *
 * WHY: FreeLibrary dispara DLL_PROCESS_DETACH com o loader lock tomado. Ali a
 * DLL so' consegue sinalizar parada — nao consegue esperar as proprias
 * threads sem travar o processo. Quando o FreeLibrary retorna e o loader
 * libera a imagem, thread viva executa codigo inexistente -> 0xC0000005.
 *
 * Medido em 2026-11-10 (PID 20556): o unload matou o cliente mesmo com o
 * UnhookWindowsHookEx no detach. A causa era a thread de sessao/scan ainda
 * rodando, nao o hook.
 *
 * PkaShutdown faz a sequencia certa FORA do loader lock: sinaliza, acorda o
 * pipe, espera cada thread, remove o hook. So' entao FreeLibrary e' seguro.
 * Se a DLL nao exportar PkaShutdown (versao antiga), seguimos como antes. */
static int call_export(DWORD pid, uint64_t hmod, const char *exportName, DWORD *outResult)
{
    HANDLE proc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                              PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                              FALSE, pid);
    if (!proc) { printf("OpenProcess falhou (%lu)\n", GetLastError()); return 1; }

    /* O export precisa ser chamado no ALVO. A DLL e' o mesmo arquivo nos dois
     * processos, entao o RVA do export e' identico.
     *
     * CRASH REAL (2026-11-10): LoadLibraryA("pka_native.dll") aqui carrega a
     * DLL DENTRO DO PROPRIO UNINJECT. O DllMain dispara boot_thread ->
     * init_once -> abre pipe, inicia scanner, enumera janelas. Resultado:
     * um segundo bot rodando no processo do uninject, log enganoso com outro
     * PID, e no fim 0xC0000005 no uninject (exit -1073741819).
     *
     * Correcao: LoadLibraryExA com DONT_RESOLVE_DLL_REFERENCES carrega a
     * imagem SEM executar DllMain e SEM resolver imports. So' queremos o
     * endereco base para calcular o RVA do export — nada mais. */
    HMODULE local = LoadLibraryExA("pka_native.dll", NULL,
                                   DONT_RESOLVE_DLL_REFERENCES);
    if (!local) {
        printf("nao consegui carregar copia local de pka_native.dll para achar RVA\n");
        CloseHandle(proc);
        return 1;
    }
    FARPROC fnLocal = GetProcAddress(local, exportName);
    if (!fnLocal) {
        printf("export %s ausente na DLL (versao antiga); seguindo sem shutdown\n", exportName);
        FreeLibrary(local);
        CloseHandle(proc);
        return 2;
    }
    uint64_t rva = (uint64_t)((uintptr_t)fnLocal - (uintptr_t)local);

    /* chamar o export no ALVO usando hmod + rva */
    uint64_t targetFn = hmod + rva;
    HANDLE th2 = CreateRemoteThread(proc, NULL, 0, (LPTHREAD_START_ROUTINE)(uintptr_t)targetFn,
                                    NULL, 0, NULL);
    if (!th2) {
        printf("CreateRemoteThread(%s) falhou (%lu)\n", exportName, GetLastError());
        FreeLibrary(local);
        CloseHandle(proc);
        return 1;
    }
    DWORD w = WaitForSingleObject(th2, 15000);
    DWORD code = 0;
    GetExitCodeThread(th2, &code);
    CloseHandle(th2);
    FreeLibrary(local);
    CloseHandle(proc);

    if (w == WAIT_TIMEOUT) {
        printf("%s nao retornou em 15 s\n", exportName);
        return 1;
    }
    if (outResult) *outResult = code;
    return 0;
}

static int call_freelibrary(DWORD pid, uint64_t hmod)
{
    HANDLE proc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                              PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                              FALSE, pid);
    if (!proc) { printf("OpenProcess falhou (%lu)\n", GetLastError()); return 1; }

    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    FARPROC freeLib = GetProcAddress(k32, "FreeLibrary");
    if (!freeLib) { printf("FreeLibrary nao resolvida\n"); CloseHandle(proc); return 1; }

    HANDLE th = CreateRemoteThread(proc, NULL, 0,
                                   (LPTHREAD_START_ROUTINE)freeLib,
                                   (LPVOID)(uintptr_t)hmod, 0, NULL);
    if (!th) {
        printf("CreateRemoteThread falhou (%lu)\n", GetLastError());
        CloseHandle(proc); return 1;
    }
    WaitForSingleObject(th, 5000);
    DWORD code = 0;
    GetExitCodeThread(th, &code);
    CloseHandle(th);
    CloseHandle(proc);
    printf("FreeLibrary(%#llx) -> exit=%lu (1 = descarregou, 0 = refcount ainda > 1)\n",
           (unsigned long long)hmod, code);
    return 0;
}

int main(int argc, char **argv)
{
    DWORD pid = 0;
    const char *module = NULL;
    const char *procName = NULL;
    int allPka = 0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--pid") && i + 1 < argc) pid = (DWORD)strtoul(argv[++i], NULL, 0);
        else if (!strcmp(argv[i], "--name") && i + 1 < argc) procName = argv[++i];
        else if (!strcmp(argv[i], "--module") && i + 1 < argc) module = argv[++i];
        else if (!strcmp(argv[i], "--all-pka")) allPka = 1;
    }

    if (!pid && procName) pid = find_by_name(procName);
    if (!pid) {
        printf("uso: pka_uninject --name <proc.exe> --module <dll> [--all-pka]\n"
               "     pka_uninject --pid <n> --module <dll>\n");
        return 2;
    }
    printf("alvo pid=%lu\n", (unsigned long)pid);

    if (!allPka) {
        if (!module) { printf("faltou --module (ou use --all-pka)\n"); return 2; }
        uint64_t hmod = module_in_target(pid, module);
        if (!hmod) { printf("%s nao esta carregada em pid %lu\n", module, (unsigned long)pid); return 3; }

        /* SHUTDOWN ORDENADO PRIMEIRO — fora do loader lock, com espera real.
         * Sem isso o FreeLibrary libera codigo com thread nossa ainda viva e
         * o processo morre com 0xC0000005 (medido 2026-11-10, PID 20556). */
        DWORD stuck = 0;
        int rc = call_export(pid, hmod, "PkaShutdown", &stuck);
        if (rc == 0) {
            if (stuck) {
                printf("AVISO: %lu thread(s) nao sairam em 3 s. NAO descarregar "
                       "agora — reinicie o processo alvo.\n", (unsigned long)stuck);
                return 4;
            }
            printf("shutdown ordenado ok (0 threads presas)\n");
        } else if (rc == 2) {
            printf("AVISO: DLL sem PkaShutdown; unload pode derrubar o alvo\n");
        } else {
            printf("AVISO: falha ao chamar PkaShutdown\n");
        }

        return call_freelibrary(pid, hmod);
    }

    /* --all-pka: descarrega toda pka_*.dll, da mais recente para a mais antiga */
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
    if (snap == INVALID_HANDLE_VALUE) { printf("snapshot de modulos falhou\n"); return 1; }
    uint64_t bases[32];
    int n = 0;
    MODULEENTRY32W me;
    me.dwSize = sizeof me;
    if (Module32FirstW(snap, &me)) {
        do {
            if (_wcsnicmp(me.szModule, L"pka", 3) == 0 && n < 32)
                bases[n++] = (uint64_t)(uintptr_t)me.modBaseAddr;
        } while (Module32NextW(snap, &me));
    }
    CloseHandle(snap);
    printf("encontradas %d DLLs pka\n", n);
    for (int i = n - 1; i >= 0; i--) call_freelibrary(pid, bases[i]);
    return 0;
}
