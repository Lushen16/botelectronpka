# Tabela de binding em `.rdata` — identificação

Data: 2026-11-09
Escopo: análise offline. **Nenhuma leitura nova do processo.**
Fonte: os 20 slots registrados na rodada anterior + artefatos em disco.

---

## 0. Identificadores (corrigindo a confusão)

| nome | endereço | papel | observação |
| :--- | :--- | :--- | :--- |
| **A** | `0x7463d0` | entrada candidata; grava `[rcx+0xb4]` e chama C | **inalterado** |
| **B** | `0x74742a` | a instrução `call 0x780c90` dentro de A | **inalterado** |
| **C** | `0x780c90` | `Game::walk` | **inalterado** |
| `0x37a320` | — | **conversor** fração→direção | **nunca foi A** |
| `0x37bc40` | — | calcula fração e chama o conversor | chamado por ponteiro |

Meu relatório anterior renomeou `0x37a320` como "A" no texto. Erro meu.
Corrigido em `docs/CADEIA_ABC_ESTATICA.md` com uma seção 0 fixando os nomes.

---

## 1. A estrutura: array de registros de 7 ponteiros (0x38)

Base do primeiro registro: `0x1f899d8`.

```
registro 0 @ 0x1f899d8
  +0x00  0x204ff70   .rdata   (dado)
  +0x08  0x37bd00    .text
  +0x10  0x37bd00    .text    (igual ao +0x08)
  +0x18  0x37bc40    .text    <- nosso
  +0x20  0x37bc30    .text
  +0x28  0x318930    .text
  +0x30  0x3186c0    .text

registro 1 @ 0x1f89a10
  +0x00  0x204fca8   .rdata
  +0x08  0x37bc20    .text
  +0x10  0x37bc20    .text    (igual ao +0x08)
  +0x18  0x37bbb0    .text
  +0x20  0x37bba0    .text
  +0x28  0x318930    .text    (COMPARTILHADO com reg 0)
  +0x30  0x3186c0    .text    (COMPARTILHADO com reg 0)

registro 2 @ 0x1f89a48
  +0x00  0x204fbf0   .rdata
  (demais campos fora dos dados coletados)
```

**Stride confirmado por dois intervalos independentes:**
`0x1f89a10 - 0x1f899d8 = 0x38` e `0x1f89a48 - 0x1f89a10 = 0x38`.

### Formato dos ponteiros

São **ponteiros absolutos de 64 bits** (`0x00007ff643b4bc40`), ajustados pelo
loader. Não são RVAs: os valores têm a base `0x7ff6437d0000` somada.

---

## 2. A classificação: tabela de descritores de tipo, não vtable

Revisando minha própria conclusão anterior. O que os dados sustentam:

| observação | implica |
| :--- | :--- |
| registro tem **7 campos**, não só funções | não é vtable (vtable é só funções) |
| `+0x00` aponta para `.rdata`, distinto por registro | **descritor/dado por tipo** |
| `+0x08 == +0x10` dentro do registro | par repetido — duas entradas iguais |
| `+0x18` difere por registro (`0x37bc40` / `0x37bbb0`) | handler específico |
| `+0x20` difere e é `lea rax,[..]; ret` | getter específico |
| `+0x28` e `+0x30` **idênticos entre registros** | funções **compartilhadas** |

**Conclusão revisada:** é uma **tabela de descritores de tipo de entidade**
(ou de evento), com campos de dado (`+0x00`), par de construtores
(`+0x08`/`+0x10`), handler (`+0x18`), getter (`+0x20`) e utilitários
compartilhados (`+0x28`/`+0x30`).

**Não é vtable:** uma vtable teria só ponteiros de função contíguos, sem o
campo de dado em `+0x00` e sem a repetição em `+0x08`/`+0x10`.

**Nós adicionamos essa nuance porque você apontou que getters/fábricas
vizinhos não bastam.** Antes eu disse "vtable"; os dados dizem "tabela de
descritores". A diferença importa: descritor tem **tipo**, e é o tipo que
seleciona a entrada.

---

## 3. O contrato de evento — o que está comprovado

### comprovado

1. `0x37bc40` exige `[r8] == 4` antes de qualquer trabalho (byte 1 da função).
2. `0x37bc40` lê `[r9]` e `[r9+4]` como **coordenadas inteiras** e os limites
   do mapa em `[rdx+0x70/0x74/0x78/0x7c]`.
3. Calcula duas frações e as grava em `0x2284828` / `0x228482c`.
4. `0x37a320` lê **exatamente esses dois globais** e converte em direção 0..7
   por meio de limiares `0.5 / 0.7 / 0.3`.
5. A direção entra em A (`0x7463d0`) e chega a C.

**Origem dos argumentos: comprovada.** São coordenadas espaciais (x, y) e
limites de mapa. A cadeia de dados é contígua e verificável nos bytes.

### não comprovado

1. **O significado de "tipo 4".** Não sei se é clique, script, autowalk ou
   outra coisa. O valor 4 é comparado, não nomeado.
2. **Quem invoca os ponteiros** da tabela. Não há `E8`/`E9` para `0x37bc40`
   nem `0x37bd20`; ambos vêm por ponteiro. O invocador seria o código que lê
   `[tabela + tipo*0x38 + 0x18]` e chama.
3. Que a tabela seja de **eventos**. Pode ser de **tipos de entidade**.

**Portanto:** "interação espacial por coordenadas" é hipótese forte e
sustentada. "Clique de mouse" continua **não provado** — 4 não é `WM_*`.

---

## 4. Lacuna exata

Falta a leitura de cinco intervalos que **não estão em disco**:

| intervalo | VA | pergunta que responderia |
| :--- | :--- | :--- |
| `0x204ff70..0x204ffb0` | `0x7ff64581ff70..b0` | descritor do registro 0 (nome/tipo?) |
| `0x204fca8..0x204fce8` | `0x7ff64581fca8..e8` | descritor do registro 1 |
| `0x204fbf0..0x204fc30` | `0x7ff64581fbf0..c30` | descritor do registro 2 |
| `0x318930..0x318950` | `0x7ff643ae8930..50` | utilitário compartilhado 1 |
| `0x3186c0..0x3186e0` | `0x7ff643ae86c0..e0` | utilitário compartilhado 2 |

**Por que não leio offline:** o `.exe` em disco é **empacotado** — `.text` e
`.rdata` têm `RawSize = 0`. O conteúdo real só existe na imagem carregada
(104 MB em memória vs 30 MB em disco). Não há dump do módulo atual em
`dumps/`.

**Isso é uma dependência real de runtime**, não uma limitação de análise
estática em geral.

---

## 5. Próxima ação discriminante

Duas opções, ambas exigem o conteúdo ausente:

**A. Ler os 5 intervalos** (200 bytes no total) do processo vivo — uma leitura
de memória, sem attach, sem breakpoint. Responde: qual é o nome/tipo do
descritor, e o que fazem os utilitários compartilhados.

**B. Encontrar o invocador da tabela** — procurar ponteiros para
`0x1f899d8` no módulo. Isso localiza o código que indexa por tipo. Também é
leitura de memória.

**A é mais barata e responde a pergunta do "tipo 4"** se o descritor contiver
um nome (RTTI ou string).

**Coleta futura com estímulo correto:** se a hipótese espacial se confirmar,
o estímulo seria **um clique curto no mapa**, não seta. Isso é um experimento
separado, com escopo próprio — um clique pode iniciar vários passos, e o
número de passos precisa ser controlado antes. **Não executar sem desenho
próprio.**

---

## 6. O que NÃO afirmo

- que seja clique de mouse (tipo 4 não é `WM_*`)
- que C seja exclusivo desse caminho (o wrapper `0x7b6346` também chama C)
- que o teclado não use C (não observamos o caminho do teclado)
- que a tabela seja de eventos (pode ser de tipos de entidade)
- que ausência de `E8` prove callback (prova apenas que é alcançado não por
  chamada direta)

---

## 7. Preservado

- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- tracer congelado `810A87FF…318B`
- 20/20
- logs e dumps originais intocados
- analisador novo: `tools/analyze_binding_table.py` (offline, não lê processo)
