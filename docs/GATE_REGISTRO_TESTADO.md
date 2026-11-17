# Gate e registro — testado contra o jogo

Data: 2026-11-09
Instância: PID **28500**, criada 11:29:09, base **`0x7ff789f20000`**
**Leitura ao vivo** (`PROCESS_VM_READ`). Sem attach, escrita, suspensão.

---

## 1. Revalidação antes de qualquer conclusão

| item | resultado |
| :--- | :--- |
| A `0x7463d0` | `4055535657415441` OK |
| B `0x74742a` | `e861980300` OK |
| C `0x780c90` | `48895c2408555657` OK |
| `_DoCall` `0x37bc40` | `4883ec28` OK |
| vftable `0x1f899e0` slots 0..5 | **6/6** OK |

Identidade conferida. Sem isso eu não seguiria.

---

## 2. Achei o escritor do gate

Primeiro falhei duas vezes: comparei RVA com VA, e procurei só imediatos
RIP-relative. O gate é o **byte alto** do DWORD em `0x2291d08`:

```
0x2291d08  DWORD atual = 0x00000001
bytes em memória:  d08=01  d09=00  d0a=00  d0b=00   <- gate = 0
```

Varredura por bytes com o **endereço alinhado** achou:

```
0x30091f  mov dword ptr [rip+0x1f913e3], ebx   ->  alvo 0x2291d08, delta 0
```

E `ebx` ali vale **0** — `0x3007e8 xor ebx,ebx`, sem outra escrita em ebx até
a store (verificado instrução a instrução).

---

## 3. O que é essa função

`0x3007c0..0x300af2` (818 bytes), com estas strings:

| instrução | string |
| :--- | :--- |
| `0x30092b lea rdx` | `"application"` |
| `0x300944 lea rdx` | `"app"` |
| `0x300976 lea rdx` | `"cp1252"` |
| `0x300932 lea rcx` | bloco que vira `"PokeAlliance"` |

**Observação, não conclusão:** `"application"` + `"cp1252"` é padrão de
inicialização de toolkit (nome de app + codec de locale). Não afirmo qual
toolkit. O ponto é que **não é lógica de gameplay** — é inicialização.

---

## 4. Quem chama: **ninguém**. É inicializador estático

```
E8 rel32 -> 0x3007c0   : NENHUM
ponteiro absoluto      : 0x1a44a90
```

E `0x1a44a90` está numa **tabela contígua**:

```
0x1a44a70 -> 0x300720
0x1a44a78 -> 0x300740
0x1a44a80 -> 0x300760
0x1a44a88 -> 0x300780
0x1a44a90 -> 0x3007c0   <-- o nosso
0x1a44a98 -> 0x300b00
```

Sequência de funções 0x3007xx em tabela de ponteiros = **`.CRT$XCU`**
(inicializadores estáticos do CRT). Roda **uma vez, no carregamento** — não
por frame, não por evento.

---

## 5. Teste no jogo: o caminho está inativo

Estado lido agora, com o cliente **no mundo**:

| global | valor |
| :--- | :--- |
| `[0x39cb958]` LocalPlayer | `0x1f8e38953c0` (**válido**) |
| `[LocalPlayer+0xb0]` | 64 (não-zero → gate de sessão ok) |
| `[LocalPlayer+0x9a8]` | `0x1f8fde6d2b0` (par shared_ptr populado) |
| **`[0x39d3818]` container** | **NULL** |
| **byte `[0x2291d0b]` gate** | **0** |

**Ou seja: mesmo com o personagem no mundo, o callable não foi registrado.**
O container nunca foi criado.

E `0x37a7a0` (a função que contém o registro) faz:

```
0x37a7ba  cmp byte [0x2291d0b], 0
0x37a7c1  je  0x37b51e        ; -> epílogo, RETORNA
```

Com byte 0, **retorna antes de tocar na vftable**.

---

## 6. Por que 0x37bc40 nunca disparou — causa final

```
0x37a7a0 não registra (gate byte = 0)
    -> container fica NULL
        -> std::function nunca existe
            -> _DoCall (0x37bc40) nunca é chamado
                -> bp nunca dispara
```

Não foi falha de breakpoint, nem anti-tamper, nem caminho alternativo. **O
callable não está registrado.**

---

## 7. Lacuna honesta

**Contradição que não resolvi:** o único escritor RIP-relative de
`0x2291d08` grava **0**, mas o DWORD observado é **0x1**. Logo existe **outro
escritor** que minha varredura não pegou — provavelmente `mov [reg+disp], imm`
(não RIP-relative, acesso por índice/base).

Consequência: não sei se o byte `0x2291d0b` pode algum dia ser ≠ 0. Com todas
as escritas que encontrei, ele permanece 0.

**Intervalo/pergunta para fechar:**

> procurar escritas **não** RIP-relative que alcancem `0x2291d08..0x2291d0b`
> — qualquer `mov [reg+disp32], r32` cujo `reg+disp` resolva para aquele
> DWORD. Isso exige rastrear ponteiros para a região, não um padrão fixo.

---

## 8. O que isso muda

- A pergunta "mouse vs teclado" **deixa de ser a relevante** para esta
  cadeia: ela está inativa no estado observado.
- O wrapper `0x7b6346` (que também chama C, sem passar por A/B) **não** foi
  investigado nesta rodada e continua sendo o candidato mais provável para o
  caminho do teclado — mas **não foi testado**.

---

## 9. Não afirmo

- que o cliente use Qt (só vi strings compatíveis)
- que o byte do gate nunca possa ficar ≠ 0 (só que nenhum escritor achado o faz)
- qual caminho o teclado usa
- thread, scheduler, thread safety, background

---

## 10. Artefatos e preservação

```
local-data/gate-xrefs-2026-11-09.json
local-data/init-callers-2026-11-09.json
local-data/global-xrefs-bytes-2026-11-09.json
tools/gate_xrefs_all.py, tools/find_init_callers.py, tools/global_xrefs_bytes.py
```

`WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs` — intactos.
Tracer congelado `810A87FF…318B`. 20/20.
