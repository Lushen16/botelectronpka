# Proposta B — observação dirigida de `Game::walk` (revisão 2)

Data: 2026-11-07
Estado: **aguardando autorização. Nada foi injetado, armado ou escrito no jogo.**
Alvo do teste: build `48C41BD4…` (PID 24800 na rodada de referência).

Substitui a rev-1 em três pontos que estavam errados ou incompletos:

1. `RCX` **não** é `LocalPlayer` — ver §1.
2. Os globais foram resolvidos por **desmontagem da build atual**, não por delta — §2.
3. Não existe caminho de desarme na DLL existente; a proposta agora depende de
   um desarme que ainda não foi escrito — §5.

---

## 1. Correção: `RCX` não é o objeto de sessão

`docs/WALK_CALLER_CONTEXT.md` já registrava, e a desmontagem da build atual
confirma:

```
0x780cb6  movzx r14d, r8b      ; r8b  = flag
0x780cba  movsxd rdi, edx      ; edx  = direção
```

O prólogo consome **`edx` e `r8b`**. `rcx` não é lido no entry. Em
`0x780d02` ele é **sobrescrito** com o global `0x39cb998`. Ou seja: qualquer
coisa que o chamador passe em `rcx` é descartada.

Consequência para a proposta: **não registrar `[RCX+0x9a8/+0x9b0]`.** Seria
ler lixo do chamador. Os offsets `+0x9a8/+0x9b0` pertencem ao objeto de sessão,
que é alcançado pelo **global**, não pelo argumento.

### Provado por desmontagem, não por raciocínio

O epílogo que escreve o par faz:

```
0x781192  mov r8, qword ptr [rip + 0x324a7bf]   ; r8 = [0x39cb958]  (GLOBAL)
0x7811e5  mov rax, qword ptr [r8 + 0x9a8]
0x7811f0  mov qword ptr [r8 + 0x9a8], rcx
0x7811f7  mov rcx, qword ptr [r8 + 0x9b0]
0x781202  mov qword ptr [r8 + 0x9b0], rdx
```

`rip + 0x324a7bf` resolve para RVA `0x39cb958`. O `r8` do epílogo vem do
global, não do `rcx` de entrada. Registro correto, portanto, é
`[ [0x39cb958] + 0x9a8 ]`, com o ponteiro lido no instante do evento.

Leitura atual desse objeto (jogo no mundo):

```
[0x39cb958] = 0x22a7ed87100
  [+0xb0]  byte > 0        (gate passou)
  [+0x9a8] = 0x22a2ba4f190
  [+0x9b0] = 0x22a2ba4f180
```

Se esses dois mudarem no evento, o epílogo rodou. Se o ponteiro do global mudar
durante a chamada, a hipótese de identidade precisa ser revista.

---

## 2. Globais resolvidos na build atual (por desmontagem)

Todos por `[rip+disp]` dentro de `Game::walk`, calculados como
`insn_addr + insn_size + disp`:

| RVA | uso na função | papéis |
| :--- | :--- | :--- |
| `0x39cb958` | `0x780cd8` load, `0x781124`, `0x781192` | objeto de sessão. Gate: `test rax,rax` e `cmp byte [rax+0xb0],0` |
| `0x39cb998` | `0x780d02` load → `rcx`; `0x780f09`..`0x78110f` (8 ramos) | objeto passado ao gate `0x891600`; vira `rbx` em cada ramo |
| `0x39cb998+?` | `0x781124` também lê | final da função |
| `0x39cba98` | `0x780ccb` `cmp byte` | flag: **≠ 0 para prosseguir** |
| `0x39cba99` | `0x780cc4` **escreve 0**; `0x781222`, `0x781238` escrevem 1 | flag de estado, zerada no entry |
| `0x39cba9a` | `0x780cf5` `cmp byte` | flag: **= 0 para prosseguir** |
| `0x3991490` | `0x780d2c` → `rcx` | base do relógio de throttle (`imul` com `0x20c49ba5e353f7cf`) |
| `0x1a3e820` | 8 `call [rip+…]` | import/IAT do alocador de `OutputMessage` |
| `0x39ccaf0` | `0x781159` `lea rcx` | buffer/objeto de saída |
| `0x2025878..0x2025886` | `0x780d6d`.. | constantes (xmm/word/byte) |
| `0x2274040` | `0x780ca8` | cookie de stack (`xor rax,rsp`) |
| `0x2291b73` | `0x780d1f` `cmp byte` | terceira flag de gate |

**Nada disso foi obtido somando `+0x1a40`.** O delta da função não vale para
globais: `0x39c7268 + 0x1a40 = 0x39cc6a8` não é o que a função referencia;
a referência real é `0x39cb958`.

Checagem executada agora, com o jogo no mundo:

```
[0x39cb958] = 0x22a7ed87100   != 0
[+0xb0]     > 0               (gate passou)
[0x39cb998] = 0x22a0389f160   != 0
[0x39cba98] = 1               (flag de prosseguir satisfeita)
[0x39cba9a] = 0               (flag de prosseguir satisfeita)
```

Isso é coerente com o gate documentado, mas **não prova** que `0x39cb958` é
`LocalPlayer`. RTTI não parseia neste binário empacotado — tentei e saiu lixo,
então descarto RTTI como evidência aqui. A identidade continua pendente; o que
existe é coerência de papel.

---

## 3. Threads que receberiam o breakpoint

Não é "todas as 66". O custo de armar em todas inclui 65 suspensões
desnecessárias e um breakpoint que nunca dispara nelas.

Critério, do mais defensável ao mais especulativo:

| prioridade | thread | base do critério | força |
| :--- | :--- | :--- | :--- |
| 1 | **13520** | única dona de janela visível (`windowThreads`). CPU de kernel 120 s, a maior do processo | **candidata**, não prova. É a thread que processa input; o caminho é disparado por tecla |
| 2 | **18352, 1484, 4204** | maior tempo de CPU de kernel (32.6 s, 31.3 s, 30.6 s) — trabalho real, não ocioso | **candidatas** por atividade, não por função |
| 3 | todas as 66 | cobertura total | garantia de não perder, ao custo de ~66 suspensões no armamento |

Recomendação: **armar em 13520 + as três de maior CPU primeiro**. Se 5 eventos
ou 60 s passarem sem hit, **aí sim** armar nas 66 — como segunda tentativa
declarada, não automática.

Por que isso é honesto: `windowThreads` é fato medido; "maior CPU" é fato
medido. "É a thread que executa o caminho" continua inferência. O breakpoint
existe justamente para transformar essa inferência em observação.

---

## 4. Preservação do estado de depuração existente

O que pode existir por thread, e como cada campo é tratado:

| recurso | risco | tratamento |
| :--- | :--- | :--- |
| `DR0..DR3` | um depurador ou outra ferramenta pode já usá-los | **ler todos** antes; se qualquer um estiver ativo (`DR7 & 0x55` != 0), usar o próximo slot livre; se os 4 estiverem ocupados, **não armar** e reportar |
| `DR6` | é status, não configuração | `DR6 = 0` no armamento e no desarme; não é estado de terceiros |
| `DR7` | bits `L0..L3` do armamento anterior | preservar os bits dos outros slots; mexer só no slot escolhido |
| VEH existente | outro handler pode tratar `SINGLE_STEP` | registrar como **último** na cadeia (`First=0`) e devolver `EXCEPTION_CONTINUE_SEARCH` para tudo que não for nosso `Rip` |
| `SuspendThread` count | thread já suspensa por terceiro | ler a contagem anterior; **não** fazer `ResumeThread` extra (§5) |
| EFLAGS.RF | sem ele, o mesmo RIP re-dispara em loop | setar `0x10000` no contexto tratado |

O código existente **já erra** em um ponto: `pka_dispatch_trace.c:209` escreve
`ctx.Dr7 = 0x1` fixo, apagando bits de outros slots. A versão para `Game::walk`
tem de fazer read-modify-write do slot escolhido, não atribuição cega.

---

## 5. Remoção do breakpoint e do handler — em todos os caminhos

**Este é o item que a DLL atual não cumpre.** `pka_dispatch_trace.c` registra o
VEH (`AddVectoredExceptionHandler`) e **nunca o remove**; não existe
`RemoveVectoredExceptionHandler`, nem `DR7 = 0` em lugar nenhum, nem caminho de
desarme em `DllMain`. Também cria uma thread de rearme infinita (`rearm_thread`,
`for(;;)` com `Sleep(1500)`) que reinscreve `DR0` a cada 1,5 s para sempre.
Reaproveitar aquilo como está significaria **breakpoint permanente até fechar o
jogo**. A nova DLL precisa de:

```
PkaWalkTraceStop():
  1. g_stopping = 1                (a thread de rearme sai do laço)
  2. RemoveVectoredExceptionHandler(g_veh);  g_veh = NULL
  3. para cada thread: SuspendThread -> DR7 &= ~(bits do nosso slot)
                       -> DR6 = 0 -> SetThreadContext -> ResumeThread
  4. fflush(g_out); fclose(g_out); g_out = NULL
  5. grava um JSON final com: motivo, quantos eventos, quantas threads
     desarmadas, quantas falharam
```

Caminhos que precisam chamar `Stop()`:

| caminho | como é coberto |
| :--- | :--- |
| limite de 5 eventos | `Stop()` chamado pelo próprio handler ao atingir |
| 60 s | timer thread dedicada chama `Stop()` |
| erro no handler | `Stop()` antes de retornar `CONTINUE_SEARCH` |
| `DLL_PROCESS_DETACH` (**se** for chamado) | `Stop()` |

E o limite honesto: **`DLL_PROCESS_DETACH` não é garantido.** Se o processo for
morto por `TerminateProcess`, o detach não roda. Nesse caso o breakpoint morre
junto com o processo, porque `DR0..DR7` são estado de thread — não persistem em
disco nem no exe. `RemoveVectoredExceptionHandler` também deixa de importar,
porque o handler vive na DLL que morre com o processo. Esta é a única razão pela
qual esse mecanismo é mais seguro que um inline hook: **o pior caso é
"nada ficou"**, não "ficou byte alterado".

O que **não** é coberto por isso: se a thread de rearme continuar viva e a
`Stop()` não tiver sido chamada, ela rearma indefinidamente. Por isso o passo 1
existe e por isso o timer de 60 s chama `Stop()`, não um simples `Sleep` de saída.

---

## 6. Convivência com a DLL já carregada

Fato verificado agora: **nenhuma DLL da frente bot está carregada no PID 24800.**

```
modulos carregados: 79
PKA / tap / msftedit / dispatch: NENHUM
```

O `AGENTS.md` proíbe as duas DLLs juntas no mesmo processo (bot = `pka_native`,
sniff = `pka_tap`). Regras para esta rodada:

1. **Uma DLL só.** Se `pka_native.dll` estiver carregada, não injetar o tracer
   no mesmo processo; encerrar e reiniciar o cliente primeiro.
2. **Verificar antes de injetar**: enumerar módulos; recusar se qualquer
   `pka_*.dll` já estiver presente.
3. **Não usar o injetor durante o bot ativo.** `pka_inject.exe` usa
   `CreateRemoteThread` + `LoadLibraryA`: é visível e cria thread no alvo.
4. **Ordem de desarme antes de qualquer outra injeção.** O tracer sai primeiro;
   só depois outra DLL pode entrar.
5. **Sem depurador simultâneo.** Se `DR0..DR3` estiverem ocupados (§4), o
   tracer recusa em vez de brigar por slots.
6. **Nome de saída distinto** de `pka_native.log`/`pka_dispatch_*.jsonl`, para
   não misturar evidência de frentes diferentes.

---

## 7. Impacto e limites

| item | valor |
| :--- | :--- |
| bytes alterados no jogo | **0** |
| memória executável alocada no alvo | nenhuma além da própria DLL |
| eventos registrados | ≤ 5 |
| duração máxima | 60 s, com desarme automático |
| threads suspensas no armamento | 4 (rodada 1) ou 66 (rodada 2) |
| janela de suspensão por thread | dezenas de µs, já medida (média 22 µs) |
| requisição de injeção | **sim — CreateRemoteThread + LoadLibraryA** |

O último item é o que impede tratar isto como "só observação". Injeta DLL, então
precisa de autorização explícita e é a razão de estar aqui como proposta.

---

## 8. O que o resultado responde — e o que não responde

**Responde:**
- qual TID executa `Game::walk` no cliente real;
- em que instante, com que `edx` (direção) e `r8b` (flag);
- se `[0x39cb958]` e `[0x39cb998]` estavam não-nulos no instante da chamada;
- se `[[0x39cb958]+0x9a8]` / `[+0x9b0]` mudam após a chamada — lendo o objeto
  do **global**, não de `rcx`.

**Não responde:**
- se `Game::walk` é thread-safe;
- se funciona sem foco ou minimizado;
- como agendar nosso comando naquela thread;
- se `[0x39cb958]` é `LocalPlayer`.

---

## 9. Critério de decisão depois da coleta

| resultado | próximo passo |
| :--- | :--- |
| hit na 13520 | a hipótese "roda na thread de janela" ganha suporte observado; próximo teste seria despachar nela — **ainda não é aprovação** |
| hit em thread fora de `windowThreads` | a hipótese cai; precisa de fila ou de outro caminho de disparo |
| hit com `[0x39cb958]` diferente do valor de antes da chamada | o epílogo troca o objeto de sessão; investigar o que consome `+0x9a8/+0x9b0` |
| zero hits com 5 eventos de janela | método Errado para o caminho; reavaliar se o disparo é por tecla ou por pacote |
| DLL recusada por outro `DR` ocupado | resolver o conflito de depuração antes de tentar de novo |

Nenhum desses desfechos aprova o bot. Aprovação exige cliente real + **nosso**
bot + comando correlacionado ao deslocamento exato.

---

## 10. O que continua pendente e intocado

- Teste B (motor sem overshoot no cliente)
- executor nativo próprio
- background / minimizado
- integração de `native-step.cjs` no walker (não feita de propósito: falta
  demonstrar como o executor consumiria o contrato)
- identidade de `[0x39cb958]` como `LocalPlayer`
