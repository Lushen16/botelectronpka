# Tracer de `Game::walk` — implementação e validação

Data: 2026-11-07
Estado: **implementado e validado em processo auxiliar. NÃO injetado no jogo.**

---

## 1. Arquivos

| arquivo | papel |
| :--- | :--- |
| `native/pka_walktrace.c` | DLL do tracer: ciclo de vida, handler mínimo, desarme verificado |
| `native/walktrace_host.c` | processo auxiliar que dirige prepare→arm→stop→verify |
| `native/walktrace_target.c` | alvo autônomo (modos: normal, negativo, DR0 ocupado, threads curtas) |
| `tools/build_walktrace.cjs` | build via zig (não toca em `pka_native`/`pka_tap`) |
| `native/pka_walktrace.dll` | saída |
| `native/walktrace_host.exe` | saída |
| `native/walktrace_target.exe` | saída |
| `local-data/walktrace-tests/*.txt` | logs de cada cenário |
| `native/walktrace_*.json` | relatório JSON de cada execução |
| `validation-logs/walktrace_build.txt` | toolchain e resultado do build |

Build:

```
node tools/build_walktrace.cjs
```

---

## 2. Ciclo de vida implementado

```
IDLE --PkaWalkTraceStart--> PREPARED --arm--> ARMED
ARMED --PkaWalkTraceStop / limite--> STOPPING
STOPPING --disarm+verify+remove VEH--> DISARMED
                                     \-> DISARM_FAILED
PREPARED --Stop--> DISARMED  (nada armado)
DISARMED/DISARM_FAILED --Stop--> mesmo resultado (idempotente)
```

Estados exportados por `PkaWalkTraceState()`: `0 idle, 1 prepared, 2 armed,
3 stopping, 4 disarmed, 5 disarm_failed`.

Regras de ordem que a implementação garante:

1. `AddVectoredExceptionHandler` ocorre **antes** de qualquer `DR` ser escrito.
2. `Stop()` desarma e **verifica** relendo `DR7` de cada thread **antes** de
   remover o handler.
3. O handler só é removido quando `g_inHandler == 0` (com teto de espera de
   400 ms). Se ainda houver tratamento em andamento, o estado vira
   `DISARM_FAILED` e **o handler é mantido**.
4. Se a remoção do handler falhar, também vira `DISARM_FAILED`, não "limpo".
5. A DLL **nunca** é descarregada por código nosso: o host não chama
   `FreeLibrary`. Se o processo sair, tudo vai junto.

---

## 3. Handler mínimo

O que ele faz:

- compara `ExceptionCode == EXCEPTION_SINGLE_STEP`;
- compara `ExceptionAddress == alvo`;
- exige `Dr6 & (1 << slot)` — o **hardware** dizendo que foi o nosso slot;
- exige `GetCurrentThreadId()` pertencer ao conjunto armado;
- grava `tickMs, rip, rva, tid, dr6, dr7, rdx, r8, rcx` em array **pré-alocado**
  e limitado (`MAX_EVENTS = 256`);
- `EFlags |= RF` para não re-disparar na mesma instrução;
- `Dr6 &= ~(1 << slot)` — limpa **só** o nosso bit;
- ao atingir o limite, apenas levanta `g_stopRequested`.

O que ele **não** faz:

- não abre arquivo, não escreve em disco;
- não chama `SuspendThread` (nem na própria thread);
- não chama a parada completa;
- não aloca memória.

A gravação do JSON e o desarme acontecem na thread de serviço.

---

## 4. Preservação de recursos alheios

| item | como |
| :--- | :--- |
| escolha do slot | `pick_slot()` exige o slot livre em **todas** as threads alvo: `Dr_n == 0`, `DR7.Ln == 0`, `DR7.Gn == 0`, `DR7.RW/LEN == 0`. Se nenhum dos 4 servir, **recusa armar** |
| `DR7` | read-modify-write apenas do nosso slot. Nunca `DR7 = constante` (o código antigo fazia `Dr7 = 0x1` e apagava o resto) |
| `DR6` | limpa somente `1 << slot` no handler e no desarme. Nunca `DR6 = 0` |
| desarme | só mexe no slot se `Dr_n == g_targetVA`. Se outro dono assumiu, registra `ERROR_BUSY` e **não toca** |
| VEH | registrado com `First = 0` (último da cadeia). Qualquer exceção que não seja nossa → `EXCEPTION_CONTINUE_SEARCH` |
| thread morta | `OpenThread` com `THREAD_QUERY_INFORMATION \| SYNCHRONIZE`; `WaitForSingleObject`/`GetExitCodeThread` classificam como "gone", que **não** é falha de desarme |

---

## 5. Resultados reais do processo auxiliar

Todos os 8 cenários, `exit=0`:

| cenário | o que prova | resultado |
| :--- | :--- | :--- |
| `basic` | detecta execução e identifica a thread | 6 eventos, tids = os 3 armados, `leftover=0` |
| `negative` | função alvo nunca chamada | **0 eventos**, `leftover=0` |
| `occupied` | DR0 de terceiro preservado | **slot=1** escolhido, `leftover=0`, eventos só dos tids armados |
| `limit` | parada por contagem | `stopReason=1`, `eventsObserved=3 recorded=2`, `leftover=0` |
| `timeout` | parada por tempo | `stopReason=2`, 132 eventos, `leftover=0` |
| `twice` | parada repetida | `Stop()` 2× devolve 4 (disarmed) nas duas, `leftover=0` |
| `partial` | thread morre durante a observação | `leftover=0` após correção (ver §6) |
| `residual` | função continua sem evento residual | `events_before=3 events_after=3` |

### Evidência do `occupied`

```
DR7 nos eventos: 0x404   -> bit 2 (L1, nosso) + bit 10 (LEN1)
slot escolhido:  1       -> DR0 estava ocupado na thread 0
thread 0:        disparou foreign_probe, NÃO aparece na lista de eventos
```

Três provas numa: o slot alheio foi respeitado, o nosso foi para o próximo
livre, e o breakpoint de terceiro não foi confundido com o nosso.

### Evidência do desarme

`PkaWalkTraceVerifyDisarmed()` relê `DR7` de cada thread armada e conta as que
ainda têm `L<slot>` ou `G<slot>`. Em todos os 8 cenários: `0`.

Para a própria thread do host:

```
DRSELF dr0_after=0x0 dr7_after=0x0
```

---

## 6. Dois bugs reais encontrados pelo teste

Nenhum dos dois apareceria sem o processo auxiliar.

### 6.1 Thread morta contava como falha de desarme

Sintoma: `partial` dava `state=5 (disarm_failed)`, `leftover=3`, `err=5`.

Causa: `OpenThread` era chamado sem `THREAD_QUERY_INFORMATION | SYNCHRONIZE`.
Sem esses direitos, `WaitForSingleObject` devolve `WAIT_FAILED` e
`GetExitCodeThread` devolve `FALSE`, então `thread_is_gone()` respondia sempre
"viva". A thread terminada aceitava `SuspendThread` e `GetThreadContext`, mas
`SetThreadContext` retornava `ACCESS_DENIED` (erro 5).

Diagnóstico feito com um executável separado que reproduziu o caso:

```
mask sem QUERY:  wait=4294967295 exitcode=0 got=0 still=0   -> "viva" (errado)
mask com QUERY:  wait=0          exitcode=0 got=1 still=0   -> "gone" (certo)
```

Correção: incluir `THREAD_QUERY_INFORMATION | SYNCHRONIZE` na abertura, e
re-checar `thread_is_gone()` **depois** de suspender e antes de tratar
`SetThreadContext` falhando.

### 6.2 Breakpoint de terceiro sem handler derruba o processo

Sintoma: cenário `occupied` saía com `0x80000004` (crash).

Causa: o host ocupava `DR0` mas não tratava o próprio
`EXCEPTION_SINGLE_STEP`. Meu handler devolvia `CONTINUE_SEARCH` (correto), e
sem ninguém para tratar, o processo morria. Isso **não** é bug do tracer — é a
consequência normal de `SINGLE_STEP` sem handler. O host passou a registrar um
VEH próprio, como qualquer ferramenta que arma `DR` deve fazer.

Consequência para o jogo: se já existir alguém com `DR` armado lá, essa pessoa
já tem o próprio handler, ou o processo já teria caído. Nada muda para nós.

---

## 7. Coleta no jogo — procedimento exato para autorização

**Não executado.** Precisa de autorização explícita porque injeta DLL.

### 7.1 Antes

```
:: 1. cliente aberto, personagem no mundo
tasklist /FI "IMAGENAME eq PokeAlliance_dx.exe"

:: 2. revalidar build, PID, instância e threads (os TIDs deste doc são históricos)
node tools/trace_exec_context.cjs --pid <PID> --verify-ranges ^
  --ranges botfinal/config/ranges/pokealliance-2026-11-07.json

:: 3. confirmar que nenhuma DLL nossa está carregada
::    (o verify acima e a checagem de modulos ja cobrem isso)
```

Se o `--verify-ranges` recusar, **parar**: build diferente, reancorar.

### 7.2 Configurar

`native/pka_walktrace_config.txt`:

```
module=pokealliance_dx.exe
rva=780c90
max_events=5
max_seconds=60
out=<caminho absoluto>\walktrace_game_<pid>.json
```

Sem linha `threads=`: arma em todas as threads. Com `threads=13520,...`:
arma só nas listadas. Para a primeira coleta, **sem `threads`** é o mais
honesto — a lista de threads muda a cada sessão, e os TIDs do doc são
históricos.

### 7.3 Executar uma única vez

```
native\pka_inject.exe <PID> native\pka_walktrace.dll
```

Depois: **um toque de seta**. Nada de rajada.

### 7.4 Encerrar e verificar

```
:: opcional, se quiser parar antes do limite
:: (o tracer para sozinho em 5 eventos ou 60 s)
```

Ler `walktrace_game_<pid>.json`:

| campo | o que olhar |
| :--- | :--- |
| `state` | `disarmed` = limpo; `disarm_failed` = ver `disarmPending` |
| `handlerRemoved` | `1` = VEH removido |
| `slot` | qual DR foi usado |
| `armedTids` | quem estava armado |
| `eventList[].tid` | qual thread executou |
| `eventList[].rdx` | direção (`edx`) |
| `eventList[].r8` | flag (`r8b`) |
| `disarmPending` | vazio = nada pendente |

### 7.5 Pergunta única desta coleta

**Qual thread alcança `Game::walk` e com quais argumentos?**

Nada além disso. Um evento na entrada **não prova** execução do epílogo.
Não vou ler `+0x9a8/+0x9b0` nesta rodada — exigiria correlacionar entrada e
saída, e não há mecanismo de correlação demonstrado.

### 7.6 Convivência

- Uma DLL só: se `pka_native.dll` ou `pka_tap.dll` estiver carregada, **não
  injetar**; reiniciar o cliente.
- Sem depurador simultâneo (briga por `DR`).
- `out` com nome próprio, nunca `pka_native.log`.

---

## 8. Limitações restantes

1. **Não valida nada do jogo.** Tudo aqui é processo auxiliar.
2. **Um evento na entrada não prova o epílogo.** Não prova `+0x9a8/+0x9b0`.
3. **Não prova thread safety, foco, minimizado ou background.**
4. **`DLL_PROCESS_DETACH` não é garantido** em `TerminateProcess`. Por isso o
   desarme é explícito + timer. Se o processo morrer, `DR` morre junto.
5. **Morte abrupta entre `SuspendThread` e `ResumeThread`** pode deixar thread
   suspensa. Janela de microssegundos; recuperação = fechar o cliente.
6. **Zero hits nas threads escolhidas continua inconclusivo.**
7. `walktrace_target.exe` existe mas o fluxo validado foi pelo
   `walktrace_host.exe` (mesmo processo, sem injeção). O `target` fica como
   alvo alternativo para testes de injeção real, se vierem a ser autorizados.
8. A DLL **não** foi testada dentro do jogo. Nenhuma injeção ocorreu.

---

## 9. O que permanece intocado

- `pendingStep` (walker-engine) — hash `2887A1E7...86864`, inalterado
- `native-step.cjs` — **não** integrado ao walker
- contrato de TTL/claim/UNKNOWN — 20/20 testes
- Teste B, executor nativo próprio, background, minimizado — pendentes
