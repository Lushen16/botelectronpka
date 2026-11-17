# Coleta sincronizada — tentativa 03 (hit: não; bp verificado)

Data: 2026-11-08
Resultado: **sem hit, com movimento confirmado durante a janela e breakpoint
verificado no endereço correto.**

---

## 1. Configuração efetiva do breakpoint (agora verificada com `bl`)

```
0 e 00007ff6`43f50c90  0001 (0001)  0:****  PokeAlliance_dx+0x780c90 "r rip; r rdx; r r8; r rcx; kb"
```

| campo | valor |
| :--- | :--- |
| endereço resolvido | `0x7ff643f50c90` |
| base do módulo | `0x7ff6437d0000` |
| RVA | `0x780c90` ✓ |
| base + RVA | `0x7ff6437d0000 + 0x780c90 = 0x7ff643f50c90` **confere** |
| estado | `e` = enabled |
| `0001 (0001)` | hit count 1, não desabilitado após uso |
| restrição de thread | `0:****` = todas as threads |
| alvo | `PokeAlliance_dx+0x780c90` |

**O breakpoint estava correto e global.** A hipótese H2 (bp mal resolvido) está
**eliminada**.

---

## 2. Cronologia

| UTC | evento |
| :--- | :--- |
| 21:42:43 | driver inicia; pré-checagem OK |
| 21:42:43 | cdb anexa (pid 15588) |
| 21:42:44 | `.time` → process uptime 1:52:04 |
| 21:42:44 | `bp` instalado; **`bl` confirma `+0x780c90`** |
| 21:42:45 | **READY** (bp conferido, cliente retomado) |
| 21:42:45–21:43:05 | **janela de 20 s** — você confirmou deslocamento aqui |
| 21:43:05 | `NO_HIT_20S_CTRL_BREAK` |
| 21:43:05 | `r rip` = `0x7ff9da183f40` = `ntdll!DbgBreakPoint` → **interrupção** |
| 21:43:05 | `bc *` → `.detach` → `Detached` |

Nenhuma ocorrência de `Hit breakpoint` no log.

---

## 3. Confirmação visual

**Você confirmou: o personagem deslocou DURANTE a janela** (21:42:45–21:43:05Z).

Isso é retrospectivo, não timestamp exato. Mas é suficiente para estabelecer:
**houve entrada de movimento com o bp armado e correto, e o bp não disparou.**

---

## 4. Análise estática do caminho (leitura de memória, sem attach)

### Chamadores de `0x780c90` neste build

Exatamente dois `E8 rel32`:

| chamadora | função | natureza |
| :--- | :--- | :--- |
| `0x74742a` | `0x7463d0..0x74752c` | **handler de input** |
| `0x7b6381` | `0x7b6346` | wrapper de throttle (76 B) |

### O caminho do input, completo

```
0x37a6xx   calcula direção de deltas (comiss/cmovb)   -> eax, edx = dir
0x37a711   call 0x7463d0                              <- handler
0x7463d0   prólogo; le [0x39c9430] como objeto
0x74643a   cmp byte [0x39cba9a], 0                    <- GATE 1
0x746447   cmp byte [rcx+0xb0], 0                     <- GATE 2
0x746454   cmp byte [rcx+0xcf6], 0                    <- GATE 3
0x74645d   mov [rcx+0xb4], r14d                        <- grava direção
0x74742a   call 0x780c90                               <- Game::walk
```

### Gates observados agora (jogo vivo, em área livre)

| gate | endereço | valor | significado |
| :--- | :--- | :--- | :--- |
| `[0x39cba9a]` | gate 1 | `0` | **`jne` não salta → passa** |
| `[objeto+0xb0]` | gate 2 | `216` | `jbe` não salta → **passa** |
| `[objeto+0xcf6]` | gate 3 | `0` | `je 0x746468` → **salta o write de `+0xb4`** |
| `[objeto+0xc00]` | — | `27` | não-zero → **segue o caminho longo** |

**O objeto do handler** (`[0x39c9430]` = `0x2277728e050`) **não é o mesmo**
do `LocalPlayer` global `0x39cb958`. São objetos distintos.

---

## 5. Hipótese prioritária (revisada)

**H3 ganha peso: o caminho do teclado pode não passar por `Game::walk`
(`0x780c90`) neste build.**

Evidência:
1. bp **verificado** em `+0x780c90`, global, habilitado
2. movimento **confirmado** durante a janela
3. bp **não disparou**
4. existe handler de input (`0x7463d0`) que chama `0x780c90` em `0x74742a`
5. mas `[objeto+0xcf6] == 0` faz o fluxo **pular** o `mov [rcx+0xb4]`, e há um
   gate em `[r8+0xc00] == 27` que leva a um caminho diferente

**A lacuna específica:** não provei que `0x7463d0` seja o handler do teclado
*físico*. Ele calcula direção de deltas (`comiss`/`cmovb`) — assinatura
compatível — mas nenhuma referência direta o liga ao `WM_KEYDOWN`. Também não
provei que a execução durante o movimento passou por `0x74742a`.

**Não declaro "caminho alternativo provado".** O que existe é: o bp correto
não disparou enquanto houve movimento; e existe um caminho estático que
poderia explicar isso sem ser acionado.

---

## 6. Limpeza e continuidade — verificadas

| verificação | resultado |
| :--- | :--- |
| bytes `+0x780c90` após detach | `48895c240855565741564157488d6c24` — **restaurado** (0x48, não 0xCC) |
| cliente vivo | **sim**, PID 28308 (mesma instância, criada 19:50:39Z) |
| threads | 67 |
| cdb | encerrado, sem órfãos |
| breakpoint | removido (`bc *` + detach) |

---

## 7. Próxima ação

**Duas opções, ambas sem nova infraestrutura:**

**A. Breakpoint no handler em vez do alvo.** Armar `bp` em `0x7463d0`
(entrada do handler) e em `0x74742a` (a chamada). Um toque de seta responderia
diretamente:
- hit em `0x7463d0` mas não em `0x780c90` → algum gate desviou; o `r`/`kb`
  diria qual caminho
- hit em `0x7463d0` e em `0x780c90` → o bp original falhou por outro motivo
- nenhum hit → `0x7463d0` não é o handler do teclado

**B. Verificar se o teclado usa outro dispatcher.** Rastrear `WM_KEYDOWN` até a
thread que processa, sem breakpoint no jogo (via leitura de janela/thread).

**A é mais direta e usa o mesmo procedimento já autorizado e validado.**
Custo: mais um attach, mais um toque. Ganho: discrimina as três hipóteses
restantes de uma vez.

Precisa de nova autorização.

---

## 8. Não validado

Sem hit, nada foi provado sobre: scheduler, thread safety, executor nativo,
background, minimizado. Nem que `Game::walk` seja alcançado pelo teclado
neste build.
