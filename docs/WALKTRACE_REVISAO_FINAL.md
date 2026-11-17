# Tracer de `Game::walk` — revisão final

Data: 2026-11-07
Estado: **implementado, validado em processo auxiliar, pronto para UMA coleta.
Nenhuma injeção no jogo ocorreu.**

Substitui `WALKTRACE_IMPLEMENTACAO_E_VALIDACAO.md` nas partes corrigidas.

---

## 0. Correção: decodificação de DR7

A versão anterior dizia "`0x404` = L1 + LEN1". **Errado.** Decodificação campo a
campo:

```
DR7 bit  0 = L0         bit  1 = G0
DR7 bit  2 = L1         bit  3 = G1      <- L1 = 0x004
DR7 bit  4 = L2         bit  5 = G2
DR7 bit  6 = L3         bit  7 = G3
DR7 bit  8 = LE         bit  9 = GE
DR7 bit 10 = reservado, deve ser 1       <- 0x400 = bit 10, NAO LEN1
DR7 bit 11 = reservado, deve ser 0

RW_n  = bits (16 + 4n) .. (17 + 4n)      00=exec 01=write 11=io
LEN_n = bits (18 + 4n) .. (19 + 4n)      00=1B  01=2B  10=8B  11=4B
```

Portanto, `0x404`:

| campo | valor | leitura |
| :--- | :--- | :--- |
| L1 (bit 2) | 1 | slot 1 habilitado **localmente** |
| G1 (bit 3) | 0 | não global |
| bit 10 | 1 | reservado — **deve** ser 1, não é LEN |
| LEN1 (bits 22–23) | 0 | 1 byte |
| RW1 (bits 20–21) | 0 | execução |

No cenário `occupied` o tracer usou o slot 1; LEN1=00 (1 byte) é o correto para
breakpoint de execução. O observado `dr7=0x404` era consistente — só a minha
explicação estava errada.

### Estado de DR antes / durante / depois

Registrado pela thread 0 nas três fases (o host agora decodifica e imprime):

```
DR7_AT_BEFORE_ARM   dr0=0x7ff7d0801030 dr7=0x401  L0=1 bit10=1 LEN0=0
DR7_AT_AFTER_DISARM dr0=0x7ff7d0801030 dr7=0x401  L0=1 bit10=1 LEN0=0
```

`DR0` e `DR7` **idênticos** antes e depois: o breakpoint do terceiro
permaneceu configurado. E continuou **funcional**:

```
FOREIGN_STILL_ARMED hits_during=14 hits_after_stop=4 fires_after=YES
```

4 disparos **depois** do nosso desarme. "Usou slot 1" sozinho não provaria;
isto prova.

---

## 1. Garantias do ciclo de vida — estado no código

| garantia | onde | como |
| :--- | :--- | :--- |
| armamento parcial faz rollback | `PkaWalkTraceStart` | se `g_armFailedCount > 0`, desarma tudo que armou, verifica e volta a `IDLE`. Se o rollback falhar → `DISARM_FAILED` e o VEH fica |
| TID visível **antes** do DR ser escrito | `PkaWalkTraceStart` | `g_armedCount` incrementa antes de `arm_one()`; `arm_one` faz `ResumeThread` internamente |
| falha de retomada explícita | `sample`/`disarm_one` | `SuspendThread` devolve contagem anterior; falha é reportada com TID + erro + estágio, nunca "sucesso" |
| thread morta ≠ falha de consulta | `thread_is_gone()` | exige `THREAD_QUERY_INFORMATION`+`SYNCHRONIZE`; `WaitForSingleObject`/`GetExitCodeThread` decidem |
| nenhum worker rearma após parada | `worker_thread` | `g_workerStop` e o loop saem no primeiro `stopRequested`; **não existe** thread de rearme periódica |
| entradas concorrentes contadas | handler | `g_concurrentEntries`, `g_droppedWhileClosing` |
| `DISARMED` exige verificação | `do_stop` | relê `DR7` de todas as threads armadas; qualquer pendência → `DISARM_FAILED` |
| `DISARM_FAILED` mantém diagnóstico | `do_stop` | grava `disarmPending[]` com `tid/err/stage`; não declara limpo |
| `DllMain` sem limpeza bloqueante | `DllMain` | só `DisableThreadLibraryCalls`; partida é por export explícito |
| DLL não é descarregada por nós | host | sem `FreeLibrary`; documentado |

### A corrida de `g_inHandler == 0`

O contador isolado **não bastava**. Sequência problemática:

```
handler:  if (gateOpen)          <- true
Stop:     gateOpen = 0
Stop:     ve inHandler == 0      <- ainda 0
handler:  inHandler++            <- incrementa DEPOIS do teste do Stop
Stop:     remove VEH / desarma
```

Agora o protocolo é de duas fases no lado do handler:

```
inHandler++
if (!gateOpen) { inHandler--; nao registra; CONSOME a excecao }
```

Quem incrementou depois do fechamento percebe e desiste; quem incrementou antes
é visível ao dreno do Stop. O Stop faz: fecha gate → drena `inHandler == 0` →
desarma → verifica. Se não drenar em 4 s → `DISARM_FAILED`, handler mantido.

### O que só o teste revelou: o handler **não pode** delegar

Três falhas reais, todas `0x80000004` (`SINGLE_STEP` sem tratamento):

1. **gate fechado antes do desarme** — devolver `CONTINUE_SEARCH` para uma
   exceção nossa com o DR ainda setado mata o processo. Corrigido: o gate
   controla **registro**, nunca consumo. Toda exceção nossa é consumida.
2. **TID invisível durante `arm_one`** — `arm_one` faz `ResumeThread`; a thread
   dispara antes de entrar em `g_armedTid`. Corrigido: TID entra na lista antes
   do DR.
3. **exceção em trânsito com `Dr6` já limpo** — ao limpar `Dr6.B<slot>` no
   desarme, uma exceção já despachada chega com o bit zerado e não era
   reconhecida. Corrigido: reconhecer por `ExceptionAddress` + slot, não por
   `Dr6`.

Custo declarado do item 3: se um terceiro armar breakpoint **exatamente** em
`g_targetVA`, consumimos a exceção dele sem registrar. Ninguém monitora o entry
de `Game::walk` na prática; delegar e derrubar o processo é pior.

### O VEH não é removido

`RemoveVectoredExceptionHandler` saiu do caminho de parada. Motivo medido: uma
exceção pode estar a caminho do kernel quando o drain termina. Remover o VEH
nesse instante recria a falha 3. Com `g_armed == 0` e gate fechado o VEH é
**inerte**: exceção que não é nossa → `CONTINUE_SEARCH`; exceção nossa residual
→ consumida e **não registrada**.

Consequência: `handlerRemoved: 1` no JSON significa **"handler inativo"**, não
"desregistrado". A DLL permanece carregada e o VEH registrado até o processo
sair. Isso é intencional e está no §7.

---

## 2. Limite de eventos — semântica precisa

`max_events` limita **registros**, não disparos. Contadores separados:

| campo | significado |
| :--- | :--- |
| `exceptionsObserved` | toda exceção nossa consumida pelo handler |
| `recordsAccepted` | quantas entraram no array |
| `recordsDiscarded` | observadas e não gravadas |
| `maxRecords` | teto de registros |
| `stopRequestedAtMs` | instante em que o buffer encheu |
| `disarmedAtMs` | instante em que o desarme terminou |
| `concurrentEntries` | vezes em que 2+ handlers rodaram ao mesmo tempo |
| `droppedWhileClosing` | exceções consumidas sem registro (gate fechado) |

Medição canônica do cenário `limit` (teto = 2):

```
exceptionsObserved : 3
recordsAccepted    : 3
recordsDiscarded   : 1
maxRecords         : 2
stopRequestedAtMs  : 169874593
disarmedAtMs       : 169874609     -> 16 ms de janela
stopReason         : 1 (EVENTS)
state              : disarmed
```

A corrida esperada: entre o pedido de parada e o desarme efetivo (16 ms aqui),
novas exceções continuam sendo consumidas e descartadas. **Não prometemos
"no máximo 5 disparos"** — prometemos no máximo `max_events` **registros**.

---

## 3. Seleção de threads — explícita

| config | comportamento |
| :--- | :--- |
| `threads=13520,18352` | arma **só** nessas; TID inexistente vai para `armFailed` |
| `threads=*` | arma em todas as threads do processo |
| **sem `threads=`** | **RECUSA** (`state=idle`, `reason=no_thread_selection`) |

Omissão não é autorização silenciosa. Testado nos dois sentidos no alvo:

```
config sem threads:  CALL_RETURNED PkaWalkTraceStart=0x0  (IDLE)
                     log: "config sem 'threads' e sem 'threads=*': RECUSA armar"
config threads=*:    CALL_RETURNED PkaWalkTraceStart=0x2  (ARMED)
                     log: "armado slot=0 ... threads ok=6 fail=0"
```

JSON reporta `coverageMode`:
- `explicit-list` — lista de TIDs
- `all-threads-explicit` — `threads=*`
- `none` — não armou

Threads que nascem ou morrem durante a janela: **não são armadas
retroativamente** (não há rearme). Morrer durante a janela é tratado como
`gone`, não como falha. Zero hits só é interpretável junto com
`armedCount`/`armedTids` do próprio JSON.

---

## 4. Resultados reais — processo auxiliar

80 execuções, 0 falhas (10 por cenário):

| cenário | falhas | observação |
| :--- | ---: | :--- |
| basic | 0/10 | detecta execução, TIDs corretos |
| negative | 0/10 | 0 eventos |
| occupied | 0/10 | slot 1, DR0 alheio preservado e ainda funcional |
| limit | 0/10 | parada por contagem, 16 ms até desarme |
| timeout | 0/10 | parada por tempo, 132 eventos |
| twice | 0/10 | `Stop()` 2× idempotente |
| partial | 0/10 | thread morre, desarme ainda limpo |
| residual | 0/10 | `events_before == events_after` após parar |

Antes das correções: `basic` falhava ~2/25, `timeout` 3/20, `occupied` 1/8.
Todas as três causas estão no §1.

### Caminho de injeção real (não só `LoadLibrary`)

```
DLL sha256     : B935DBE696AA9673AC71B6815042D5A7CE5DA0CBE8C810338D35D72D79E9C4E9
alvo           : walktrace_target.exe (mesmo RVA 0x1000 do alvo do jogo: entry da funcao)
LOADED base    : 0x7ff9b0830000 (64-bit, por enumeracao de modulo)
CALL_RETURNED  : PkaWalkTraceStart=0x2  (ARMED)
armedCount     : 6
exceptionsObserved : 6   recordsAccepted : 6   recordsDiscarded : 1
state          : disarmed   handlerRemoved : 1   disarmPendingCount : 0
target_exited  : False
```

Dois bugs do injetor apareceram aqui:
1. `GetExitCodeThread` devolve `DWORD` — a base x64 vinha truncada e o call caía
   em endereço inválido (`0xc0000005`). Corrigido enumerando módulos pelo nome.
2. `walktrace_inject.exe` é um arquivo **novo**, não uma alteração em
   `pka_inject.c` (componente compartilhado com a frente tap).

---

## 5. Configuração concreta para a tentativa no jogo

```
module=pokealliance_dx.exe
rva=780c90
max_events=5
max_seconds=60
threads=*
out=C:\Users\yago\Documents\Clone\RECONSTRUÇÃO OFICIAL\local-data\walktrace-game-<PID>.json
```

Por que `threads=*`: a lista de threads muda a cada sessão; fixar TIDs
históricos é escolher alvo por palpite. Cobertura total é medida e reportada em
`armedTids`.

---

## 6. Procedimento único (aguardando autorização)

```
:: 1. identificar instancia e build
node tools/trace_exec_context.cjs --pid <PID> --verify-ranges ^
  --ranges botfinal/config/ranges/pokealliance-2026-11-07.json

:: 2. conferir que nenhuma DLL nossa esta carregada
::    (o verify acima lista os modulos; qualquer pka_*/walktrace* -> ABORTAR)

:: 3. escrever a config do §5 com o PID real no caminho de saida

:: 4. injetar UMA vez
native\walktrace_inject.exe --pid <PID> ^
  --dll "C:\Users\yago\Documents\Clone\RECONSTRUÇÃO OFICIAL\native\pka_walktrace.dll" ^
  --call PkaWalkTraceStart
```

Interpretar só `CALL_RETURNED`:
- `0x2` = ARMED
- `0x0` = recusou (ver `%TEMP%\pka_walktrace_boot.log`)
- `0x5` = `DISARM_FAILED`

Se `0x2`: aviso ARMED, janela aberta, **um** toque breve de seta. Encerra por 5
eventos ou 60 s.

Depois:

```
native\walktrace_inject.exe --pid <PID> --dll <mesma> --call PkaWalkTraceState
```
`4 = disarmed`, `5 = disarm_failed`.

---

## 7. A DLL fica carregada

**Desarmado ≠ descarregado.** Após a coleta, `pka_walktrace.dll` **permanece**
no processo e o VEH fica registrado (inerte). Consequências:

- `pka_native.dll` **não** deve ser injetada na mesma sessão sem reiniciar
  (regra de convivência do `AGENTS.md`).
- Para usar nosso bot naquela sessão: **fechar o cliente e reabrir**.
- Não há `FreeLibrary`; não há como descarregar com segurança enquanto o VEH
  puder receber callback.

---

## 8. Interpretação por evento

Campos por evento: `i, tickMs, tid, rip, rva, dr6, dr7, rdx, r8, rcx`.

| campo | leitura permitida |
| :--- | :--- |
| `tid` | qual thread alcançou o entry |
| `tickMs` | instante (ms, GetTickCount64) |
| `rip` / `rva` | endereço exato; `rva` deve ser `0x780c90` |
| `rdx` | `edx` = direção (0..7) |
| `r8` | `r8b` = flag |
| `rcx` | **valor bruto do chamador**. O entry sobrescreve `rcx`; **não** é objeto. Não interpretar como ponteiro |

Hit na entrada prova **alcance da função naquela thread**. Não prova epílogo,
efeito no jogo, scheduler, thread safety, independência de foco ou background.

Zero hits com `armedCount > 0` e 0 falhas: **inconclusivo**, e só interpretável
junto com a cobertura registrada.

---

## 9. Pendente

- Teste B (motor sem overshoot), executor nativo próprio, background,
  minimizado — **pendentes de validação com cliente real + nosso bot**.
- `pendingStep` intacto (`2887A1E7...86864`).
- `native-step.cjs` **não** integrado ao walker.
- Identidade de `[0x39cb958]` como `LocalPlayer` continua não provada.
