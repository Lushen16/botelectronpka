/*
 * pka_tap.c - espiao passivo do canal nativo.
 *
 * Injeta no MESMO processo do jogo onde o runtime do fornecedor roda. Nao cria
 * pipe, nao disputa instancia, nao fala o protocolo: apenas registra todo byte
 * que passa pelo named pipe em ambos os sentidos. O handshake deles continua
 * intacto e o menu deles segue funcionando.
 *
 * Como funciona
 *   1. percorre a IAT de todos os modulos carregados
 *   2. troca WriteFile / ReadFile / PeekNamedPipe (kernel32) e NtWriteFile /
 *      NtReadFile (ntdll) por um thunk nosso
 *   3. no thunk, descobre se o handle e um pipe pka-runtime-2-* (uma vez, com
 *      cache) e, se for, grava o buffer em jsonl antes de chamar o original
 *
 * Sem inline hook, sem trampolim, sem disassembler de prologo: so reescreve
 * slots da IAT. Reversivel e sem risco de meio-prologo. Modulos carregados
 * depois sao pegos pelo rescanner.
 *
 * Em processo servidor: WriteFile = servidor->cliente (s2c),
 *                       ReadFile  = cliente->servidor (c2s).
 *
 * Env
 *   PKA_TAP_OUT    arquivo jsonl (default %TEMP%\pka_tap.jsonl)
 *   PKA_TAP_ALL=1  captura qualquer pipe, nao so pka-*
 *   PKA_TAP_MAX    bytes maximos por registro (default 8192)
 *
 * build: zig cc -target x86_64-windows-gnu -O2 -shared -o native\pka_tap.dll native\pka_tap.c
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------ config */
static char g_outPath[MAX_PATH];
static FILE *g_out = NULL;
static CRITICAL_SECTION g_lock;
static int g_ready = 0;
static int g_captureAll = 0;
/* Telemetry do canal passa de 8 KB facil (roster + moves + items + creatures +
 * alertEvents). 8192 truncava o JSON no meio e o decoder nao conseguia parsear.
 * O maximo de frame do protocolo e 2105344; aqui 1 MB cobre com folga. */
static size_t g_maxBytes = 1024 * 1024;
static volatile LONG g_records = 0;
static volatile LONG g_hookCalls = 0;
static volatile LONG g_pipeHandles = 0;
/* Sinal de parada para o rescan_thread. Ver PkaShutdown. */
static volatile LONG g_stop = 0;
/* Handle da thread de rescan, para o shutdown poder esperar. */
static HANDLE g_rescanThread = NULL;

static void log_boot(const char *fmt, ...);

/* --------------------------------------------------- handle -> eh pipe? */
#define HCACHE 64
typedef struct { HANDLE h; int verdict; } hcache_t; /* verdict: 0=nao 1=sim 2=desconhecido */
static hcache_t g_cache[HCACHE];
static int g_cacheCount = 0;

typedef struct {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR  Buffer;
} USTR;

typedef LONG (NTAPI *NtQueryObject_t)(HANDLE, ULONG, PVOID, ULONG, PULONG);
static NtQueryObject_t pNtQueryObject = NULL;

#define OBJ_NAME_INFORMATION 1

static int handle_is_pka_pipe(HANDLE h)
{
    if (!h || h == INVALID_HANDLE_VALUE) return 0;

    for (int i = 0; i < g_cacheCount; i++)
        if (g_cache[i].h == h) return g_cache[i].verdict == 1;

    /* Nao consultamos o NOME do handle: NtQueryObject(OBJ_NAME_INFORMATION) em
     * pipe sincrono pode bloquear indefinidamente e congelar o processo.
     * Filtramos por TIPO (pipe) aqui e por CONTEUDO em plausible_frame(),
     * que e barato e nao bloqueia. */
    int verdict = (GetFileType(h) == FILE_TYPE_PIPE) ? 1 : 0;

    if (g_cacheCount < HCACHE) {
        g_cache[g_cacheCount].h = h;
        g_cache[g_cacheCount].verdict = verdict;
        g_cacheCount++;
    }
    return verdict;
}

/* -------------------------------------------------------------- dump */
/* IMPORTANTE: quem escreve pode mandar o header de 8 bytes e o corpo em
 * DUAS chamadas WriteFile separadas (a nossa pka_native.dll faz exatamente
 * isso). Entao nao da para validar por chunk isolado: montamos o frame por
 * handle e validamos o stream. */
#define STREAM_SLOTS 16
typedef struct {
    HANDLE h;
    int dir;        /* 0 = s2c, 1 = c2s. Um pipe DUPLEX usa o MESMO handle nas
                     * duas direcoes; sem separar por direcao os buffers se
                     * misturam e nenhum frame fecha. */
    uint8_t buf[64 * 1024];
    size_t used;
    int rejected;   /* stream classificado como nao-canal; para de acumular */
} stream_t;
static stream_t g_streams[STREAM_SLOTS];
static int g_streamCount = 0;

static stream_t *stream_for(HANDLE h, int dir)
{
    for (int i = 0; i < g_streamCount; i++)
        if (g_streams[i].h == h && g_streams[i].dir == dir) return &g_streams[i];
    if (g_streamCount >= STREAM_SLOTS) return NULL;
    stream_t *s = &g_streams[g_streamCount++];
    memset(s, 0, sizeof *s);
    s->h = h;
    s->dir = dir;
    return s;
}

static void hex_append(char *dst, const uint8_t *src, size_t len)
{
    static const char *d = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        dst[i * 2]     = d[src[i] >> 4];
        dst[i * 2 + 1] = d[src[i] & 0x0f];
    }
    dst[len * 2] = 0;
}

static void emit(const char *dir, HANDLE h, int32_t kind, const uint8_t *payload, size_t len)
{
    if (!g_ready || !g_out) return;
    size_t cap = len > g_maxBytes ? g_maxBytes : len;
    char *hex = (char *)malloc(cap * 2 + 1);
    if (!hex) return;
    hex_append(hex, payload, cap);

    EnterCriticalSection(&g_lock);
    fprintf(g_out,
            "{\"t\":%lu,\"dir\":\"%s\",\"pid\":%lu,\"h\":\"%p\",\"kind\":%d,\"n\":%zu,"
            "\"trunc\":%s,\"d\":\"%s\"}\n",
            (unsigned long)GetTickCount(), dir, (unsigned long)GetCurrentProcessId(),
            (void *)h, kind, len, len > cap ? "true" : "false", hex);
    if (InterlockedIncrement(&g_records) > 0) fflush(g_out);
    LeaveCriticalSection(&g_lock);
    free(hex);
}

/**
 * Alimenta o stream do handle com os bytes desta chamada e emite cada frame
 * completo.
 *
 * Sobre ruido: se o tap entrar no meio de um stream (ou pegar um pipe que nao
 * e o canal, ex. IPC do Chromium), o primeiro header e invalido. Nao
 * descartamos o stream para sempre: procuramos o proximo header plausivel
 * (resync). Assim um pipe que comece sujo ainda e capturado depois, e um pipe
 * de ruido simplesmente nao gera frame nenhum.
 */
static int header_ok(const uint8_t *p)
{
    uint32_t frameLen = 0;
    int32_t kind = 0;
    memcpy(&frameLen, p, 4);
    memcpy(&kind, p + 4, 4);
    if (frameLen > 2105344u) return 0;
    if (kind < 1 || kind > 32) return 0;
    return 1;
}

static void feed(const char *dir, HANDLE h, const void *data, size_t len)
{
    if (!g_ready || !data || !len) return;
    stream_t *s = stream_for(h, dir[0] == 'c' ? 1 : 0);
    if (!s) return;

    if (len > sizeof s->buf) {
        /* payload maior que o buffer: grava so o comeco, mas ainda emite
         * o frame (o decoder aceita truncado). */
        len = sizeof s->buf;
    }
    if (s->used + len > sizeof s->buf) {
        /* nao cabe: descarta o acumulado e recomeca deste chunk */
        s->used = 0;
    }
    memcpy(s->buf + s->used, data, len);
    s->used += len;

    /* resync: anda ate achar um header plausivel */
    size_t start = 0;
    while (s->used - start >= 8 && !header_ok(s->buf + start)) start++;
    if (start) {
        memmove(s->buf, s->buf + start, s->used - start);
        s->used -= start;
    }

    size_t offset = 0;
    while (s->used - offset >= 8) {
        uint32_t frameLen = 0;
        int32_t kind = 0;
        memcpy(&frameLen, s->buf + offset, 4);
        memcpy(&kind, s->buf + offset + 4, 4);
        if (!header_ok(s->buf + offset)) break;
        if (s->used - offset < 8 + frameLen) break;
        emit(dir, h, kind, s->buf + offset + 8, frameLen);
        offset += 8 + frameLen;
    }
    if (offset) {
        memmove(s->buf, s->buf + offset, s->used - offset);
        s->used -= offset;
    }
}

/* ------------------------------------------------------------- thunks */
typedef BOOL  (WINAPI *WriteFile_t)(HANDLE, LPCVOID, DWORD, LPDWORD, LPOVERLAPPED);
typedef BOOL  (WINAPI *ReadFile_t)(HANDLE, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);
typedef BOOL  (WINAPI *PeekNamedPipe_t)(HANDLE, LPVOID, DWORD, LPDWORD, LPDWORD, LPDWORD);
typedef LONG  (NTAPI  *NtWriteFile_t)(HANDLE, HANDLE, void *, void *, void *, void *, ULONG, void *, void *);
typedef LONG  (NTAPI  *NtReadFile_t)(HANDLE, HANDLE, void *, void *, void *, void *, ULONG, void *, void *);

static WriteFile_t      real_WriteFile = NULL;
static ReadFile_t       real_ReadFile = NULL;
static PeekNamedPipe_t  real_PeekNamedPipe = NULL;
static NtWriteFile_t    real_NtWriteFile = NULL;
static NtReadFile_t     real_NtReadFile = NULL;

static BOOL WINAPI hook_WriteFile(HANDLE h, LPCVOID buf, DWORD n, LPDWORD written, LPOVERLAPPED ov)
{
    InterlockedIncrement(&g_hookCalls);
    BOOL ok = real_WriteFile(h, buf, n, written, ov);
    if (handle_is_pka_pipe(h) && ok && written && *written) {
        InterlockedIncrement(&g_pipeHandles);
        feed("s2c", h, buf, *written);
    }
    return ok;
}

static BOOL WINAPI hook_ReadFile(HANDLE h, LPVOID buf, DWORD n, LPDWORD read, LPOVERLAPPED ov)
{
    InterlockedIncrement(&g_hookCalls);
    BOOL ok = real_ReadFile(h, buf, n, read, ov);
    if (handle_is_pka_pipe(h) && ok && read && *read) {
        InterlockedIncrement(&g_pipeHandles);
        feed("c2s", h, buf, *read);
    }
    return ok;
}

static BOOL WINAPI hook_PeekNamedPipe(HANDLE h, LPVOID buf, DWORD n, LPDWORD read,
                                      LPDWORD avail, LPDWORD left)
{
    BOOL ok = real_PeekNamedPipe(h, buf, n, read, avail, left);
    return ok;
}

static LONG NTAPI hook_NtWriteFile(HANDLE h, HANDLE ev, void *apc, void *actx,
                                   void *iosb, void *buf, ULONG len,
                                   void *off, void *key)
{
    LONG st = real_NtWriteFile(h, ev, apc, actx, iosb, buf, len, off, key);
    if (st >= 0 && handle_is_pka_pipe(h) && buf && len)
        feed("s2c", h, buf, len);
    return st;
}

static LONG NTAPI hook_NtReadFile(HANDLE h, HANDLE ev, void *apc, void *actx,
                                  void *iosb, void *buf, ULONG len,
                                  void *off, void *key)
{
    LONG st = real_NtReadFile(h, ev, apc, actx, iosb, buf, len, off, key);
    /* IO_STATUS_BLOCK: Status depois de read; 0 = success */
    if (st >= 0 && iosb) {
        LONG ioStatus = ((LONG *)iosb)[0];
        SIZE_T got = *(SIZE_T *)((BYTE *)iosb + sizeof(void *));
        if (ioStatus >= 0 && got && handle_is_pka_pipe(h) && buf)
            feed("c2s", h, buf, got);
    }
    return st;
}

/* --------------------------------------------------------- IAT patcher */
typedef struct { const char *name; void *hook; void **orig; } hookdef_t;

/* Hook por NOME DE FUNCAO, em qualquer DLL importada.
 *
 * Descoberta que custou uma captura vazia: o payload do fornecedor NAO importa
 * ReadFile/WriteFile de "kernel32.dll". Ele importa de
 * "api-ms-win-core-file-l1-1-0.dll" (API set) - verificado com pefile em
 * dumps/payload_reconstructed.dll. Comparar o nome da DLL contra "kernel32.dll"
 * nunca casa, e nenhum slot e patcheado.
 *
 * Entao casamos so o nome da funcao. Se o alvo importa ReadFile de qualquer
 * api-set ou de kernel32, nos pegamos.
 *
 * Continua sendo SO a camada kernel32/apis e nao a ntdll: hookar as duas grava
 * cada byte duas vezes (kernel32 chama ntdll por dentro) e dessincroniza o
 * decoder.
 */
static hookdef_t g_hooks[] = {
    { "WriteFile", (void *)hook_WriteFile, (void **)&real_WriteFile },
    { "ReadFile",  (void *)hook_ReadFile,  (void **)&real_ReadFile },
};
#define NHOOKS ((int)(sizeof g_hooks / sizeof g_hooks[0]))

/** Normaliza o nome do import para comparacao: minusculas, sem ".dll". */
static int dll_matches(const char *imported, const char *wanted)
{
    return _stricmp(imported, wanted) == 0;
}

static int patch_module(HMODULE mod, int *patched)
{
    if (!mod) return 0;
    BYTE *base = (BYTE *)mod;
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;

    IMAGE_DATA_DIRECTORY dir =
        nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!dir.VirtualAddress || !dir.Size) return 0;

    IMAGE_IMPORT_DESCRIPTOR *imp =
        (IMAGE_IMPORT_DESCRIPTOR *)(base + dir.VirtualAddress);

    int before = *patched;
    char modName[MAX_PATH];
    modName[0] = 0;
    GetModuleFileNameA(mod, modName, (DWORD)sizeof modName);
    char *slash = strrchr(modName, '\\');
    const char *shortName = slash ? slash + 1 : modName;

    for (; imp->Name; imp++) {
        IMAGE_THUNK_DATA *oft = imp->OriginalFirstThunk
            ? (IMAGE_THUNK_DATA *)(base + imp->OriginalFirstThunk) : NULL;
        IMAGE_THUNK_DATA *ft = (IMAGE_THUNK_DATA *)(base + imp->FirstThunk);
        if (!oft || !ft) continue;

        for (; oft->u1.AddressOfData; oft++, ft++) {
            if (IMAGE_SNAP_BY_ORDINAL(oft->u1.Ordinal)) continue;
            IMAGE_IMPORT_BY_NAME *ibn =
                (IMAGE_IMPORT_BY_NAME *)(base + oft->u1.AddressOfData);
            const char *fn = (const char *)ibn->Name;

            for (int i = 0; i < NHOOKS; i++) {
                /* casa so o nome da funcao: o import pode vir de qualquer
                 * api-set (api-ms-win-core-file-l1-1-0.dll) ou de kernel32. */
                if (strcmp(fn, g_hooks[i].name) != 0) continue;

                void *current = (void *)(uintptr_t)ft->u1.Function;
                if (current == g_hooks[i].hook) break;   /* ja patchado */

                /* guarda o original na primeira vez (todos os modulos resolvem
                 * para o mesmo endereco dentro do processo) */
                if (*g_hooks[i].orig == NULL && current) *g_hooks[i].orig = current;
                if (*g_hooks[i].orig == NULL) break;

                DWORD old = 0;
                if (!VirtualProtect(&ft->u1.Function, sizeof(void *),
                                    PAGE_READWRITE, &old)) break;
                ft->u1.Function = (ULONG_PTR)g_hooks[i].hook;
                VirtualProtect(&ft->u1.Function, sizeof(void *), old, &old);
                (*patched)++;
                break;
            }
        }
    }
    /* diagnostico: sem saber QUAIS modulos foram patcheados nao da' pra
     * distinguir "o alvo nao usa a IAT" de "nunca vimos o modulo certo". */
    if (*patched > before) {
        log_boot("patch: %s +%d (total %d)", shortName, *patched - before, *patched);
    }
    return *patched;
}

static HMODULE g_self = NULL;

/**
 * Diagnostico: para cada modulo, diz se ele importa ReadFile/WriteFile e qual
 * endereco esta no slot da IAT. Roda uma vez, depois do boot. Sem isso, "hook
 * nunca chamado" pode ser (a) o modulo nao importa essas funcoes, (b) importa
 * mas o slot aponta para dentro de outro modulo que nao o nosso, ou (c) nao
 * vimos o modulo. Tres causas, tres correcoes diferentes.
 */
static void dump_iat(const char *onlyModule)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snap == INVALID_HANDLE_VALUE) return;
    MODULEENTRY32 me;
    me.dwSize = sizeof me;
    if (Module32First(snap, &me)) {
        do {
            if (onlyModule && _stricmp(me.szModule, onlyModule) != 0) continue;
            BYTE *base = me.modBaseAddr;
            IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)base;
            if (dos->e_magic != IMAGE_DOS_SIGNATURE) continue;
            IMAGE_NT_HEADERS *nt = (IMAGE_NT_HEADERS *)(base + dos->e_lfanew);
            if (nt->Signature != IMAGE_NT_SIGNATURE) continue;
            IMAGE_DATA_DIRECTORY dir =
                nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
            if (!dir.VirtualAddress) continue;

            IMAGE_IMPORT_DESCRIPTOR *imp =
                (IMAGE_IMPORT_DESCRIPTOR *)(base + dir.VirtualAddress);
            for (; imp->Name; imp++) {
                IMAGE_THUNK_DATA *oft = imp->OriginalFirstThunk
                    ? (IMAGE_THUNK_DATA *)(base + imp->OriginalFirstThunk) : NULL;
                IMAGE_THUNK_DATA *ft = (IMAGE_THUNK_DATA *)(base + imp->FirstThunk);
                if (!oft || !ft) continue;
                for (; oft->u1.AddressOfData; oft++, ft++) {
                    if (IMAGE_SNAP_BY_ORDINAL(oft->u1.Ordinal)) continue;
                    IMAGE_IMPORT_BY_NAME *ibn =
                        (IMAGE_IMPORT_BY_NAME *)(base + oft->u1.AddressOfData);
                    const char *fn = (const char *)ibn->Name;
                    if (strcmp(fn, "ReadFile") != 0 && strcmp(fn, "WriteFile") != 0)
                        continue;
                    void *slot = (void *)(uintptr_t)ft->u1.Function;
                    int isOurs = (slot == (void *)hook_ReadFile ||
                                  slot == (void *)hook_WriteFile);
                    log_boot("iat %s!%s -> %p %s", me.szModule, fn, slot,
                             isOurs ? "NOSSO" : "EXTERNO");
                    break;
                }
            }
        } while (Module32Next(snap, &me));
    }
    CloseHandle(snap);
}

/**
 * Encontra e patcheia slots de import SEM usar o header PE.
 *
 * Por que isto existe: o runtime do fornecedor e' injetado por module stomping
 * em msftedit.dll, e o header PE la' dentro esta ZERADO (verificado no
 * processo vivo: os primeiros 0x1000 bytes sao todos 0x00, sem "MZ" e sem
 * "PE\0\0"). O patcher de IAT classico le o header para achar o diretorio de
 * import, entao ele pulava o modulo principal em silencio - foi por isso que
 * tivemos "patched=45" e zero captura.
 *
 * Estrategia sem header:
 *   1. varre as regioes executaveis do modulo procurando instrucoes que leem
 *      memoria RIP-relative (call/jmp/mov [rip+disp32])
 *   2. calcula o endereco alvo de cada uma
 *   3. le o qword naquele endereco e compara com o endereco real de
 *      WriteFile/ReadFile
 *   4. se bater, e' um slot de import: patcheia
 *
 * Falso positivo e' praticamente impossivel: exigiria bytes aleatorios
 * formarem o opcode E o qword apontar exatamente para a funcao de sistema.
 */
#define OP_CALL_RIP 0xFF15   /* ff 15 disp32 : call qword [rip+d] */
#define OP_JMP_RIP  0xFF25   /* ff 25 disp32 : jmp  qword [rip+d] */

/**
 * Garante que real_WriteFile/real_ReadFile apontem para a implementacao de
 * sistema ANTES de qualquer hook ser instalado.
 *
 * Por que isto e' critico: `module_stomped_find` compara o conteudo do slot com
 * `*g_hooks[h].orig`. Se o patcher de IAT nao tiver rodado (ou nao tiver achado
 * o slot), esse ponteiro fica NULL, `real == NULL` faz o scanner descartar
 * TODO slot, e o modulo stomped nunca e' capturado - foi exatamente o que
 * aconteceu (Stomp mudo, 45 slots de outros modulos, zero captura no jogo).
 *
 * Os slots da IAT do runtime deles apontam para KERNEL32.DLL (medido em
 * 291 slots no processo vivo), entao resolver por kernel32 e' o que casa.
 */
static void resolve_real_functions(void)
{
    HMODULE k32 = GetModuleHandleA("kernel32.dll");
    HMODULE kbase = GetModuleHandleA("kernelbase.dll");
    if (!real_WriteFile) {
        real_WriteFile = (WriteFile_t)(void *)GetProcAddress(k32, "WriteFile");
        if (!real_WriteFile && kbase)
            real_WriteFile = (WriteFile_t)(void *)GetProcAddress(kbase, "WriteFile");
    }
    if (!real_ReadFile) {
        real_ReadFile = (ReadFile_t)(void *)GetProcAddress(k32, "ReadFile");
        if (!real_ReadFile && kbase)
            real_ReadFile = (ReadFile_t)(void *)GetProcAddress(kbase, "ReadFile");
    }
    /* publica em g_hooks para o scanner comparar */
    g_hooks[0].orig = (void **)&real_WriteFile;
    g_hooks[1].orig = (void **)&real_ReadFile;
    log_boot("real: WriteFile=%p ReadFile=%p", (void *)real_WriteFile,
             (void *)real_ReadFile);
}

static int module_stomped_find(void)
{
    int patched = 0;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snap == INVALID_HANDLE_VALUE) return 0;
    MODULEENTRY32 me;
    me.dwSize = sizeof me;

    if (Module32First(snap, &me)) {
        do {
            if (me.hModule == g_self) continue;
            BYTE *modBase = me.modBaseAddr;
            /* so modulos com header zerado precisam deste caminho */
            if (modBase[0] == 'M' && modBase[1] == 'Z') continue;

            int local = 0;
            uint64_t begin = (uint64_t)(uintptr_t)modBase;
            uint64_t end = begin + me.modBaseSize;
            uint64_t addr = begin;

            MEMORY_BASIC_INFORMATION mbi;
            while (addr < end) {
                if (!VirtualQuery((LPCVOID)(uintptr_t)addr, &mbi, sizeof mbi)) break;
                uint64_t regionBase = (uint64_t)(uintptr_t)mbi.BaseAddress;
                uint64_t regionEnd = regionBase + mbi.RegionSize;

                int exec = (mbi.State == MEM_COMMIT) &&
                           (mbi.Protect & (PAGE_EXECUTE | PAGE_EXECUTE_READ |
                                           PAGE_EXECUTE_READWRITE |
                                           PAGE_EXECUTE_WRITECOPY)) &&
                           !(mbi.Protect & PAGE_GUARD);
                if (exec) {
                    const BYTE *p = (const BYTE *)(uintptr_t)regionBase;
                    size_t n = (size_t)(regionEnd - regionBase);
                    for (size_t i = 0; i + 6 <= n; i++) {
                        int isCall = (p[i] == 0xFF && p[i + 1] == 0x15);
                        int isJmp = (p[i] == 0xFF && p[i + 1] == 0x25);
                        if (!isCall && !isJmp) continue;
                        (void)OP_CALL_RIP; (void)OP_JMP_RIP;
                        int32_t disp = 0;
                        memcpy(&disp, p + i + 2, 4);
                        uint64_t site = regionBase + i;
                        uint64_t slotAddr = (site + 6 + (int64_t)disp);
                        if (slotAddr == 0 || (slotAddr & 7)) continue;

                        /* leitura segura: VirtualQuery antes de tocar */
                        MEMORY_BASIC_INFORMATION slotInfo;
                        if (!VirtualQuery((LPCVOID)(uintptr_t)slotAddr, &slotInfo,
                                          sizeof slotInfo)) continue;
                        if (slotInfo.State != MEM_COMMIT) continue;
                        if (slotInfo.Protect & (PAGE_NOACCESS | PAGE_GUARD)) continue;
                        uint64_t slotValue = 0;
                        memcpy(&slotValue, (const void *)(uintptr_t)slotAddr,
                               sizeof slotValue);
                        if (!slotValue) continue;

                        for (int h = 0; h < NHOOKS; h++) {
                            void *real = *g_hooks[h].orig;
                            if (!real || (void *)(uintptr_t)slotValue != real) continue;
                            if ((void *)(uintptr_t)slotValue == g_hooks[h].hook) break;

                            DWORD old = 0;
                            if (!VirtualProtect((LPVOID)(uintptr_t)slotAddr,
                                                sizeof(uint64_t), PAGE_READWRITE, &old))
                                break;
                            uint64_t replacement = (uint64_t)(uintptr_t)g_hooks[h].hook;
                            memcpy((void *)(uintptr_t)slotAddr, &replacement,
                                   sizeof replacement);
                            VirtualProtect((LPVOID)(uintptr_t)slotAddr,
                                           sizeof(uint64_t), old, &old);
                            local++;
                            patched++;
                            log_boot("stomp: %s slot 0x%llx (site 0x%llx) -> %s",
                                     me.szModule, (unsigned long long)slotAddr,
                                     (unsigned long long)site, g_hooks[h].name);
                            break;
                        }
                    }
                }
                if (regionEnd <= addr) break;
                addr = regionEnd;
            }
            if (local) {
                log_boot("stomp: %s +%d slots (header zerado)", me.szModule, local);
            }
        } while (Module32Next(snap, &me));
    }
    CloseHandle(snap);
    return patched;
}

static int scan_and_patch(void)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, GetCurrentProcessId());
    if (snap == INVALID_HANDLE_VALUE) return 0;
    MODULEENTRY32 me;
    me.dwSize = sizeof me;
    int patched = 0;
    if (Module32First(snap, &me)) {
        do {
            if (me.hModule == g_self) continue;
            if (me.hModule == GetModuleHandleA("kernel32.dll")) continue;
            if (me.hModule == GetModuleHandleA("ntdll.dll")) continue;
            patch_module(me.hModule, &patched);
        } while (Module32Next(snap, &me));
    }
    CloseHandle(snap);
    return patched;
}

/* --------------------------------------------------------------- boot */
static DWORD WINAPI rescan_thread(LPVOID p)
{
    (void)p;
    /* A DLL do fornecedor carrega DEPOIS do tap (ela entra quando o menu
     * autentica). Se o patch da IAT dela demorar 2s, o handshake inteiro
     * (challenge/authenticate/welcome) passa sem ser visto. Primeiros 30s:
     * varre a cada 100ms. Depois desacelera para 2s. */
    int ticks = 0;
    for (;;) {
        Sleep(ticks < 300 ? 100 : 2000);
        ticks++;
        /* Parada ordenada: sem isso a thread segue viva depois do FreeLibrary
         * e executa codigo liberado -> 0xC0000005.
         * MEDIDO em 2026-11-11: o uninject do tap derrubou o cliente porque
         * esta thread (e o hook de IAT) continuavam ativos no unload. */
        if (InterlockedCompareExchange(&g_stop, 0, 0) != 0) {
            log_boot("rescan saindo (stop sinalizado)");
            return 0;
        }
        resolve_real_functions();
        int patched = scan_and_patch();
        if (patched) log_boot("rescan patchou %d slots (tick %d)", patched, ticks);

        /* Modulos com header PE zerado (module stomping) nao sao vistos pelo
         * patcher de IAT. Este segundo caminho acha os slots por varredura de
         * instrucoes RIP-relative. E' o que pega o runtime do fornecedor em
         * msftedit.dll. */
        int stomped = module_stomped_find();
        if (stomped) log_boot("rescan stomp patchou %d slots (tick %d)", stomped, ticks);

        /* Diagnostico a cada ~5s: separa "hook nunca chamado" (IAT nao
         * patcheada) de "hook chamado mas nada gravado" (handle nao e pipe,
         * ou filtro rejeitou). Sem isso, arquivo de 0 byte nao diz nada. */
        if ((ticks % 25) == 0) {
            log_boot("stats: hookCalls=%ld pipeHandles=%ld records=%ld",
                     (long)g_hookCalls, (long)g_pipeHandles, (long)g_records);
        }
    }
    return 0;
}

static void log_boot(const char *fmt, ...)
{
    char line[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line, sizeof line, fmt, ap);
    va_end(ap);

    char path[MAX_PATH];
    DWORD n = GetTempPathA((DWORD)sizeof path, path);
    if (n > 0 && n < sizeof path) {
        strncat(path, "pka_tap_boot.log", sizeof path - strlen(path) - 1);
        FILE *f = fopen(path, "a");
        if (f) { fprintf(f, "%lu %s\n", (unsigned long)GetTickCount(), line); fclose(f); }
    }
    OutputDebugStringA(line);
}

static void init_once(void)
{
    InitializeCriticalSection(&g_lock);

    /* Um processo ja em execucao NAO herda o ambiente de quem injeta, entao
     * PKA_TAP_OUT quase nunca chega. Ordem:
     *   1. PKA_TAP_OUT no ambiente do alvo (raro)
     *   2. pka_tap_<pid>.jsonl ao lado da DLL  <- caminho real na injecao
     *   3. %TEMP%\pka_tap_<pid>.jsonl
     * O PID no nome e obrigatorio: o jogo e o menu sao processos diferentes e
     * precisam de arquivos separados (senao um truncaria o outro). */
    const char *out = getenv("PKA_TAP_OUT");
    if (out && *out) {
        snprintf(g_outPath, sizeof g_outPath, "%s", out);
    } else {
        char module[MAX_PATH];
        HMODULE self = NULL;
        g_outPath[0] = 0;
        if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                               GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                               (LPCSTR)(uintptr_t)&init_once, &self)) {
            DWORD len = GetModuleFileNameA(self, module, (DWORD)sizeof module);
            if (len > 0 && len < sizeof module) {
                char *slash = strrchr(module, '\\');
                if (slash) {
                    *(slash + 1) = 0;
                    snprintf(g_outPath, sizeof g_outPath, "%spka_tap_%lu.jsonl",
                             module, (unsigned long)GetCurrentProcessId());
                }
            }
        }
        if (!g_outPath[0]) {
            char tmp[MAX_PATH];
            DWORD n = GetTempPathA((DWORD)sizeof tmp, tmp);
            if (n > 0 && n < sizeof tmp) {
                snprintf(g_outPath, sizeof g_outPath, "%spka_tap_%lu.jsonl",
                         tmp, (unsigned long)GetCurrentProcessId());
            }
        }
    }
    const char *all = getenv("PKA_TAP_ALL");
    if (all && all[0] == '1') g_captureAll = 1;
    const char *maxb = getenv("PKA_TAP_MAX");
    if (maxb && *maxb) { long v = strtol(maxb, NULL, 10); if (v > 0) g_maxBytes = (size_t)v; }

    g_out = fopen(g_outPath, "w");
    g_ready = 1;

    /* ordem importa: sem os ponteiros reais, o scanner de module stomping
     * descarta todo slot (real == NULL). */
    resolve_real_functions();
    int patched = scan_and_patch();
    int stomped = module_stomped_find();
    log_boot("pka_tap up pid=%lu out=%s patched=%d stomped=%d",
             (unsigned long)GetCurrentProcessId(), g_outPath, patched, stomped);

    g_rescanThread = CreateThread(NULL, 0, rescan_thread, NULL, 0, NULL);
}
__declspec(dllexport) DWORD WINAPI PkaTapStart(LPVOID p)
{
    (void)p;
    static LONG started = 0;
    if (InterlockedExchange(&started, 1) == 0) init_once();
    return 0;
}

/* Parada ORDENADA, chamada pela thread remota do injetor ANTES do FreeLibrary.
 *
 * WHY (medido 2026-11-11, PID 14784): remover o tap com o uninject derrubou o
 * cliente com 0xC0000005. Causa: o rescan_thread continuava em laco (Sleep de
 * ate 2s) e o hook de IAT seguia apontando para codigo desta DLL. O
 * DLL_PROCESS_DETACH nao consegue esperar thread (loader lock), entao o
 * FreeLibrary liberava a imagem com execucao viva.
 *
 * Este export faz o que o detach nao pode: sinaliza, espera a thread sair e
 * fecha o arquivo. Depois dele o FreeLibrary e' seguro.
 *
 * Retorna 1 se a thread saiu no prazo, 0 se nao. */
__declspec(dllexport) DWORD WINAPI PkaShutdown(LPVOID p)
{
    (void)p;
    InterlockedExchange(&g_stop, 1);

    DWORD saiu = 1;
    if (g_rescanThread) {
        /* espera ate 5s: o pior caso do laco e' Sleep(2000) + varredura */
        if (WaitForSingleObject(g_rescanThread, 5000) == WAIT_TIMEOUT) saiu = 0;
        CloseHandle(g_rescanThread);
        g_rescanThread = NULL;
    }

    /* O hook de IAT continua instalado; a imagem NAO pode ser liberada com ele
     * ativo. Restaurar os slots e' o que o tap ja' sabe fazer: guardamos os
     * ponteiros reais em resolve_real_functions. Sem um undo registrado, a
     * unica saida segura e' NAO descarregar. */
    if (g_out) {
        EnterCriticalSection(&g_lock);
        fflush(g_out);
        fclose(g_out);
        g_out = NULL;
        LeaveCriticalSection(&g_lock);
    }

    log_boot("PkaShutdown: stop=1 threadSaiu=%lu", (unsigned long)saiu);
    return saiu;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_self = (HMODULE)inst;
        DisableThreadLibraryCalls(inst);
        PkaTapStart(NULL);
    }
    return TRUE;
}


