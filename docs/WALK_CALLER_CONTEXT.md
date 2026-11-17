# Contexto do chamador — rodada 17

Data: 2026-11-06. Somente leitura + enumeração passiva de threads.
Nenhuma execução, chamada, injeção, hook, suspensão, patch, movimento ou foco.

Sessão nova: **PID 11596**, `PokeAlliance - Usobot`, base `0x7ff73fc00000`,
módulo `0x6386000`. Todos os RVAs reconferidos nesta sessão.

---

## 1. Correção importante: o entry point estava errado

Eu vinha tratando `0x7b4741` como entrada. **Está errado.**

```
0x7b473f  c3          ret
0x7b4740  40 53       push rbx      <- ENTRADA REAL (REX + push)
0x7b4741  53          push rbx      <- meio da instrução
```

`0x7b4741` é o segundo byte de `40 53`. Chamar ali executaria `push rbx; sub
rsp,0x20; ...` começando desalinhado — funciona por acidente nesse caso
específico, mas o endereço correto é **`0x7b4740`**.

Isso invalidou a busca anterior: procurei chamadores de `0x7b4741` e achei
**nenhum**. Com o entry correto aparecem **dois**:

```
call 0x7b4740  em  0x7b6efd
call 0x7b4740  em  0x996b54
```

---

## 2. Limites e blocos do wrapper (0x7b4740)

```
0x7b4740  push rbx
0x7b4742  sub  rsp, 0x20
0x7b4746  mov  r8d, [rcx+0xb4]      ; direção
0x7b474d  mov  rbx, rcx             ; this
0x7b4750  call 0x776000             ; valida tile → retorna WORD
0x7b4755  movzx r8d, ax             ; r8d = delay (ms)
0x7b4759  test r8w, r8w
0x7b475d  je   0x7b47b2             ; delay 0 → NÃO anda
0x7b475f  mov  rdx, [0x398cdd0]     ; relógio base
0x7b476b  movabs rax, 0x20c49ba5e353f7cf
0x7b4775  imul rdx                  ; rax:rdx = clock * magic
0x7b4778  mov  eax, r8d             ; delay
0x7b477b  add  rax, [rbx+0xbf8]     ; + timestamp do último passo
0x7b4782  mov  rdi, rdx
0x7b4785  sar  rdi, 7
0x7b4789  mov  rcx, rdi
0x7b478c  shr  rcx, 0x3f
0x7b4790  add  rdi, rcx             ; rdi = agora (ms)
0x7b4793  cmp  rdi, rax             ; agora >= último + delay ?
0x7b4796  jl   0x7b47ad             ; cedo demais → sai
0x7b4798  mov  edx, [rbx+0xb4]      ; direção
0x7b479e  xor  r8d, r8d             ; <<< R8B = 0
0x7b47a1  call 0x77f250             ; Game::walk(dir, 0)
0x7b47a6  mov  [rbx+0xbf8], rdi     ; atualiza timestamp
0x7b47ad  mov  rdi, [rsp+0x30]
0x7b47b2  add  rsp, 0x20
0x7b47b6  pop  rbx
0x7b47b7  ret
```

**Limites: `0x7b4740`..`0x7b47b7` (120 bytes).**

### Argumento entregue a Game::walk — CONFIRMADO

| registrador | valor | prova |
| :--- | :--- | :--- |
| `rcx` | ignorado pelo handler | handler recarrega de `[0x39c72a8]` |
| `edx` | `[rbx+0xb4]` = direção | `0x7b4798` |
| `r8b` | **0** | `0x7b479e xor r8d,r8d` |

### Throttle — CONFIRMADO, com unidade

`0x398cdd0` é um contador de alta frequência. A sequência
`imul` + `sar 7` é divisão por `1/1000` (magia `0x20c49ba5e353f7cf` = 1/1000
em ponto fixo). Portanto:

```
rdi = agora_em_ms
anda se  agora_ms >= [this+0xbf8] + delay_ms
```

**O throttle é em milissegundos**, e `delay` vem do `0x776000`.

---

## 3. `0x776000` — não era booleano

Retorna **WORD = delay em ms**, não `true/false`.

```
0x77600a  cmp word [rcx+0x164], 1     ; sessão precisa >= 1
0x776018  jb  → retorna 0             ; sem sessão: delay 0 (não anda)
0x77601e  cmp r8d, 8
0x776022  jne → caminho normal
          (r8d==8 é caso especial: auto-walk, usa [rcx+0xa20..0xa28])
0x77603b  ... vtable+0x110 (obter tile na direção) ...
0x77604d  call [0x1a3a820]            ; mesmo thunk do handler
0x77605e  call 0x762050               ; calcula tile destino
0x77606e  cmp r10d, 0xffff            ; valida x==-1 ?
0x776087  ...segunda consulta se inválido...
0x7760ad  test em x,y,z: rejeita negativos
0x7760c8  cmp x,y < 0xffff ; z <= 0xf  ; valida faixa
0x7760ec  ... cálculo do delay em ms a partir de x,y ...
0x776124  lea r8, [0x39c8400]         ; tabela indexada por z
0x776136  ... busca binária em árvore ...
0x77617e  caminho de rejeição          ; delay alternativo ou 0
```

**Confirmado:** `0x776000` valida o tile de destino (faixa, andar) e devolve o
custo de caminhada em ms. Não é "pode andar?".

**Desconhecido:** a fórmula exata do delay e o significado de
`[rcx+0x164]` (hoje = 320; `+0xa60` = 312 — provavelmente step duration).

---

## 4. Quem chama o wrapper — ENCONTRADO

### 4.1 `0x7b6ed0` — a função de "mudar direção de caminhada"

```
0x7b6ed0  mov [rsp+8], rbx
0x7b6ed5  push rdi / sub rsp,0x30
0x7b6eda  movzx edi, dl                  ; dl = nova direção
0x7b6edd  mov  rbx, rcx                  ; this
0x7b6ee0  cmp  byte [rcx+0xcf6], dl      ; já está nessa direção?
0x7b6ee6  je   0x7b6f42                  ; sim → não faz nada
0x7b6ee8  mov  byte [rcx+0xcf6], dl      ; grava direção ativa
0x7b6eee  test dl, dl
0x7b6ef0  je   0x7b6f0c                  ; direção 0 = parar
0x7b6ef2  mov  qword [rcx+0xbf8], 0      ; ZERA o throttle
0x7b6efd  call 0x7b4740                  ; <<< wrapper
0x7b6f02  mov  rcx, rbx
0x7b6f05  call 0x7b47c0
```

**ASSINATURA:** `__thiscall` — `rcx = objeto`, `dl = direção (0..7, 0 = parar)`.

`[obj+0xcf6]` é a **direção ativa** da caminhada (hoje `0`).

Isso responde como o cliente anda por tecla: input → `0x7b6ed0(dir)` → wrapper.
E como **parar**: `0x7b6ed0(0)` chama `0x7b4a50`.

### 4.2 `0x996b54` — segundo chamador

```
0x996b44  cmp byte [rcx+0xcf6], 0
0x996b4b  jne 0x996b54
0x996b4d  call 0x7b4a50        ; parar
0x996b54  call 0x7b4740        ; continuar andando na direção ativa
```

É um "tick" que retoma a caminhada se a direção ativa != 0. Ainda não sei quem
o agenda.

### 4.3 O objeto é `LocalPlayer`?

Os campos batem com `LocalPlayer`:

| offset | valor no LocalPlayer | usado por |
| :--- | :--- | :--- |
| `+0xb4` | 2 | wrapper lê como direção |
| `+0xbf8` | 0 | throttle |
| `+0xcf6` | 0 | direção ativa |
| `+0x164` | 320 | validação de sessão |
| `+0xa20/24/28` | 957 / 1404 / 6 | posição de destino |
| `+0x20` | 957 / 1404 / 6 | posição real |

**Mas não provei que `this` é o mesmo `[0x39c7268]`.** É inferência forte por
coincidência de layout, não identidade demonstrada. Não declaro.

---

## 5. Threads — enumeração passiva (permitida)

66 threads no PID. Start addresses:

| padrão | quantidade | observação |
| :--- | :--- | :--- |
| `0x7ff8ce3b8570` | 21 | DLL do sistema (loader/pool) |
| `0x7ff9cd2f7c30` | 24 | DLL do sistema |
| `0x7ff9d757cd00` | 22 | DLL do sistema |
| `0x7ff9caf44930` | 1 | fora do módulo |
| `0x7ff9da084990` | 2 | fora do módulo |
| **`0x7ff7455f0b8b`** | **1** | **RVA `0x59f0b8b` — DENTRO do módulo** |

A única thread com start no módulo do jogo é **TID 21328**, em RVA
`0x59f0b8b`.

Código nesse endereço:

```
0x59f0b8b  push rbx / push rdi / pushfq
0x59f0b8e  movabs rdi, 0xdb00fe84469caa33
0x59f0b98  add di, 0xbeaa
0x59f0b9d  call 0x57c14ce
```

**Entropia: 7.02 bits/byte** — contra 5.77 do `Game::walk` no `.text`.
Sem strings legíveis num raio de 0x20000 além das de import.

Isso é **código de VM/proteção**, não uma thread de lógica de jogo.

**LIMITE DECLARADO:** enumeração dá start address, não prova quem executa o
wrapper. TID 21328 é uma **pista**, não conclusão.

---

## 6. O que isso muda no desenho

Antes eu supunha "chamar `Game::walk` direto da DLL". Agora sei que existe uma
**função de entrada com contrato claro**:

```
0x7b6ed0(this, dir)   ; dir 0..7, 0 = parar
  → valida direção ativa
  → zera throttle
  → wrapper valida tile e calcula delay
  → Game::walk(dir, 0)
```

Chamar `0x7b6ed0` é **mais correto** que chamar `0x77f250`:

- respeita a flag de direção ativa (`+0xcf6`);
- respeita o throttle (não força passo em cima de passo);
- valida o tile antes.

---

## 7. Perguntas separadas (como pedido)

| pergunta | estado |
| :--- | :--- |
| **A)** em que contexto o caminho natural executa? | **desconhecido.** Dois chamadores identificados (`0x7b6ed0`, `0x996b54`), nenhum com scheduler localizado |
| **B)** qual mecanismo agendaria nosso comando nesse contexto? | **aberto.** Candidatos: thread de input do cliente, ou chamada direta de thread própria (mas ver risco abaixo) |
| **C)** continua processando sem foco? | **não testado** |
| **D)** funciona minimizado? | **não testado** |

A **não** comprova B, C nem D.

---

## 8. Proposta de observação dinâmica (NÃO executada)

**Pergunta:** quem executa `0x7b6ed0`/`0x7b4740` e em qual thread?

**Endereço e limites confirmados:** `0x7b4740`..`0x7b47b7` (120 B);
`0x7b6ed0`..`0x7b6f4c`.

**Mecanismo escolhido:** hook de **leitura** (não patch de comportamento) no
entry `0x7b4740`, registrando `GetCurrentThreadId` e `[rcx+0xcf6]`, com
trampolim. Motivo: é o ponto único por onde todos os caminhos passam, e a
leitura não altera a decisão.

**Dados mínimos:** thread ID da execução; se `rcx` é `[0x39c7268]`;
sequência de direções.

**Duração:** um passo manual seu (tecla de andar), até 3 eventos ou 60 s.

**Efeitos:** patch de 5 bytes (jmp) + 12 bytes de trampolim em região
executável alocada. **Original salvo em memória e restaurado ao final.**

**Critério de encerramento:** primeiro evento capturado; ou 60 s; ou erro.

**Rollback:** restaurar os 5 bytes originais e liberar a região alocada. Se o
processo travar, reiniciar o cliente resolve (patch não persiste em disco).

**Ações manuais necessárias:** você aperta uma seta no jogo durante a janela.

**Riscos honestos:**
- hook em código de proteção pode ser detectado;
- se `0x7b4740` rodar em várias threads, o handler tem que ser reentrante;
- **alternativa sem hook**: `NtGetContextThread` em amostragem das 66 threads
  não serve — dá o IP atual, não a cadeia.

**Alternativa mais barata ainda não tentada:** procurar o **registro do input**
— o cliente é OTClient e lê teclado por algum `WM_KEYDOWN` ou hook. Rastrear
`0x7b6ed0` como alvo de uma vtable/window proc resolveria sem patch. **É o que
eu faria antes de propor hook.**

---

## 9. Pendências preservadas

| marco | estado |
| :--- | :--- |
| Motor sem overshoot no cliente | **PENDENTE** |
| Executor nativo background | **NÃO IMPLEMENTADO** — contrato avançou, contexto aberto |
| Teste A foreground | VALIDADO 19:10Z (outra sessão) |
| `pendingStep` / controle de despacho | **intactos**, nenhum teste alterado |

Testes: botfinal 120/120, tap 48/48.
