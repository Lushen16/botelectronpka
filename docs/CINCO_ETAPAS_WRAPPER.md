# 5 etapas — cadeia do wrapper e teste no jogo

Data: 2026-11-09
Instância: PID **28500**, base **`0x7ff789f20000`**. Leitura ao vivo, sem attach.

---

## ETAPA 1 — Revalidação ✅

| ponto | bytes | status |
| :--- | :--- | :--- |
| A `0x7463d0` | `4055535657415441` | OK |
| B `0x74742a` | `e861980300` | OK |
| C `0x780c90` | `48895c2408555657` | OK |
| wrapper `0x7b6346` | `48897c243048b8cf` | OK |

*(O primeiro teste abortou por bug meu: lia 8 bytes e comparava com 5.)*

---

## ETAPA 2 — Referências ao wrapper: **zero** ❌

```
E8 call : NENHUM
E9 jmp  : NENHUM
lea     : NENHUM
qword   : NENHUM
```

Ninguém referencia `0x7b6346`. Isso seria estranho — **a menos que `0x7b6346`
não seja uma função**.

---

## ETAPA 3 — É fragmento, não função ✅

Desmontei para trás e achei o prólogo real:

```asm
0x7b6320  push rbx                    <- PROLOGO REAL
0x7b6322  sub rsp, 0x20
0x7b6326  mov r8d, [rcx+0xb4]         ; direção
0x7b632d  mov rbx, rcx
0x7b6330  call 0x777a60               ; gate de sessão
0x7b6335  movzx r8d, ax
0x7b6339  test r8w, r8w
0x7b633d  je 0x7b6392                 ; sem sessão -> sai
0x7b633f  mov rdx, [rip+0x31db14a]    ; relógio
0x7b6346  <-- .pdata diz "início" AQUI (errado)
```

**`.pdata` tem DUAS entradas**: `0x7b6320..0x7b6346` (38 B) e
`0x7b6346..0x7b6392` (76 B). O segundo pedaço **não tem prólogo** — usa
`rdi`, `rbx` herdados. É **split de função** (hot/cold ou região com unwind
próprio), comum em código otimizado.

**Consequência:** procurar xrefs a `0x7b6346` procurava o endereço errado.
O alvo correto é `0x7b6320`.

---

## ETAPA 4 — Chamadores reais de `0x7b6320`

```
0x7b8add  (função 0x7b8ab0, 125 B)
0x999b04  (função 0x999ac0, 107 B)
```

### `0x7b8ab0` — liga/desliga autowalk

```asm
0x7b8ac0  cmp byte [rcx+0xcf6], dl    ; flag mudou?
0x7b8ac6  je  0x7b8b22                ; não -> sai
0x7b8ac8  mov [rcx+0xcf6], dl         ; GRAVA a flag
0x7b8ace  test dl, dl
0x7b8ad0  je  0x7b8aec                ; desligando
0x7b8ad2  mov qword [rcx+0xbf8], 0    ; RESETA o throttle
0x7b8add  call 0x7b6320               ; primeira chamada
0x7b8ae5  call 0x7b63a0
```

**É o setter de autowalk.** Escreve `[+0xcf6]` e zera `[+0xbf8]`.

### `0x999ac0` — tick do autowalk

```asm
0x999ae4  call 0x341560               ; resolve o objeto (rcx+8)
0x999af4  cmp byte [rcx+0xcf6], 0     ; flag DL ligada?
0x999afb  jne 0x999b04
0x999afd  call 0x7b6630               ; desligado -> outro caminho
0x999b04  call 0x7b6320               ; LIGADO -> chama o passo
```

**É o tick.** Só chama `0x7b6320` quando `[+0xcf6] != 0`.

---

## ETAPA 5 — Teste no jogo ✅ (com ressalva)

Leitura ao vivo, agora:

```
[0x39cb958] LocalPlayer = NULL
```

**O personagem saiu do mundo** entre a Etapa 1 e a Etapa 5. Portanto **não
consegui testar** `[LP+0x164]` (gate de sessão) nem `[+0xcf6]` (flag de
autowalk) com o jogo ativo.

**Isso é uma limitação declarada, não um resultado.** Não afirmo que o wrapper
está inativo — só que não pude medir.

---

## O que a cadeia diz (agora com base sólida)

```
[objeto +0xcf6] = flag de autowalk
       |
       v  (0x7b8ab0 liga / 0x999ac0 tick)
0x7b6320  gate: call 0x777a60 -> [rcx+0x164] >= 1 (sessão)
       |
       v
0x7b6346  throttle: rdi(agora_ms) >= [rbx+0xbf8] + delay
       |
       v
0x7b6381  call 0x780c90  =  C = Game::walk
```

**`[+0xcf6]` é a flag de autowalk**, e `[+0xbf8]` é o throttle. Ambos já
estavam documentados em `WALK_CALLER_CONTEXT.md` — agora sei **quem os
escreve**: `0x7b8ab0`.

---

## Correções ao que eu afirmei antes

| antes | agora |
| :--- | :--- |
| "wrapper `0x7b6346`, 76 bytes" | **fragmento**; função real é `0x7b6320..0x7b6392` |
| "nenhum E8/E9 aponta para `0x7b6346`" | correto, mas era o alvo errado; `0x7b6320` tem 2 chamadores |
| "gate `[0x2291d0b]`" | é o **byte alto** de `[0x2291d08]`; único escritor achado grava 0 |

---

## Próxima ação mínima

**Uma leitura com o jogo no mundo**, para medir:

1. `[LocalPlayer+0x164]` — word, gate de sessão do wrapper
2. `[LocalPlayer+0xcf6]` — byte, flag de autowalk
3. `[LocalPlayer+0xbf8]` — qword, throttle

Isso responde: **o wrapper está ativo?** Se `0x164 >= 1` e `0xcf6 != 0`, o
caminho está vivo e um teste de tecla/seta deveria produzir hit em C pelo
wrapper — sem depender de A/B.

Sem attach. Só RPM. Precisa do personagem no mundo.

---

## Preservado

`WalkerEngine` `2887A1E7…`, `pendingStep`, `native-step.cjs`, tracer congelado
`810A87FF…`, 20/20.

Artefatos: `local-data/wrapper-refs-*`, `wrapper-func-*`, `fragment-check-*`,
`callers-0x7b6320-*`.
