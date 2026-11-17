# Game::walk — contrato revisado (rodada 2)

Data: 2026-11-06. Somente leitura no processo já aberto. Nenhuma execução,
chamada, injeção, hook, suspensão de thread, movimento ou alteração de foco.

Este documento **corrige** `WALK_HANDLER_CONTRACT.md` em pontos importantes.

---

## 0. Separação exigida

| categoria | itens |
| :--- | :--- |
| **A.** Observado no payload do Shiba | gate `payload+0x1dc20` (GetCurrentThreadId); consumidor `0xd4ac0`; executor `0x11cc0`; ramo walk `0x1210d`; descritor `0xe51b8`; chave `0x70d1d0`; tabela de perfil 6 → `exe+0x77f250`; thread gravada **31356** |
| **B.** Observado no executável do cliente | `Game::walk` em `exe+0x77f250` (build `82eadedc…`); limites `0x77f250..0x77f844` via `.pdata`; 8 opcodes de direção; escrita em fila; nenhuma API de teclado |
| **C.** Hipótese não confirmada | que `Game::walk` seja o caminho que o Shiba usa em produção; que a fila em `[game+0x9a8]` seja drenada numa thread específica; que funcione sem foco/minimizado |
| **D.** Comprovado com nosso bot | **nada nesta rodada.** Teste A validado (19:10Z) apenas para o executor de teclado em foreground |

O gate `0x1dc20` é **do Shiba**, no payload dele. Não atribuo essa restrição ao
`Game::walk` do cliente. São espaços diferentes: payload = DLL do fornecedor,
cliente = executável do jogo. A ligação entre eles não foi demonstrada.

O ID `31356` é histórico e não é reutilizado.

---

## 1. PRIORIDADE A — objeto: RESOLVIDA (com correção importante)

### O handler NÃO usa o RCX recebido

Varri todas as instruções que tocam `rcx` entre `0x77f250` e `0x77f2e0`:

```
0x77f2c2  mov  rcx, qword ptr [rip + 0x3247fdf]
0x77f2c9  test rcx, rcx
```

**Nenhuma leitura do RCX de entrada.** O primeiro uso de `rcx` é uma
recarga de global. O `this` vem de `[base+0x39c72a8]`, não do chamador.

Correção ao relatório anterior: eu havia escrito "RCX = this, 1º argumento,
não recarregado". **Está errado.** O argumento é ignorado.

### Correção ao dispatcher (também errada antes)

O dispatcher remapeia argumentos:

```
0x1db54 mov r13, rdx          ; salva arg2
0x1db51 mov r12, r8           ; salva arg3
0x1db4e mov r15, r9           ; salva arg4
0x1dbda mov rcx, r13          ; handler.rcx <- dispatcher.arg2
0x1dbd7 mov rdx, r12          ; handler.rdx <- dispatcher.arg3  (direção)
0x1dbd4 mov r8,  r15          ; handler.r8  <- dispatcher.arg4
```

E no ramo walk:
```
0x1211f mov rdx, [rip+0x212b8a]  ; arg2 = global 0x224cb0 (payload)
0x12126 lea rcx, [rip+0xd308b]   ; arg1 = descritor
0x12132 mov r8d, ebx             ; arg3 = direção
0x1213a xor r9d, r9d             ; arg4 = 0
```

Então, para o handler: `rcx` = global `0x224cb0` do payload, `rdx` = direção,
`r8b` = 0. Mas como o handler **ignora rcx**, o valor do global do payload é
irrelevante para ele. O que importa é `0x39c72a8` no cliente.

### Critérios de objeto válido

O gate `0x88ec20(this)` exige:

| offset | condição |
| :--- | :--- |
| `[this+0x40]` | == 0 |
| `[this+0x24]` | == 0 |
| `[this+0x68]` | ponteiro não nulo |
| `[[this+0x68]+0x3d0]` | != 0 |

E antes, em `0x77f298`: `[0x39c7268]` não nulo e `[rax+0xb0] > 0`.

### Estado medido agora (jogo na seleção de personagem)

```
[0x39c73a8] flag1 = 0
[0x39c7268] ptr   = 0        <- objeto de sessão
[0x39c73aa] flag2 = 0
[0x39c72a8] THIS  = 0        <- handler sairia no test rcx,rcx
```

Os quatro estão **zero** porque não há sessão no mundo. Isso não é falha de
análise: é a prova de que essas globais são preenchidas **na entrada do mundo**,
e é exatamente o critério para distinguir objeto válido de sessão anterior.

### Falso positivo descartado

O candidato em `0x227cc88` que eu havia achado não é ponteiro: contém ASCII
`"6414"` (`0x34343136`). O scan casou por coincidência de bytes, não por
identidade. Registro o critério: **um candidato só vale se a vtable apontar
para dentro do módulo e os 4 campos do gate passarem.**

### O que falta para A

Os 4 globais são a resposta — mas estão zero porque o jogo está fora do mundo.
**Preciso observá-los com o personagem no mundo.** É leitura de 4 qwords. Isso
fecha a Prioridade A sem chamar nada.

---

## 2. PRIORIDADE B — argumentos e retorno

### R8B: CONFIRMADO

No ramo walk, `0x1213a: xor r9d, r9d` → o dispatcher repassa como `r8` →
`0x77f276: movzx r14d, r8b`. Depois `r14b` vai para `r8d` em `0x77f48d`.

**Para walk, é sempre 0.** Não é escolha por conveniência: o único chamador
conhecido (o ramo walk do payload) zera explicitamente.

Não sei o que o 0 significa semanticamente (flag de "origem"), e não invento.

### Direção: CONFIRMADA

`EDX` → `movsxd rdi, edx` → `cmp edi,7` (`ja` sai) → índice na tabela
`0x77f824 + rdi*4` → salto para o ramo → `mov edx, <opcode>`.

| dir | ramo | opcode | Tibia |
| :--- | :--- | :--- | :--- |
| 0 | 0x77f4c9 | 0x65 | N |
| 1 | 0x77f50c | 0x66 | E |
| 2 | 0x77f54f | 0x67 | S |
| 3 | 0x77f592 | 0x68 | W |
| 4 | 0x77f5d5 | 0x6A | NE |
| 5 | 0x77f618 | 0x6B | SE |
| 6 | 0x77f658 | 0x6C | SW |
| 7 | 0x77f698 | 0x6D | NW |

### O que cada ramo faz — CORREÇÃO IMPORTANTE

Eu havia escrito "monta OutputMessage e despacha pela vtable". O ramo faz:

```
mov rbx, [rip+0x3247dd8]     ; objeto global (RVA 0x39c72a8)
lea rcx, [rbp+7]             ; objeto local
call 0x548c30                ; construtor
mov edx, 0x65                ; opcode
call 0x5410c0                ; append no buffer local
mov rax, [rbx]               ; vtable do global
mov rax, [rax+8]             ; slot 1
call rax                     ; <envio>
jmp 0x77f6d6                 ; epílogo comum
```

E o epílogo `0x77f6d6` **enfileira**:

```
0x77f6e4 mov rcx, [rip+0x3247b7d]   ; global 0x39c7268
0x77f6eb mov rax, [rcx]
0x77f6f9 call [rip+0x12bb121]       ; chamada virtual
0x77f7a5 mov rax, [r8+0x9a8]        ; head
0x77f7b0 mov [r8+0x9a8], rcx        ; substitui
0x77f7b7 mov rcx, [r8+0x9b0]        ; tail
0x77f7c2 mov [r8+0x9b0], rdx        ; substitui
```

com `lock inc dword ptr [rcx+8]` antes — incremento de refcount de
`shared_ptr`. **Isso é enfileiramento de objeto compartilhado, não envio
imediato.**

Portanto: `Game::walk` **coloca a caminhada numa fila**. Quem drena a fila e
envia ao servidor é outra coisa, ainda não identificada.

### Retorno: NÃO CONFIRMADO

`.pdata` dá o corpo: `0x77f250..0x77f844` (1524 bytes). O epílogo real é
`0x77f7ff..0x77f821` (`ret` em `0x77f821`).

Não consegui estabelecer o tipo de retorno porque:
- a disassembly linear desincroniza em trechos com dados inline;
- não há `xor eax,eax` / `mov al,1` claros nos caminhos de saída;
- o dispatcher do Shiba testa `al`, mas isso é do Shiba, não do cliente.

**Desconhecido.** Não declaro bool.

---

## 3. PRIORIDADE C — contexto: BLOQUEADA com precisão

### O que está provado

- O gate `0x1dc20` do Shiba exige `GetCurrentThreadId() == thread gravada`.
  Isso é **do payload**, para o dispatcher dele.
- O handler `Game::walk` **não tem gate de thread**. Não encontrei
  `GetCurrentThreadId` no corpo dele nem chamada a `0x1dc20`.
- O handler **enfileira**, não envia. Logo o contexto crítico não é dele, é de
  **quem drena a fila**.

### O que falta

1. **Quem drena** a fila em `[0x39c7268 + 0x9a8/0x9b0]`.
2. **Em qual thread** isso acontece.
3. Se essa thread sobrevive à minimização.

### Evidência exata necessária

Com o personagem no mundo (as globais preenchidas):
- ler `[0x39c7268]`, `[+0x9a8]` (head), `[+0x9b0]` (tail);
- varrer o módulo por referências a esses offsets para achar o consumidor;
- enumerar threads do PID e ver qual tem start address na região do consumidor.

**Enumeração de threads é auxiliar**, como você disse. Não prova agendamento.

---

## 4. O que mudou a conclusão

| antes | agora |
| :--- | :--- |
| "o handler recebe `this` no RCX" | **falso** — ignora e recarrega de `0x39c72a8` |
| "o handler envia pela vtable" | **parcial** — ele enfileira no epílogo; a vtable é do objeto de envio, não necessariamente envio imediato |
| "não sei o `this`" | **agora sei**: global `0x39c72a8`, zero fora do mundo |
| "gate de thread restringe o Game::walk" | **falso** — o gate é do Shiba. O handler não tem gate de thread |

---

## 5. Caminho de integração proposto (não implementado)

```
config → WalkerEngine → BotRuntime → CommandDispatcher   (inalterado)
  → Transport (pipe)                                      (inalterado)
    → pka_native.dll
      → executor nativo: chamar Game::walk(dir)           (novo elo)
```

O elo novo substituiria **apenas** `execute_command(tipo 1)`. O resto fica.

Pré-condições que o executor deve checar antes de chamar (todas já conhecidas):
`[0x39c72a8] != 0`, `gate 0x88ec20` verdadeiro, `dir <= 7`.

Falha em qualquer uma → `STATUS_NO_SESSION` explícito, **sem fallback para
teclado**.

Não implemento nada disso até ter o objeto resolvido com o jogo no mundo.

---

## 6. Menor coleta que falta

**Uma** leitura, sem ação no jogo, com o personagem **no mundo**:

| item | detalhe |
| :--- | :--- |
| ferramenta | `ReadProcessMemory` no PID do cliente (já usado) |
| dados | `[base+0x39c73a8]`, `[+0x39c7268]`, `[+0x39c73aa]`, `[+0x39c72a8]`; e se não-zero, `[[0x39c7268]+0xb0]`, `[+0x9a8]`, `[+0x9b0]` |
| duração | instantâneo |
| efeitos | nenhum — leitura pura, sem escrita, sem foco, sem injeção |
| pergunta que resolve | as globais são preenchidas no mundo? o objeto passa no gate? a fila existe? |

Com isso a Prioridade A fecha e a C ganha o endereço da fila para rastrear o
drenador.

**Não solicito** nada que chame função, mova personagem ou altere foco.
