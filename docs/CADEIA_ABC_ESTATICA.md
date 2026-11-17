# Cadeia A/B/C — análise estática

Data: 2026-11-09
Escopo: análise offline de artefatos e memória viva (somente leitura).
Nenhum attach, injeção, suspensão ou comando no jogo.

Build: base `0x7ff6437d0000`, PID 28308, criado `19:50:39Z`,
sha256 `48C41BD4…0AC2B`. Tamanho 104 MB.

---

## 0. Identificadores fixos (não renomear)

| nome | endereço | papel |
| :--- | :--- | :--- |
| **A** | `0x7463d0` | entrada candidata; recebe direção e chama C |
| **B** | `0x74742a` | instrução `call` para C, dentro de A |
| **C** | `0x780c90` | `Game::walk` |
| `0x37a320` | — | **conversor** de fração de posição em direção 0..7 |
| `0x37bc40` | — | método que calcula a fração e chama o conversor |

---

## 1. Cadeia sustentada por endereços e instruções

### Nível 1 — `0x37bc40` (callback registrado, não chamado)

```
0x37bc40  sub rsp, 0x28
0x37bc44  cmp dword ptr [r8], 4        ; <-- EXIGE TIPO == 4
0x37bc48  mov r9, rdx                  ; r9 = payload
0x37bc4b  je  0x37bc54                 ; se != 4, retorna 0
0x37bc54  mov rdx, [rip+0x3657bbd]     ; objeto de mapa
0x37bc5b  mov ecx, [rdx+0x74]          ; origem X
0x37bc5e  mov r8d, [rdx+0x70]          ; origem Y
0x37bc62  mov eax, [rdx+0x7c]          ; fim X
0x37bc65  sub eax, ecx / inc eax       ; largura = fimX - origX + 1
0x37bc6d  mov eax, [r9+4]              ; <-- click Y
0x37bc71  sub eax, ecx
0x37bc7a  mov eax, [rdx+0x78]          ; fim Y
0x37bc7d  sub eax, r8d / inc eax       ; altura
0x37bc8c  divss                        ; fracY
0x37bc9d  movss [rip+0x1f08b87], xmm2  ; -> 0x228482c
0x37bc89  mov eax, [r9]                ; <-- click X
0x37bc90  sub eax, r8d
0x37bca5  divss                        ; fracX
0x37bca9  movss [rip+0x1f08b77], xmm0  ; -> 0x2284828
0x37bcb1  call 0x37a320                ; conversor
```

### Nível 2 — `0x37a320` (conversor de direção — NÃO é A) converte fração

```
0x37a51d  movss xmm1, [0x228482c]      ; fracY  <- escrito por 0x37bc40
0x37a525  lea   rcx,   [0x228482c]
0x37a539  movss xmm10, [rax]
0x37a650  movss xmm1, [0x2284828]      ; 0.5
0x37a660  movss xmm2, [0x2284828]      ; fracX
0x37a668  movss xmm3, [0x2042e6c]      ; 0.3
0x37a658  movss xmm0, [0x2042ed0]      ; 0.7
...       comiss / cmovb               ; 8 ramos -> eax = 0..7
0x37a709  mov edx, [rip+0x364ed19]
0x37a70f  mov ecx, eax                 ; rcx = direção
0x37a711  call 0x7463d0                ; entrada candidata A
```

### Nível 3 — `0x7463d0` recebe a direção e chama `Game::walk`

```
0x74643a  cmp byte [0x39cba9a], 0      ; gate 1
0x746447  cmp byte [rcx+0xb0], 0       ; gate 2
0x746454  cmp byte [rcx+0xcf6], 0      ; gate 3
0x74645d  mov [rcx+0xb4], r14d         ; <-- grava DIREÇÃO no objeto
0x74742a  call 0x780c90                ; Game::walk
```

### Registro por ponteiro (não por `call`)

Nenhum `E8`/`E9` no módulo aponta para `0x37bc40` nem `0x37bd20`.
Ambos aparecem em `.rdata` como **ponteiros**:

```
0x1f899f0 -> 0x37bc40    <- slot de callback
0x1f89ad0 -> 0x37bd20
0x1f899e0/8 -> 0x37bd00
0x1f899f8 -> 0x37bc30
```

São **callbacks registrados**, invocados por ponteiro — consistente com uma
tabela de handlers de evento, não com chamada direta de função.

---

## 2. Origem dos argumentos — demonstrável

`0x37bc40` calcula, a partir de `[r9]` e `[r9+4]` e dos limites do mapa em
`[rdx+0x70/0x74/0x78/0x7c]`:

```
fracX = (clickX - origX) / (fimX - origX + 1)
fracY = (clickY - origY) / (fimY - origY + 1)
```

Grava em `0x2284828` e `0x228482c` — **exatamente os dois globais que A lê**.

**Isto é demonstrável e é a origem dos argumentos:** coordenadas de clique
normalizadas contra os limites do mapa.

---

## 3. Fatos versus hipóteses

### fatos

1. `0x37a320` (conversor) **não é** handler de teclado. Recebe **fração de posição**,
   não código de tecla.
2. `0x37bc40` exige `[r8] == 4` — uma **constante de tipo de evento**, não
   `WM_KEYDOWN` (0x100) nem `VK_*`.
3. `0x37bc40` e `0x37bd20` são alcançados **só por ponteiro** em `.rdata`.
4. A cadeia completa é: fração de clique → direção 0..7 → `[rcx+0xb4]` →
   `Game::walk`.
5. Existe um segundo caminho para C: o wrapper `0x7b6346` com throttle
   (`[rbx+0xbf8]`), que **não** passa por A nem B.

### hipóteses (não provadas)

1. Que o **teclado** use outro caminho — não observamos o caminho do teclado.
   Pode usar o wrapper, pode usar algo não mapeado.
2. Que o **clique no mapa** seja o único alimentador de `0x37bc40`. O tipo 4 é
   compatível, não exclusivo.
3. Autowalk: não investigado nesta rodada.

**Não nomeio A como handler de nada.** O que os bytes mostram é
"converte fração de posição em direção".

---

## 4. Por que as coletas anteriores deram zero hits — agora explicável

Você apertou **seta**. O caminho que mapeamos reage a **clique no mapa**. Se o
teclado usa o wrapper `0x7b6346` (que chama C diretamente, sem passar por A nem
B), então:

- A: nunca dispara com teclado ✓ (esperado)
- B: nunca dispara com teclado ✓ (esperado)
- C: **deveria** disparar pelo wrapper — mas não disparou

Resta uma inconsistência real: C não disparou, e o wrapper chama C. Hipóteses
para isso: (a) o wrapper também não é o caminho do teclado; (b) o throttle
`[rbx+0xbf8]` barrou; (c) o `0xCC` não estava presente. **Não resolvida.**

---

## 5. O que falta no artefato

Não falta código: o módulo lê inteiro (104 MB). O que falta é:

| lacuna | pergunta que responderia |
| :--- | :--- |
| quem invoca os ponteiros de `0x1f899f0` / `0x1f89ad0` | qual dispatcher de evento chama o tipo 4 |
| qual é o tipo de evento 4 | é clique, é script, é autowalk? |
| o caminho do **teclado** | `WM_KEYDOWN` → direção → ? |

Para ler isso eu precisaria de **rastreamento dinâmico do dispatcher**, não de
mais desmontagem estática. Isso é o limite honesto desta rodada.

---

## 6. Próxima ação que produz informação nova

**Não é `ba e1` numa thread presumida.** O que produz informação nova:

**Observar o dispatcher de eventos**, não o consumidor. O ponto de observação
com fundamento é `0x37bc40` **e** `0x37bd20` (os dois callbacks), porque ambos
são registrados por ponteiro e reagem ao tipo 4.

- **Cobertura se usar `ba`:** uma thread por vez, escolhida por evidência
  (a que executa o callback), não por "tem janela".
- **O que um resultado negativo NÃO excluiria:** que outro callback (outro
  slot da tabela) trate o mesmo evento; que o teclado use caminho distinto.

**Alternativa estática, mais barata:** procurar em `.rdata` a tabela inteira
de callbacks ao redor de `0x1f899f0` e identificar os outros slots — isso
mapeia quantos handlers existem para eventos de mapa, sem attach. É o próximo
passo que eu recomendaria **antes** de qualquer `ba`.

---

## 7. Correções ao relatório anterior (suas, aceitas)

| afirmação | correção |
| :--- | :--- |
| "`bl` prova instalação" | prova **cadastro/configuração**, não instalação efetiva verificada |
| "nenhum disparo" | **"nenhum disparo registrado"** |
| "thread da janela é a do movimento" | é **candidata**, não comprovada |
| "leitura pelo CDB sempre oculta o `0xCC`" | **depende do mecanismo e do contexto**; não generalizar |
| "RX prova imutabilidade" | RX é a proteção **naquele instante**, não prova imutabilidade |

---

## 8. Preservado

- logs originais
- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- tracer congelado `810A87FF…318B`
- 20/20

---

## 9. Tabela de callbacks adjacente (leitura adicional)

Ao redor de `0x1f899f0` há uma tabela contígua em `.rdata`:

| offset | destino | natureza |
| :--- | :--- | :--- |
| `0x1f899e0` | `0x37bd00` | callback |
| `0x1f899e8` | `0x37bd00` | callback (repetido) |
| `0x1f899f0` | `0x37bc40` | **nosso** (mapa, tipo 4) |
| `0x1f899f8` | `0x37bc30` | `lea rax,[..]; ret` — getter |
| `0x1f89a18` | `0x37bc20` | `lea rax,[..]; mov [rdx],rax; ret` — fábrica |
| `0x1f89a28` | `0x37bbb0` | lê `[+0x70/74/7c]` do mapa |
| `0x1f89a30` | `0x37bba0` | `lea rax; ret` — getter |

A presença de **getters (`lea; ret`) e fábricas (`mov [rdx],rax`) intercalados**
indica uma **vtable**, não uma lista de handlers de evento. Ou seja:
`0x37bc40` é um **método de classe**, não um handler de `WM_*`.

Isso reforça: a cadeia A/B/C pertence a um objeto de mapa/clique, não ao
caminho de teclado.

`0x37bfc0` é o único vizinho que testa flags (`test byte [rax+0x1a0], 0x20`),
sugerindo checagem de estado, não despacho de teclado.

---

## 10. Correções de inferência, aceitas

| afirmação anterior | correção |
| :--- | :--- |
| "`bl` prova instalação" | prova **cadastro/configuração**, não instalação efetiva verificada |
| "nenhum disparo" | **"nenhum disparo registrado"** |
| "thread da janela é a do movimento" | é **candidata**, não comprovada |
| "leitura pelo CDB sempre oculta o `0xCC`" | **depende do mecanismo e do contexto**; não generalizar |
| "RX prova imutabilidade" | RX é a proteção **naquele instante**, não prova imutabilidade |

## 11. Hardware breakpoint: cobertura e limite (se vier a ser usado)

Se `ba` for considerado no futuro, a declaração obrigatória:

- **threads:** uma por execução, escolhida por evidência de execução do
  callback — não por "possui janela";
- **o que um negativo NÃO exclui:** outro callback da vtable; outro caminho
  (o wrapper `0x7b6346`); que o evento tenha sido tratado por thread diferente;
- **interferência:** `ba` não altera código, mas **suspende nada** e ocupa um
  slot de DR — que é **por thread** e conflita com qualquer outro depurador.
  Não presumir ausência de interferência por não alterar bytes.
