/*
 * pka_window_target.c - alvo de teste com janela real.
 *
 * Cria uma janela cujo titulo comeca com "PokeAlliance" (o que a pka_native.dll
 * procura) e conta as mensagens WM_KEYDOWN/WM_KEYUP recebidas. Ao encerrar,
 * imprime o total e, se recebeu tecla, escreve um arquivo de resultado.
 *
 * Serve para provar que o PostMessageW da DLL chega de fato na janela.
 * Nao tem relacao com o PokeAlliance real.
 *
 * build: zig cc -target x86_64-windows-gnu -O2 -o native\pka_window_target.exe native\pka_window_target.c -lgdi32 -luser32
 *
 * uso: pka_window_target.exe [--title "PokeAlliance - exec-test"] [--result arquivo.json] [--seconds 30]
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static volatile LONG g_keyDown = 0;
static volatile LONG g_keyUp = 0;
static volatile LONG g_lastVk = 0;
static char g_resultPath[MAX_PATH];
static char g_title[256] = "PokeAlliance - exec-test";

static LRESULT CALLBACK wnd_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    switch (msg) {
    case WM_KEYDOWN:
    case WM_SYSKEYDOWN:
        InterlockedIncrement(&g_keyDown);
        InterlockedExchange(&g_lastVk, (LONG)wp);
        return 0;
    case WM_KEYUP:
    case WM_SYSKEYUP:
        InterlockedIncrement(&g_keyUp);
        InterlockedExchange(&g_lastVk, (LONG)wp);
        return 0;
    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    default:
        break;
    }
    return DefWindowProcA(hwnd, msg, wp, lp);
}

static void write_result(void)
{
    if (!g_resultPath[0]) return;
    FILE *f = fopen(g_resultPath, "w");
    if (!f) return;
    fprintf(f, "{\"pid\":%lu,\"keyDown\":%ld,\"keyUp\":%ld,\"lastVk\":%ld}\n",
            GetCurrentProcessId(), (long)g_keyDown, (long)g_keyUp, (long)g_lastVk);
    fclose(f);
}

int main(int argc, char **argv)
{
    int seconds = 30;
    for (int i = 1; i < argc; i++) {
        if (_stricmp(argv[i], "--title") == 0 && i + 1 < argc) {
            snprintf(g_title, sizeof g_title, "%s", argv[++i]);
        } else if (_stricmp(argv[i], "--result") == 0 && i + 1 < argc) {
            snprintf(g_resultPath, sizeof g_resultPath, "%s", argv[++i]);
        } else if (_stricmp(argv[i], "--seconds") == 0 && i + 1 < argc) {
            seconds = atoi(argv[++i]);
        }
    }

    WNDCLASSA wc;
    memset(&wc, 0, sizeof wc);
    wc.lpfnWndProc = wnd_proc;
    wc.hInstance = GetModuleHandleA(NULL);
    wc.lpszClassName = "PkaWindowTarget";
    wc.hCursor = LoadCursorA(NULL, (LPCSTR)IDC_ARROW);
    wc.hbrBackground = (HBRUSH)GetStockObject(WHITE_BRUSH);
    if (!RegisterClassA(&wc)) {
        printf("RegisterClass falhou: %lu\n", GetLastError());
        return 1;
    }

    HWND hwnd = CreateWindowExA(0, wc.lpszClassName, g_title,
        WS_OVERLAPPEDWINDOW, 100, 100, 640, 480,
        NULL, NULL, wc.hInstance, NULL);
    if (!hwnd) {
        printf("CreateWindow falhou: %lu\n", GetLastError());
        return 1;
    }
    ShowWindow(hwnd, SW_SHOW);
    UpdateWindow(hwnd);
    printf("janela pronta pid=%lu hwnd=0x%lx title=%s\n",
           GetCurrentProcessId(), (unsigned long)(uintptr_t)hwnd, g_title);
    fflush(stdout);

    DWORD deadline = GetTickCount() + (DWORD)seconds * 1000;
    MSG msg;
    while (GetTickCount() < deadline) {
        while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg);
            DispatchMessageA(&msg);
        }
        Sleep(10);
    }

done:
    write_result();
    printf("fim keyDown=%ld keyUp=%ld lastVk=%ld\n",
           (long)g_keyDown, (long)g_keyUp, (long)g_lastVk);
    fflush(stdout);
    return 0;
}
