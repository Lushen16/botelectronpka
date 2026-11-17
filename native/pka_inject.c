/*
 * pka_inject.c - injeta pka_native.dll no processo do jogo.
 *
 * Modo 1 (pid):    pka_inject.exe --pid 25876 --dll native\pka_native.dll
 * Modo 2 (nome):   pka_inject.exe --name PokeAlliance_dx.exe --dll native\pka_native.dll
 * Modo 3 (espera): pka_inject.exe --name PokeAlliance_dx.exe --wait --dll native\pka_native.dll
 *
 * CHAVE DO CANAL: um processo ja em execucao nao tem como receber variavel de
 * ambiente. A pka_native.dll procura a chave, nesta ordem:
 *   1. PKA_CHANNEL_KEY no ambiente do alvo (se o jogo foi aberto com ela)
 *   2. PKA_CHANNEL_KEY_FILE no ambiente do alvo
 *   3. pka_channel_key.txt ao lado da DLL  <- caminho normal na injecao
 *   4. %TEMP%\pka_channel_key.txt
 * Portanto: grave a chave em native\pka_channel_key.txt antes de injetar.
 *
 * Nada aqui escreve no processo alem do bloco de parametros e do
 * CreateRemoteThread de LoadLibraryA; nenhuma secao e alterada.
 *
 * build: zig cc -target x86_64-windows-gnu -O2 -o native\pka_inject.exe native\pka_inject.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
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

static char *self_dir(char *out, size_t cap)
{
    DWORD n = GetModuleFileNameA(NULL, out, (DWORD)cap);
    if (n == 0 || n >= cap) return NULL;
    char *slash = strrchr(out, '\\');
    if (slash) *slash = 0;
    return out;
}

static int inject(DWORD pid, const char *dllPath)
{
    char full[MAX_PATH];
    if (GetFullPathNameA(dllPath, (DWORD)sizeof full, full, NULL) == 0) {
        printf("caminho invalido: %s\n", dllPath);
        return 1;
    }
    if (GetFileAttributesA(full) == INVALID_FILE_ATTRIBUTES) {
        printf("dll nao encontrada: %s\n", full);
        return 1;
    }

    HANDLE proc = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION |
                              PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                              FALSE, pid);
    if (!proc) {
        printf("OpenProcess falhou: %lu\n", GetLastError());
        return 1;
    }

    SIZE_T size = strlen(full) + 1;
    LPVOID remote = VirtualAllocEx(proc, NULL, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {
        printf("VirtualAllocEx falhou: %lu\n", GetLastError());
        CloseHandle(proc);
        return 1;
    }
    if (!WriteProcessMemory(proc, remote, full, size, NULL)) {
        printf("WriteProcessMemory falhou: %lu\n", GetLastError());
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
        CloseHandle(proc);
        return 1;
    }

    HMODULE k32 = GetModuleHandleA("kernel32.dll");
    FARPROC loadLibrary = GetProcAddress(k32, "LoadLibraryA");
    if (!loadLibrary) {
        printf("LoadLibraryA nao resolvido\n");
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
        CloseHandle(proc);
        return 1;
    }

    HANDLE thread = CreateRemoteThread(proc, NULL, 0,
        (LPTHREAD_START_ROUTINE)loadLibrary, remote, 0, NULL);
    if (!thread) {
        printf("CreateRemoteThread falhou: %lu\n", GetLastError());
        VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
        CloseHandle(proc);
        return 1;
    }

    WaitForSingleObject(thread, 15000);
    DWORD moduleBase = 0;
    GetExitCodeThread(thread, &moduleBase);
    CloseHandle(thread);
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    CloseHandle(proc);

    if (!moduleBase) {
        printf("LoadLibraryA retornou 0 dentro do alvo (dll recusada ou fora de arch)\n");
        return 1;
    }
    printf("dll carregada em 0x%lx (pid %lu)\n", moduleBase, pid);
    return 0;
}

static void usage(void)
{
    printf("uso: pka_inject.exe (--pid N | --name exe.exe) [--wait] --dll caminho\n");
    printf("     variaveis repassadas ao LoadLibrary: defina PKA_CHANNEL_KEY no ambiente\n");
    printf("     do proprio jogo OU use o log em %%TEMP%%\\pka_native.log\n");
}

int main(int argc, char **argv)
{
    DWORD pid = 0;
    const char *name = NULL;
    const char *dll = NULL;
    int wait = 0;

    for (int i = 1; i < argc; i++) {
        if (_stricmp(argv[i], "--pid") == 0 && i + 1 < argc) pid = (DWORD)strtoul(argv[++i], NULL, 10);
        else if (_stricmp(argv[i], "--name") == 0 && i + 1 < argc) name = argv[++i];
        else if (_stricmp(argv[i], "--dll") == 0 && i + 1 < argc) dll = argv[++i];
        else if (_stricmp(argv[i], "--wait") == 0) wait = 1;
        else if (_stricmp(argv[i], "--help") == 0) { usage(); return 0; }
    }

    if (!dll) {
        char dir[MAX_PATH];
        if (self_dir(dir, sizeof dir)) {
            static char fallback[MAX_PATH];
            snprintf(fallback, sizeof fallback, "%s\\pka_native.dll", dir);
            dll = fallback;
        } else {
            dll = "pka_native.dll";
        }
    }

    if (!pid && name) {
        if (wait) {
            printf("esperando %s...\n", name);
            while (!pid) { pid = find_by_name(name); if (!pid) Sleep(250); }
        } else {
            pid = find_by_name(name);
        }
    }
    if (!pid) {
        printf("processo alvo nao encontrado\n");
        usage();
        return 1;
    }
    printf("alvo pid=%lu dll=%s\n", pid, dll);
    return inject(pid, dll);
}
