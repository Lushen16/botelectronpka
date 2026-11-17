# Tracer de `Game::walk` — contrato final

Data: 2026-11-07
Estado: **implementado e validado em processo auxiliar. Nada injetado no jogo.**

DLL: `native/pka_walktrace.dll`
sha256: `A8AB422646DA80001291DE0FB8865B81AA9C1ADEEEA733D3BBC5EB29D626110C`

---

## 1. Contrato de estado (campos do JSON)

Cada conceito tem seu próprio campo. `handlerRemoved` **não existe mais** — ele
misturava "não registrado" com "inativo".

| campo | 0 | 1 |
| :--- | :--- | :--- |
| `handlerRegistered` | VEH não instalado | VEH instalado no processo |
| `recordingEnabled` | gate aceita nada | gate grava eventos |
| `armedThreads` | — (é contagem) | threads armadas **no início** |
| `armedThreadsLive` | — (contagem) | threads com DR nosso **agora** |
| `disarmVerified` | desarme não confirmado | DR7 relido: slot livre em todas |

Ciclo observado (canônico `limit`):

```
state              disarmed
handlerRegistered  1     <- permanece 1; o VEH nao e' removido
recordingEnabled   0     <- desligado no Stop
armedThreads       3     <- snapshot do inicio
armedThreadsLive   0     <- nada armado agora
disarmVerified     1     <- verificado, nao presumido
```

Após armamento parcial com rollback, `disarmVerified=1` e `armedThreads=0`
(nada ficou armado). Após `DISARM_FAILED`, `disarmVerified=0`,
`armedThreads` mantém o snapshot e `disarmPending[]` traz `tid/err/stage`.

---

## 2. Regra de reconhecimento após o desarme

O handler exige **quatro** condições:

1. `ExceptionCode == EXCEPTION_SINGLE_STEP`
2. `ExceptionAddress == g_targetVA`
3. `GetCurrentThreadId()` pertence ao conjunto nosso — **armado agora** ou
   **em trânsito dentro da janela**
4. `hitStamp > 0` (carimbo de diagnóstico)

`Dr6` **não** é critério. Motivo medido: ao limpar `Dr6.B<slot>` no desarme,
uma exceção já levantada chega com o bit zerado; exigi-lo fazia reconhecer
falhar e devolver `CONTINUE_SEARCH` com o nosso endereço → `0x80000004`
(~1 em 20 no `timeout`).

### A janela de trânsito — e por que ela termina

Uma exceção nossa em trânsito precisa ser consumida, senão o processo cai.
Mas tratar o endereço antigo como nosso para sempre sequestraria terceiros.

```
desarme bem-sucedido:
  g_armedCount = 0                       <- lista viva esvaziada
  g_transitTid[] = lista antiga
  g_transitUntilMs = agora + 50 ms       <- prazo
```

- **Dentro da janela:** a thread antiga ainda é reconhecida → exceção em
  trânsito consumida. `recordingEnabled=0`, então nada é gravado.
- **Fora da janela:** `tid_is_ours()` retorna 0 para todas → `CONTINUE_SEARCH`.
  O VEH residual é **inerte**, mesmo que o endereço e o slot coincidam com os
  históricos.

50 ms: a exceção percorre hardware→VEH em microssegundos; 50 ms é ~3 ordens de
grandeza de folga e curto o bastante para não sequestrar um breakpoint de
terceiro aberto logo depois.

### Prova (cenário `foreign_after_stop`)

O "terceiro" arma `DR0` — **o mesmo slot que usamos** — exatamente em
`&target_function` — **o mesmo endereço histórico** — **depois** do nosso Stop,
e registra o próprio VEH depois do nosso na cadeia.

```
ALIEN_AFTER_STOP armed=1 addr=0x7ff61f1b1000 slot=0 veh=1
ALIEN_AFTER_STOP foreign_hits=6 tracer_events_before=3 tracer_events_after=3 state_before=4 state_after=4
ALIEN_AFTER_STOP verdict_fired=YES tracer_unchanged=YES
```

6 disparos recebidos pelo VEH do terceiro; nossos contadores e estado
inalterados. **O VEH residual não consome SINGLE_STEP de terceiro.**

---

## 3. Contadores e a relação que fecha

| campo | definição |
| :--- | :--- |
| `exceptionsObserved` | exceções **nossas** consumidas pelo handler |
| `recordsAccepted` | entradas efetivamente gravadas em `g_events[]` |
| `recordsDiscarded` | `observed − accepted` (derivado, não contado à parte) |
| `maxRecords` | teto de **registros** |
| `droppedWhileClosing` | consumidas com gate fechado (transição), não gravadas |
| `concurrentEntries` | vezes com 2+ handlers simultâneos |

**Invariante:** `exceptionsObserved == recordsAccepted + recordsDiscarded`
e `recordsAccepted ≤ maxRecords`.

Exemplo canônico (`limit`, teto 2):

```
exceptionsObserved  3
recordsAccepted     2     <- 2 = maxRecords
recordsDiscarded    1
3 == 2 + 1                 OK
```

Antes da correção, `limit` saía `accepted=3 > max=2` porque `g_recorded`
contava tentativas, não gravações. `accepted` agora só incrementa quando a
entrada realmente entra no buffer (reserva atômica por CAS).

Corrida esperada durante a parada, medida: **16 ms** entre
`stopRequestedAtMs` e `disarmedAtMs`. Nesse intervalo novas exceções são
consumidas e descartadas. Não prometemos "no máximo N disparos".

---

## 4. Alcance de `threads=*`

**Snapshot inicial, não acompanhamento.** Threads criadas depois do `Start`
**não** são armadas. Não há thread de rearme.

| config | comportamento |
| :--- | :--- |
| `threads=13520,18352` | só essas |
| `threads=*` | todas no snapshot inicial |
| sem `threads=` | **RECUSA** (`state=idle`) |

Campos de cobertura no JSON:

```json
"coverage": { "snapshot": 5, "armed": 5, "refused": 0,
              "goneBeforeArm": 0, "lateThreadsArmed": 0 }
```

- `snapshot` — threads vistas no início
- `armed` — armadas com sucesso
- `refused` — snapshot menos armadas (falha real de armamento)
- `goneBeforeArm` — desapareceram entre o snapshot e o armamento (não é falha)
- `lateThreadsArmed` — sempre 0; documenta que não há acompanhamento

**Cobertura parcial não vira sucesso total.** Se `armed < snapshot`, o JSON
diz isso e `armFailed[]` lista `tid/err`. Zero hits com `armed < snapshot` é
**inconclusivo por cobertura**, não negativo.

Prova (`late_thread`): thread criada **depois** do Start, TID `28540`:

```
covered: snapshot=5 armed=5 refused=0 goneBeforeArm=0 lateThreadsArmed=0
armedTidsAtStart = 15548,6412,19816,11108,30364   <- 28540 ausente
```

---

## 5. Resultados reais

80 execuções, **0 falhas** (8 por cenário):

| cenário | falhas | prova |
| :--- | ---: | :--- |
| basic | 0/8 | detecta execução e identifica thread |
| negative | 0/8 | 0 eventos |
| occupied | 0/8 | usa slot 1; DR0 alheio preservado e ainda funcional |
| limit | 0/8 | para por contagem; 16 ms até desarme |
| timeout | 0/8 | para por tempo; 132 eventos |
| twice | 0/8 | Stop 2× idempotente |
| partial | 0/8 | thread morre; desarme ainda limpo |
| residual | 0/8 | sem evento residual após parar |
| **foreign_after_stop** | 0/8 | **exceção alheia pós-Stop no mesmo addr/slot** |
| **late_thread** | 0/8 | **thread tardia não é armada** |

### Caminho de injeção real

```
DLL sha256    A8AB422646DA80001291DE0FB8865B81AA9C1ADEEEA733D3BBC5EB29D626110C
LOADED base   0x7ff9b0830000 (64-bit, por enumeração de módulo)
CALL_RETURNED PkaWalkTraceStart=0x2 (ARMED)
state         disarmed   disarmVerified 1   armedThreads 6   live 0
observed 6   accepted 5   discarded 1   max 5
coverage      snapshot 6, armed 6, refused 0, goneBeforeArm 0
target_exited False
```

---

## 6. Bugs encontrados e corrigidos nesta rodada

1. **Índice `-1` no buffer** (introduzido por mim ao corrigir os contadores):
   `g_events[slotIdx - 1]` com `slotIdx=0` → `0xC0000005` na primeira gravação.
   Corrigido: `slotIdx` é índice 0-based; o ordinal é `slotIdx + 1`.
2. **`armedThreads` virava 0 no relatório**: o campo lia `g_armedCount`, que o
   desarme zera de propósito. Separado em `armedThreads` (snapshot) e
   `armedThreadsLive` (agora).
3. **`recordsAccepted` podia exceder `maxRecords`**: contava tentativa em vez de
   gravação. Reserva por CAS; `recordsDiscarded` passou a ser derivado.
4. **`late_thread` usava lista explícita**: não testava o alcance de `threads=*`.
   Agora escreve `threads=*`.

---

## 7. Configuração final para a coleta no jogo

```
module=pokealliance_dx.exe
rva=780c90
max_events=5
max_seconds=60
threads=*
out=C:\Users\yago\Documents\Clone\RECONSTRUÇÃO OFICIAL\local-data\walktrace-game-<PID>.json
```

Procedimento (uma tentativa, aguardando autorização):

```
:: 1. identidade + build (recusa se divergir)
node tools/trace_exec_context.cjs --pid <PID> --verify-ranges ^
  --ranges botfinal/config/ranges/pokealliance-2026-11-07.json

:: 2. injetar UMA vez
native\walktrace_inject.exe --pid <PID> ^
  --dll "C:\...\native\pka_walktrace.dll" --call PkaWalkTraceStart
```

`CALL_RETURNED`: `0x2`=ARMED, `0x0`=recusou (ver `%TEMP%\pka_walktrace_boot.log`),
`0x5`=DISARM_FAILED.

Depois do resultado: `--call PkaWalkTraceState` (`4`=disarmed, `5`=failed).

A DLL **fica carregada** e o VEH registrado (inerte). Para usar nosso bot nessa
sessão: fechar e reabrir o cliente.

---

## 8. Limites

- Evento na entrada prova **alcance da função naquela thread**. Não prova
  epílogo, efeito no jogo, scheduler, thread safety, foco ou background.
- `rcx` é valor bruto do chamador e o entry o sobrescreve: **não** é objeto.
- Zero hits com cobertura válida é inconclusivo.
- `pendingStep` intacto; `native-step.cjs` não integrado ao walker.
- Teste B, executor nativo, background e minimizado seguem pendentes de
  validação com cliente real + nosso bot.
