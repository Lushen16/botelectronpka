# Tracer de dispatch — hardware breakpoint

Registra as chamadas ao trampolim de dispatch do runtime do fornecedor **sem
alterar um byte de código**. Usa debug register (DR0), não inline hook.

## Por que hardware breakpoint

O alvo vive dentro do `msftedit.dll` stomped, que é o runtime do fornecedor
rodando no jogo. Um inline hook escreveria bytes lá:

- irreversível na sessão (o módulo não descarrega)
- se o prólogo for copiado errado, o jogo crasha com o bot rodando
- quebra a cada atualização do vendor (3 builds hoje)

DR0 observa execução por exceção. Nenhum byte muda, o efeito morre com o
processo, e não há risco de corromper código.

## O que registra

Cada entrada no endereço armado, com os registradores de argumento:

```json
{"t":164597078,"n":1,"tid":14448,"rcx":11,"rdx":2,"r8":3,"r9":4,
 "type":0,"offset":0,"base":0}
```

| campo | significado |
| :--- | :--- |
| `rcx` | ponteiro para a estrutura de tipo / primeiro argumento |
| `rdx` | destino do resultado |
| `r8` | chave / targetId |
| `r9` | argumento extra |
| `type` | `[msftedit+0x224d14]` — tipo corrente no dispatcher |
| `offset` | `[msftedit+0x224d10]` — offset em uso **naquele instante** |
| `base` | `[msftedit+0x224cd0]` — base do dispatch |

O `offset` é o dado que polling nunca consegue: o dispatcher **restaura**
`[0x224d10]` logo depois de cada chamada, então ler de fora devolve sempre 0.
O breakpoint vê o valor real.

## Configuração

Por **arquivo**, não por ambiente — processo já em execução não herda env.

`native/pka_trace_config.txt`:

```
module=msftedit.dll
rva=1db40
max=20000
```

| chave | default | descrição |
| :--- | :--- | :--- |
| `module` | `msftedit.dll` | módulo a vigiar |
| `rva` | `1db40` | offset do trampolim dentro do módulo |
| `max` | `20000` | limite de eventos |

O arquivo é lido do lado da DLL, com fallback para `%TEMP%`.

## Saída

`native/pka_dispatch_<pid>.jsonl`, um evento por linha.

## Uso

```cmd
:: 1. compilar
zig cc -target x86_64-windows-gnu -O2 -shared -o native\pka_dispatch_trace.dll native\pka_dispatch_trace.c

:: 2. config para o jogo (o default ja serve)
echo module=msftedit.dll> native\pka_trace_config.txt
echo rva=1db40>> native\pka_trace_config.txt

:: 3. com o jogo e o bot rodando
native\pka_inject.exe --name PokeAlliance_dx.exe --dll native\pka_dispatch_trace.dll

:: 4. ataque um monstro no jogo, depois
node tools\tap_dispatch_report.cjs
```

## Bugs que custaram tempo (não repetir)

1. **`__try/__except` não existe no mingw.** Zig/mingw não suporta SEH.
   Validar com `VirtualQuery` antes de ler.

2. **`SetThreadContext` exige thread suspensa.** Sem `SuspendThread`, o
   `GetThreadContext` devolve o DR0 que você escreveu (parece armado) mas a CPU
   nunca carrega o registro. O tracer ficava "armado" e nunca disparava.

3. **Resume flag é obrigatório.** Sem `ctx->EFlags |= 0x10000`, a mesma
   instrução dispara infinitamente e congela o processo.

4. **Flush em cada evento.** Com buffer a cada 32, poucas chamadas ficavam
   invisíveis no arquivo e parecia que nada foi capturado.

5. **Função-alvo inlinada.** No teste, `-O2` colou o corpo dentro do `main`;
   o endereço existia mas ninguém chamava. `__attribute__((noinline))` resolve.
   Isso era falha do teste, não do tracer.

## Estado verificado

```
node tools/tap_trace_test.cjs     12/12
  alvo nao inlinado (tem call)     :: 1 call(s)
  tracer injetado
  host nao travou (resume flag)
  arquivo de captura criado        :: 4361 bytes
  eventos registrados              :: 70 eventos
  rdx/r8/r9 capturados             :: 2 / 3 / 4
  rcx cresce (sequencia real)      :: 12,13,14,15...80,81
```

O que **não** foi provado: disparo no jogo. Todos os testes usam `bp_host.exe`,
um alvo local com uma função exportada e chamada em loop.

## Ferramentas

```
native/pka_dispatch_trace.c/.dll   o tracer
native/bp_target.c                 alvo de teste (bp_host.exe)
tools/tap_trace_test.cjs           12 testes do mecanismo
tools/tap_check_dr.py              confere DR0/DR7 das threads ao vivo
```
