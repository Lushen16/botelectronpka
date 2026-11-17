/*
 * apiset_target.c - alvo de teste que importa ReadFile/WriteFile de um API SET
 * (api-ms-win-core-file-l1-1-0.dll), exatamente como o payload do fornecedor.
 *
 * O tap antigo comparava o nome da DLL contra "kernel32.dll" e nunca casava com
 * api-ms-win-core-file-l1-1-0.dll -> captura vazia. Este alvo prova a correcao.
 *
 * Cria um named pipe, conecta a si mesmo e escreve/le um frame no formato do
 * canal ([u32 len][u32 kind][payload]) para que o tap tenha o que capturar.
 *
 * build:
 *   zig cc -target x86_64-windows-gnu -O2 -o native\apiset_target.exe \
 *          native\apiset_target.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdint.h>

/* Forca o import a vir do api-set, nao de kernel32. */
__declspec(dllimport) BOOL WINAPI ReadFile(HANDLE, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);
__declspec(dllimport) BOOL WINAPI WriteFile(HANDLE, LPCVOID, DWORD, LPDWORD, LPOVERLAPPED);

#define KIND_WELCOME 3

static void frame_header(uint8_t *out, uint32_t len, uint32_t kind)
{
    out[0] = (uint8_t)(len & 0xff);
    out[1] = (uint8_t)((len >> 8) & 0xff);
    out[2] = (uint8_t)((len >> 16) & 0xff);
    out[3] = (uint8_t)((len >> 24) & 0xff);
    out[4] = (uint8_t)(kind & 0xff);
    out[5] = (uint8_t)((kind >> 8) & 0xff);
    out[6] = (uint8_t)((kind >> 16) & 0xff);
    out[7] = (uint8_t)((kind >> 24) & 0xff);
}

int main(int argc, char **argv)
{
    int seconds = 25;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = atoi(argv[++i]);
    }

    char pipeName[128];
    DWORD pid = GetCurrentProcessId();
    snprintf(pipeName, sizeof pipeName, "\\\\.\\pipe\\pka-runtime-2-%lu", (unsigned long)pid);

    HANDLE server = CreateNamedPipeA(
        pipeName,
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1, 65536, 65536, 0, NULL);
    if (server == INVALID_HANDLE_VALUE) {
        printf("CreateNamedPipe falhou: %lu\n", GetLastError());
        return 1;
    }
    printf("pipe: %s (pid %lu)\n", pipeName, (unsigned long)pid);
    fflush(stdout);

    HANDLE client = CreateFileA(pipeName, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                                OPEN_EXISTING, 0, NULL);
    if (client == INVALID_HANDLE_VALUE) {
        printf("CreateFile falhou: %lu\n", GetLastError());
        return 1;
    }
    ConnectNamedPipe(server, NULL);

    /* write: servidor -> cliente, via api-set. Em LOOP porque o tap e injetado
     * depois que este processo ja subiu: sem trafego continuo nao ha o que
     * capturar e o teste passa/falha por timing em vez de provar o hook. */
    printf("enviando frames por %d s (injete o tap agora)\n", seconds);
    fflush(stdout);

    for (int i = 0; i < seconds * 4; i++) {
        uint8_t payload[16];
        memset(payload, 0x41 + (i % 26), sizeof payload);
        uint8_t buffer[8 + sizeof payload];
        frame_header(buffer, sizeof payload, KIND_WELCOME);
        memcpy(buffer + 8, payload, sizeof payload);

        DWORD written = 0;
        if (!WriteFile(server, buffer, (DWORD)sizeof buffer, &written, NULL)) {
            printf("WriteFile falhou: %lu\n", GetLastError());
            break;
        }

        /* le o eco do cliente para o tap ver c2s tambem */
        DWORD got = 0;
        uint8_t inbox[256];
        if (ReadFile(client, inbox, (DWORD)sizeof inbox, &got, NULL) && got) {
            frame_header(buffer, got > 8 ? got - 8 : 0, KIND_WELCOME);
        }
        Sleep(250);
    }
    printf("fim do envio\n");
    fflush(stdout);

    Sleep(500);
    CloseHandle(client);
    CloseHandle(server);
    return 0;
}
