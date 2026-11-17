# Decisão de mecanismo — observação de `Game::walk`

Data: 2026-11-07
Estado: **revisão fechada. Nenhuma injeção. Nenhuma autorização pedida.**
DLL v4 (rotulos corrigidos): `810A87FFD1A31CA56C3877733CACA68CD00B46661F7EB2138C8DB55DCD72318B`

Este documento substitui as alegações de garantia de `WALKTRACE_TRANSITO.md`.

---

## 1. Reclassificação da garantia

### 1.1 Comportamento observado

| observação | número |
| :--- | :--- |
| exceções com `Dr6.B0==1` no entry, **sem** escritor concorrente | **909 955 / 909 955** |
| exceções com `Dr6.B0==0` no entry, **com** escritor concorrente | **803 / 25 138** |
| `Dr0` no entry == alvo, L0 ligado | 12 235 |
| `Dr0` no entry == 0 (levantada antes da limpeza) | 115 |
| classificações ambíguas por `Dr0` | **0** |
| `gateChecks` no desarme (gate executou) | > 0 em todas |
| `pendingDbSeen` (havia `#DB` pendente) | **0 em todas as execuções** |

### 1.2 Hipótese sobre a entrega de exceções pelo Windows

**H1 (sustentada pelos números acima):** `Dr6.B<n>` é setado pelo hardware no
momento do `#DB` e permanece setado até alguém escrevê-lo. Na ausência de
escritor concorrente, toda entrada no VEH vê o bit. Os 803 casos anteriores
foram causados pelo **meu próprio harness**, que chamava `SetThreadContext`
concorrentemente — não pelo kernel zerando o bit.

**H2 (não sustentada):** "com a thread suspensa, `Dr6.B<slot>==0` prova que não
há exceção pendente." Não encontrei documentação primária que afirme isso.
`GetThreadContext`/`SuspendThread`/`CONTEXT` documentam o que são, não a
semântica de `Dr6` em relação a exceções em trânsito.

### 1.3 Garantia documentada — **nenhuma**

Fontes consultadas:

| fonte | o que documenta | cobre a garantia? |
| :--- | :--- | :--- |
| [CONTEXT (x64)](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-context) | layout dos campos `Dr0..Dr7` | **não** — só o layout |
| [GetThreadContext](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getthreadcontext) | "You cannot get a valid context for a running thread. Use SuspendThread" | **não** — nada sobre `Dr6`/exceções |
| [SuspendThread](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-suspendthread) | suspende execução de código user-mode; contador | **não** — nada sobre exceções pendentes |
| [SEH (visão geral)](https://learn.microsoft.com/en-us/windows/win32/debug/structured-exception-handling) | existência de exceções de hardware/software | **não** — nada sobre `Dr6` |

**Conclusão: a garantia "`Dr6.B<slot>==0` com thread suspensa prova ausência de
exceção pendente" NÃO ESTÁ DOCUMENTADA.** É hipótese derivada de comportamento
observado, não garantia contratual da plataforma.

### 1.4 Caminho não exercitado

`pendingDbSeen == 0` em **todas** as execuções. Tentei produzir a condição
escrevendo `Dr6.B0` via `SetThreadContext` com `L0` ligado; o kernel não
preservou o bit. Portanto:

- o ramo "havia `#DB` pendente → retomar a thread → tentar de novo"
  **nunca executou**;
- `gateChecks > 0` prova que a checagem roda, **não** que ela é suficiente;
- 70 execuções sem falha **não cobrem** esse ramo.

---

## 2. A contradição experimental — resolvida

**Antes:** 803/25 138 entradas com B0 zerado.
**Depois:** 909 955/909 955 com B0 setado.

A diferença não é "thread suspensa". É **quem escreve `Dr6` durante a janela**:

```
harness antigo:  thread A dispara -> kernel seta B0 -> VEH lê B0
                 thread B (harness) chama SetThreadContext(Dr6 &= ~B0)
                 se B vence a corrida, A lê B0 == 0
                 => 803 casos

harness novo:    thread A dispara -> kernel seta B0 -> VEH lê B0 -> limpa
                 nenhum outro escritor
                 => 0 casos em 909 955
```

Relação entre os três estados, explicitada:

| estado | onde vive | quem escreve |
| :--- | :--- | :--- |
| contexto salvo | bloco de thread do kernel, lido por `GetThreadContext` | `SetThreadContext`, e o kernel no switch-in |
| exceção em trânsito | fila de exceção do kernel, **não** no contexto salvo | kernel |
| entrada no VEH | thread já executando o handler | — |

`Dr6` no contexto salvo é escrito pelo kernel **no levantamento do `#DB`**, não
na entrega. Se ninguém sobrescrever, ele sobrevive à entrega. Era eu que
sobrescrevia.

**Isso não prova H2.** Prova H1 (Dr6 é estável sem escritor). Que
`Dr6.B==0` implique "nada pendente no kernel" continua sendo inferência não
documentada: uma exceção levantada mas ainda não refletida no contexto salvo
seria indistinguível de ausência.

---

## 3. Nomes corrigidos

| nome anterior | nome correto | motivo |
| :--- | :--- | :--- |
| `transit_delayed` = "drenagem determinística" | **`disarm_state_check`** | o teste verificou estado de DR antes/depois; **não** produziu exceção pendente |
| `verdict=DISARMED_DETERMINISTIC` | **`DISARMED_STATE_VERIFIED`** | "determinístico" afirmava garantia não demonstrada |
| `gateChecks>0` = "gate comprovado" | **`gate executou`** | execução ≠ suficiência |
| `70 execuções sem falha` = "cobertura" | **`70 execuções no ramo exercitado`** | o ramo pendente nunca rodou |
| `attribution: "dr0-held"` | **`"dr0-at-entry"`** | `Dr0` não é "retido" após o desarme; é lido no entry |

---

## 4. Ambiguidade de propriedade — fato estabelecido

`reuse_inside`: terceiro armou **o mesmo slot** para **o mesmo endereço**;
o tracer consumiu 79 eventos, o VEH alheio recebeu 0.

`diag_perthread.c` prova que debug registers são **por thread**:

```
thread1 dr0=0x7ff601f01000 L0=1
thread2 set=1 err=0
thread2 after: dr0=0x7ff601f01000 L0=1   <- mesmo slot, mesmo endereco, OK
```

**Conclusão:** `slot+endereço` **não identificam proprietário**. Não existe bit
de dono no contexto da exceção. Duas entidades podem armar o mesmo slot para o
mesmo alvo em threads diferentes, e o `CONTEXT` entregue é indistinguível.

**Não declaro preservação geral de terceiros.** O que existe é: não mexemos em
slots cujo `Dr_n` não seja o nosso alvo (verificado por `reuse_after`,
`err=170 ERROR_BUSY`). Preservação de terceiro **no mesmo slot e endereço** é
impossível por construção.

---

## 5. Decisão de mecanismo

### Opção A — manter o tracer com exclusividade imposta

Impor exclusividade significaria: recusar armar se qualquer thread já tiver o
slot ocupado; rejeitar se `Dr_n` mudar sob nós; e **declarar que não há
proteção alguma** se outra entidade usar o mesmo slot/endereço.

- Exclusividade é **verificável por thread** (`slot_is_free`), não por processo.
- Não há como detectar um terceiro que arme o mesmo slot depois de nós, na
  mesma thread — ele sobrescreve.
- Custo: injeção de DLL, VEH residual, estado de debug por thread.

### Opção B — depurador externo com fluxo de eventos

`DebugActiveProcess` + `WaitForDebugEvent` + `ContinueDebugEvent`.

Documentado primariamente:

- [DebugActiveProcess](https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-debugactiveprocess):
  "The system **suspends all threads** in the process, and sends the debugger
  events"; exige `PROCESS_ALL_ACCESS`.
- [WaitForDebugEvent](https://learn.microsoft.com/en-us/windows/win32/api/debugapi/nf-debugapi-waitfordebugevent):
  "**Only the thread that created the process being debugged** can call
  WaitForDebugEvent"; eventos chegam em fila, com `ContinueDebugEvent`.

| critério | tracer (A) | depurador (B) |
| :--- | :--- | :--- |
| exclusividade | por thread, não global | **exclusiva por processo** — o SO garante um único depurador |
| identificação do evento | inferida de `Dr0`/`Dr6` | **explícita**: `DEBUG_EVENT` traz `dwThreadId` e `EXCEPTION_DEBUG_INFO` |
| exceção em trânsito | precisa de hipótese não documentada | **não existe o problema**: o SO suspende tudo e enfileira |
| encerramento | VEH não removível com segurança | `DebugActiveProcessStop` documentado |
| impacto no cliente | DLL carregada + VEH permanente | processo depurador externo; **nenhuma DLL no jogo** |
| compatibilidade | VEH residual pode conflitar | **exclusivo**: impede depurador concorrente por design |
| autorização | injetar DLL | anexar depurador (`SE_DEBUG_NAME` ou mesmo usuário) |

**Nota crítica sobre B:** `DebugActiveProcess` mata o processo se o depurador
sair sem `DebugSetProcessKillOnExit(FALSE)`. É um risco operacional novo e
concreto — mais sério que o VEH residual de A.

### Recomendação: **B**, com ressalva de risco

Motivo: o problema central desta revisão é **atribuição de origem**. Em B ela
é explícita e documentada (`DEBUG_EVENT.dwThreadId` +
`EXCEPTION_DEBUG_INFO`), enquanto em A ela depende de uma inferência sobre
`Dr6` que **não consegui documentar** e cujo ramo crítico **nunca foi
exercitado**.

O `#DB` de um único endereço com `EXCEPTION_DEBUG_EVENT` e
`ContinueDebugEvent(DBG_CONTINUE)` dá exatamente o dado necessário — TID,
RIP, registradores — sem DLL no cliente e sem VEH permanente.

**Ressalva que exige aceitação explícita:** se o depurador morrer sem
`KillOnExit(FALSE)`, o cliente fecha. Isso é pior que "talvez uma thread
suspensa". Não executo nem anexo nada nesta rodada.

### Se A for preferida

Fundamentação que falta, e os limites exatos:

1. Aceitar que `Dr6.B==0` é **indício**, não prova — e que o ramo
   "exceção pendente" não foi exercitado.
2. Aceitar que dois entes no mesmo slot+endereço são inseparáveis.
3. Manter `transit` removido e o gate de pendência como **mitigação**, não
   garantia.
4. Declarar no JSON `attribution: "dr0-at-entry"` e
   `guarantee: "observed-not-documented"`.

---

## 6. Próxima coleta concreta

**Nenhuma** das duas sem sua decisão:

- **B (recomendado):** escrever um host de depuração externo (~150 linhas),
  deixar o cliente rodar sozinho, anexar, armar um único `#DB` em
  `base+0x780c90` via `SetThreadContext` (agora com contexto válido porque a
  thread está suspensa pelo depurador), capturar `EXCEPTION_DEBUG_EVENT`,
  `ContinueDebugEvent(DBG_CONTINUE)`, `DebugActiveProcessStop`,
  `DebugSetProcessKillOnExit(FALSE)`. Valida em `walktrace_target.exe` antes.
- **A (se insistir):** rodar a coleta de 5 s sabendo que
  `pendingDbSeen` provavelmente será 0 e que a atribuição vem de `Dr0` — com a
  garantia reclassificada como observada, não documentada.

---

## 7. Riscos residuais que dependem de aceitação

| risco | mecanismo | gravidade |
| :--- | :--- | :--- |
| thread suspensa se o coletor morrer | A | média — fecha o cliente |
| VEH residual permanente até o processo sair | A | baixa — inerte, mas impede reload limpo |
| ambiguidade com terceiro no mesmo slot/endereço | A | declarada, não resolvida |
| garantia de `Dr6` não documentada | A | epistemológica |
| cliente fecha se o depurador morrer sem `KillOnExit(FALSE)` | B | **alta** |
| exige `PROCESS_ALL_ACCESS` | B | média — pode falhar por permissão |
| um único depurador por processo | B | restrição, não risco |

---

## 8. O que permanece intocado

- `pendingStep` (`2887A1E7…86864`), `native-step.cjs` fora do walker, 20/20
- Teste B, executor nativo próprio, background, minimizado — pendentes
- Identidade de `[0x39cb958]` como `LocalPlayer` — não provada
- Nenhum componente novo do bot criado nesta rodada

