/*
 * bp_target.c - alvo de teste para pka_dispatch_trace.dll.
 *
 * Cria um modulo proprio com uma funcao que o tracer vai vigiar e a chama em
 * loop. Serve para provar que o hardware breakpoint dispara, registra os
 * argumentos e NAO trava o processo (o resume flag tem que estar certo).
 *
 * O alvo e' o inicio de uma funcao exportada, e o tracer usa o RVA dela por
 * env. Assim testamos o mecanismo inteiro (VEH + DR0 + DR7 + RF) sem tocar no
 * jogo.
 *
 * build:
 *   zig cc -target x86_64-windows-gnu -O2 -shared -o native\bp_traced.dll native\bp_target.c
 *   zig cc -target x86_64-windows-gnu -O2 -o native\bp_host.exe native\bp_target.c -DBUILD_HOST
 */

#include <windows.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

/* A funcao vigiada: recebe 4 argumentos e devolve a soma.
 *
 * noinline e' OBRIGATORIO: sem isso o -O2 cola o corpo dentro do main e o
 * endereco em RVA 0x1000 existe mas nunca executa - o breakpoint nao dispara e
 * o teste falha sem o tracer ter culpa. Foi exatamente o primeiro erro aqui.
 */
#if defined(_MSC_VER)
__declspec(noinline)
#elif defined(__GNUC__)
__attribute__((noinline))
#endif
__declspec(dllexport) uint64_t PkaWatched(uint64_t a, uint64_t b, uint64_t c, uint64_t d)
{
    volatile uint64_t sum = a + b + c + d;
    return sum;
}

#ifndef BUILD_HOST
/* modo DLL: nada a fazer */
#else
int main(int argc, char **argv)
{
    int seconds = 15;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--seconds") && i + 1 < argc) seconds = atoi(argv[++i]);
    }

    HMODULE self = GetModuleHandleA(NULL);
    uint64_t base = (uint64_t)(uintptr_t)self;
    uint64_t fn = (uint64_t)(uintptr_t)&PkaWatched;

    printf("host base   = 0x%llx\n", (unsigned long long)base);
    printf("PkaWatched  = 0x%llx  (rva 0x%llx)\n",
           (unsigned long long)fn, (unsigned long long)(fn - base));
    printf("chamando por %d s (injete o tracer agora)\n", seconds);
    fflush(stdout);

    for (int i = 0; i < seconds * 10; i++) {
        uint64_t sum = PkaWatched((uint64_t)i, 2, 3, 4);
        if (i % 50 == 0) {
            printf("  chamada %d soma=%llu\n", i, (unsigned long long)sum);
            fflush(stdout);
        }
        Sleep(100);
    }
    printf("fim\n");
    return 0;
}
#endif
