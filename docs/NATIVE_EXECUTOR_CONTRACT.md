# Executor nativo: premissas corrigidas, agendamento e contrato

Data: 2026-11-06. Somente leitura passiva. Zero hook, injeção, movimento ou foco.

Sessão: **PID 11596**, `PokeAlliance - Usobot`, base `0x7ff73fc00000`.

---

## 1. Premissas corrigidas (obrigatório)

| # | premissa anterior | correção | base |
| :-- | :--- | :--- | :--- |
| 1 | "`pendingStep` valida transitabilidade" | **Falso.** `pendingStep` controla *despachos pendentes*. Não valida se o tile é andável, nem substitui `0x776000`, nem demonstra equivalência ao throttle nativo. São mecanismos diferentes com papéis diferentes. | código do motor |
| 2 | "`Game::walk` não deixa efeitos persistentes" | **Falso.** O epílogo substitui o par `shared_ptr<Tile>` em `LocalPlayer+0x9a8/+0x9b0` e mexe em `+0xbe8/+0xbf0` em `0x7b47c0`. Há estado observável depois da chamada. | `0x77f6d6`, `0x7b47a5` |
| 3 | "efeito de uma chamada própria está provado" | **Não está.** Nunca chamamos `Game::walk` do nosso lado. O que existe é leitura estática e um teste A de *teclado em foreground*. | — |

**Nota sobre o throttle:** `pendingStep` e `[this+0xbf8]` são independentes. O
primeiro é nosso, controla reconciliação por amostra. O segundo é do cliente,
protege contra passo em cima de passo e **só é escrito pelo wrapper
`0x7b4740`**. Chamando `Game::walk` direto, `+0xbf8` não é atualizado — então a
proteção nativa **não está em vigor** do nosso lado. Isso não é equivalência:
é ausência de proteção que `pendingStep` precisa cobrir.

---

## 2. Evidência nova do agendamento

### 2.1 O objeto capturado pela lambda: CONFIRMADO

RTTI da vtable em `0x1fae340`:

```
.?AV?$_Func_impl_no_alloc@V<lambda_1>@?1??startAutoWalkLoop@LocalPlayer@@IEAAXXZ@
```

O lambda captura `shared_ptr<LocalPlayer>` — os slots `0x996b80`/`0x996bc0`
copiam `[rcx+8]`/`[rcx+0x10]` e incrementam `[rax+0xc]` (refcount de
`shared_ptr`). `0x996b10` obtém o `LocalPlayer` via `0x341050` e chama
`0x7b4a50` ou `0x7b4740`.

**Isto é `LocalPlayer`, não `Game`.** A RTTI confirma a classe; a instância
continua não provada (seção 3).

### 2.2 Quem instala e quem cancela: mapa completo

```
callers de 0x7b47c0 (startAutoWalkLoop):  1  ->  0x7b6f05
callers de 0x7b4a50 (stopAutoWalk):       3  ->  0x77df04, 0x7b6f0c, 0x996b4d
callers de 0x7b6ed0 (setWalkActive):      1  ->  0x7e1f71
```

Leitura:

- `0x7b6f05` está **dentro de `0x7b6ed0`** — o wrapper instala o loop na
  primeira ativação.
- `0x996b4d` é o **tick do loop** — para quando `[+0xcf6]==0`.
- `0x77df04` é **teardown externo**: lê `[rdi+0x2508]` (o `LocalPlayer`),
  testa `[rbx+0xcf6]`, zera e chama `stopAutoWalk`. É a limpeza ao sair do
  mundo.

### 2.3 O scheduler: NÃO localizado

Procurei as strings e símbolos do componente:

| símbolo | resultado |
| :--- | :--- |
| `addEvent` | não encontrado (só `addEventListener` de HTML — falso positivo) |
| `cancelEvent` | não encontrado |
| `processEvents` | não encontrado |
| `ScheduledEvent` | **presente** (RTTI em `0x22ad766`) |
| `scheduler` | **presente** (`0x201dd58`) — mas em bloco de strings do `boost::asio` (`io_locking`, `reactor`, `thread.entry_event`) |

`scheduler` ali é o **scheduler do Asio**, não o dispatcher de eventos do jogo.
`std::ScheduledEvent` existe, mas não achei quem o consome nem quem registra o
`std::function` do loop nele.

**A varredura por `[reg+0xbe8]` deu 118 ocorrências**, quase todas em código que
usa `+0xbe8/+0xbf8` como **buffer de bits** (padrão `shr rax,3 / and ecx,7 /
shl / shr`). São outros objetos, não o `LocalPlayer`.

### 2.4 O que isso significa

Não tenho o mecanismo de agendamento. Mas tenho algo mais útil para o nosso
caso: **`Game::walk` não precisa de scheduler**.

---

## 3. Identidade e vida dos objetos

Medido agora, com o jogo no mundo:

```
[0x39c7268] LocalPlayer = 0x1f16b43d020
  [+0x164] = 320            (sessão válida)
  [+0xbe8] = 0              (loop INATIVO)
  [+0xcf6] = 0              (sem caminhada ativa)
  [+0xb4]  = 0              (sem direção)
  [+0xbf8] = 0              (throttle zerado)
```

**`+0xbe8 == 0` não invalida a sessão** — apenas indica que não há caminhada
contínua ativa. O `+0x164 != 0` é o indicador de sessão viva.

**Instância do loop vs global: não confirmado.** A lambda captura um
`shared_ptr<LocalPlayer>`, mas não abri a captura para comparar com
`[0x39c7268]`. Isso só é possível com o loop **ativo**, o que exigiria iniciar
caminhada — fora do escopo desta rodada.

Busca por objeto com `[+0x2508]==LocalPlayer`: 64 ponteiros coincidentes no
heap, **nenhum com vtable válida**. O `-0x2508` era coincidência aritmética,
não o `Game`. Descartado.

---

## 4. Decisão: agendamento é irrelevante para `Game::walk`

### 4.1 Primitivas de sincronização no corpo

| função | `lock` (f0) | `call [rip+x]` (IAT) |
| :--- | :--- | :--- |
| `Game::walk` (`0x77f250..0x77f844`) | **4** | 9 |
| `0x776000` (validador de tile) | **0** | — |
| `0x7b4740` (wrapper) | **0** | — |

Os 4 `lock` no `Game::walk` estão em `+0x29`, `+0x4e6`, `+0x51b`, `+0x541` —
todos no padrão `lock inc dword [rcx+8]`, que é **refcount de `shared_ptr`**.
**Não há `EnterCriticalSection`**.

### 4.2 O que isso muda

`Game::walk` **não é thread-safe por design**. Ele manipula `shared_ptr` de
forma atômica (seguro para o refcount), mas a troca do **par** em
`+0x9a8/+0x9b0` não é atômica como conjunto:

```
0x77f7a5  mov rax, [r8+0x9a8]     ; lê antigo
0x77f7b0  mov [r8+0x9a8], rcx     ; escreve novo
0x77f7b7  mov rcx, [r8+0x9b0]     ; lê antigo
0x77f7c2  mov [r8+0x9b0], rdx     ; escreve novo
```

Se outra thread do jogo estiver lendo esse par no meio (por exemplo o tick de
render ou o próprio autowalk), há janela de corrida.

**Consequência prática:** chamar `Game::walk` da thread do pipe **não é seguro**
sem mais evidência. Não porque falta scheduler, mas porque o objeto tem estado
compartilhado sem sincronização de escrita.

---

## 5. Contrato mínimo proposto

Válido para **qualquer** mecanismo de execução que escolhermos depois.

### 5.1 Estados explícitos (separados, nunca colapsados)

```
IDLE
  -> ACCEPTED    : comando recebido, validado contra sessão
  -> SCHEDULED   : entregue ao mecanismo de execução
  -> EXECUTING   : execução INICIADA (ponto de não-retorno, com claim)
  -> EXECUTED    : o mecanismo confirmou que rodou (não é efeito)
  -> OBSERVED    : telemetria nova mostra o deslocamento
  -> FAILED      : qualquer etapa falhou, com motivo

ACCEPTED/SCHEDULED -> CANCELLED : só antes de EXECUTING
SCHEDULED/EXECUTING/EXECUTED -> UNKNOWN : resultado incerto, sem retry
```

`EXECUTING` existe por um motivo específico: sem ele, `cancel()` respondia
`cancelled` com a chamada nativa já em curso. `beginExecution()` é a última
chamada antes de invocar o mecanismo e devolve um `claim` monotônico que
`markExecuted()`/`markUnknown()` precisam apresentar. Claim velho é recusado —
a conclusão de uma execução antiga não ressuscita um passo novo.

### 5.2 Regras

| regra | implementação |
| :--- | :--- |
| no máximo **um** comando pendente | `pendingStep` já garante; `UNKNOWN` também ocupa o slot |
| identificação de sessão | `(pid, boot, playerId, entityId)` capturados no `ACCEPTED` |
| prazo de validade | `expiresAt` = agora + 2500 ms |
| descarte de expirado | em `schedule()` E em `beginExecution()`: `now > expiresAt` → `FAILED` |
| confirmação tardia | `markExecuted()` depois do TTL → `UNKNOWN`, nunca `EXECUTED` |
| descarte de sessão anterior | comparar `boot`/`playerId` antes de executar |
| cancelamento antes de executar | `CANCELLED` só em `ACCEPTED`/`SCHEDULED` |
| sem repetição após incerto | `EXECUTING`/`EXECUTED`/`UNKNOWN` → `retryAllowed === false`; exige `reset()` |
| recebido ≠ agendado ≠ executado ≠ efeito | os 5 são campos distintos |

### 5.3 O que o contrato NÃO promete

- cancelar movimento já aceito pelo cliente;
- que `Game::walk` retornou sucesso (tipo de retorno desconhecido);
- que ACK ou retorno equivalem a deslocamento.

---

## 6. Código preparatório

Implementei o contrato **no lado Node**, independente do mecanismo de
execução. Isso é verificável localmente e não toca no cliente.

`botfinal/core/native-step.cjs` — máquina de estados acima, com testes em
`botfinal/tests/native_step.test.cjs`.

O executor da DLL só será ligado depois que o contexto for resolvido.

---

## 7. Menor observação dinâmica necessária

**Pergunta:** qual thread executa o caminho de caminhada, e `Game::walk` da
thread do pipe corrompe estado?

**Ponto confirmado:** `0x7b4740..0x7b47b7` (120 B) e `0x77f250..0x77f844`
(1524 B, limites via `.pdata`).

**Mecanismo proposto AGORA (sem patch):** `tools/trace_exec_context.cjs`.
Amostragem de RIP por `SuspendThread`/`GetThreadContext`, sem escrever nada no
processo. O hook de 5 bytes só entra se a amostragem falhar comprovadamente.

### 7.0 Correção importante: o coletor anterior era um falso negativo

A rodada anterior relatou "8 faixas verificadas, 450 amostras, 0 hits em 3 s
sem movimento". Esse número **não provava nada**. Dois bugs:

1. A struct `CONTEXT` parava em `Rip` (~256 B). O kernel x64 escreve
   `sizeof(CONTEXT) = 1232` bytes; buffer menor faz `GetThreadContext` falhar
   **sempre**. Cada falha era contada como "amostra sem hit".
2. `CONTEXT` x64 exige alinhamento de 16 B. Uma `ctypes.Structure` comum entrega
   8 B. Mesma falha silenciosa, pelo outro lado.

Corrigido em `tools/trace_exec_context.cjs`: buffer de 1232 B alinhado em 16,
`contextFailures`/`suspendFailures` contados à parte, e `--self-test`, que roda
contra uma thread nativa própria (CreateThread → `Sleep`, não uma thread
CPython, para não segurar o GIL) e **precisa** retornar leitura + classificação
100%. Resultado: 50/50 leituras classificadas.

**Regra nova:** zero hits só é interpretável depois de `--self-test` verde e
`contextFailures === 0` no run.

### 7.1 Procedimento

```
node tools/trace_exec_context.cjs --self-test                    # prova o coletor
node tools/trace_exec_context.cjs --pid <PID> --verify-ranges    # build certo?
node tools/trace_exec_context.cjs --pid <PID> --run --seconds 60 # com seta apertada
```

O JSON agora traz `windowThreads` (threads donas de janela visível do processo),
para comparar direto com `summary[].tid`.

**O que cada resultado permite concluir:**

| resultado | conclusão |
| :--- | :--- |
| `selfTest.ok === false` | coletor quebrado; nada abaixo é interpretável |
| `contextFailures > 0` | INCONCLUSIVO, não "sem hit" |
| hit em `Game::walk` na thread == `windowThreads` | caminho roda no message loop |
| hit em `Game::walk` em thread diferente | há thread própria → precisa de fila |
| hit em `lambda-autowalk-tick` | é o loop contínuo, não o passo único |
| zero hits + 0 falhas + seta apertada | caminho não é esses RVAs, ou frame curto |
| zero hits sem seta | esperado; o teste não exercitou nada |

### 7.2 Hook de leitura (reserva, NÃO executar)

Só se 7.1 falhar com o personagem andando de verdade. Ponto: `0x7b4740`. 5
bytes + trampolim + `VirtualAlloc`, original salvo em memória, rollback
obrigatório, janela de um passo manual, até 5 eventos ou 60 s.

---

## 8. Próxima ação concreta no cliente

**Teste 1 — condição controlada (exige autorização):**

| item | valor |
| :--- | :--- |
| ferramenta | nosso botfinal + DLL `b293b2e7…` já carregada |
| ação | `--walk=<dir> --walk-steps=1`, um comando |
| origem/destino | exatamente 1 tile, z igual |
| registro | comando, horário, `pendingStep`, `commandLog` |
| confirmação | telemetria + `live_probe.py` independente |
| observação final | 3 s (3 atualizações de telemetria, ~25 ticks) |
| critério de aprovação | delta exato 1 tile, `z` intacto, mesma entidade, **zero despacho tardio** |

**Isso valida o executor de teclado atual**, não o nativo. É pré-requisito
separado.

**Teste 2 — executor nativo:** só após resolver a thread.

---

## 9. Pendências preservadas

| marco | estado |
| :--- | :--- |
| Motor sem overshoot no cliente (teste B) | **PENDENTE** |
| Executor nativo (`Game::walk`) | **NÃO IMPLEMENTADO** — bloqueio: thread/estado compartilhado |
| Teste A foreground | VALIDADO 19:10Z (sessão anterior) |
| `pendingStep` | intacto |

Testes locais não substituem validação no cliente.
