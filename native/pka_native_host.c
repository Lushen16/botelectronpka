/*
 * pka_native_host.c - carrega pka_native.dll fora do jogo (modo prova).
 *
 * Define PKA_HOST_MODE=1 e PKA_CHANNEL_PID=<n> antes de rodar. O pipe nasce
 * com o PID declarado, sem exigir injecao. Serve para provar o handshake com
 * o cliente real (botfinal --probe).
 *
 * build: zig cc -target x86_64-windows-gnu -O2 -o native\pka_host.exe native\pka_native_host.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

int main(int argc, char **argv)
{
    const char *dll = (argc > 1) ? argv[1] : "pka_native.dll";
    HMODULE mod = LoadLibraryA(dll);
    if (!mod) {
        printf("LoadLibrary falhou: %lu\n", GetLastError());
        return 1;
    }
    printf("dll carregada: %s\n", dll);
    fflush(stdout);

    typedef DWORD (WINAPI *start_fn)(LPVOID);
    start_fn start = (start_fn)(void *)GetProcAddress(mod, "PkaStart");
    if (start) {
        start(NULL);
        printf("PkaStart chamado\n");
    } else {
        printf("DllMain ja iniciou (sem export)\n");
    }
    fflush(stdout);

    printf("rodando; Ctrl+C para parar\n");
    fflush(stdout);
    for (;;) Sleep(1000);
    return 0;
}
