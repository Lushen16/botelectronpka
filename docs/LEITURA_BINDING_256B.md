# Leitura de 256 bytes — análise dos registros

Data: 2026-11-09
Escopo: **uma leitura de memória de 256 bytes.** Sem depurador, breakpoint,
injeção ou input.

---

## 1. Revalidação (instância trocou)

| item | valor |
| :--- | :--- |
| PID da rodada anterior | 28308 → **morto** |
| PID atual | **19400** |
| criado | **2026-11-09T01:46:39Z** |
| base | **`0x7ff7774c0000`** (nova) |
| tamanho | 103645184 |
| A `+0x7463d0` | `4055535657415441` ✓ |
| B `+0x74742a` | `e861980300` ✓ |
| C `+0x780c90` | `48895c2408555657` ✓ |
| **15 slots da tabela** | **idênticos** (mesmos RVAs) |

Nenhum endereço absoluto histórico foi reutilizado. A tabela é **reproduzível
entre instâncias** — os RVAs não mudam, só a base.

---

## 2. Leituras realizadas

Artefato: `local-data/binding-read-2026-11-09.json`

| nome | RVA | pedido | lido | ok | err |
| :--- | :--- | ---: | ---: | :--- | ---: |
| descriptor_reg0 | `0x204ff70` | 64 | 64 | sim | 0 |
| descriptor_reg1 | `0x204fca8` | 64 | 64 | sim | 0 |
| descriptor_reg2 | `0x204fbf0` | 64 | 64 | sim | 0 |
| shared_util_1 | `0x318930` | 32 | 32 | sim | 0 |
| shared_util_2 | `0x3186c0` | 32 | 32 | sim | 0 |

**Orçamento 256 bytes, lidos 256.** Zero falhas. Bytes brutos salvos em hex
no JSON; nenhuma lacuna preenchida com zeros.

---

## 3. Descoberta que muda a interpretação

**Os campos dos descritores são DWORD (32 bits), não ponteiros de 64 bits.**

O relatório anterior tratou os 64 bytes como 8 ponteiros de 8 bytes e
"encontrou" valores como `0x204ff700204ff18` — que é **dois RVAs adjacentes**
lidos juntos, um artefato do alinhamento errado.

Lendo como 16 DWORDs, o padrão é limpo e consistente nos três registros.

---

## 4. Estrutura identificada

```
+0x00  0x00000001                        constante 1 (todos os 3)
+0x04  0x00000000
+0x08  0x00000000
+0x0c  0x022fe590 / e6e0 / e610          RVA em .data   (distinto por tipo)
+0x10  0x0204ff18 / fcd0 / fa98          RVA em .rdata  (distinto)
+0x14  0x0204ff70 / fca8 / fbf0          RVA = o PROPRIO registro
+0x18..0x24  0                        zeros
+0x28  varia (fb00 / 0 / 22fe860)
+0x2c  varia (2049fc0 / 0 / 0)
+0x30  varia (0 / 2 / 0)
+0x34  varia (0 / 204ffc8 / 0xffffffff)
+0x3c  varia (0 / 0 / 0x40)
```

### O auto-ponteiro em `+0x14`

Os três registros contêm **o próprio endereço** em `+0x14`:

```
reg0: +0x14 = 0x204ff70  (== início do reg0)
reg1: +0x14 = 0x204fca8  (== início do reg1)
reg2: +0x14 = 0x204fbf0  (== início do reg2)
```

Isso é típico de estruturas que se registram numa lista encadeada ou que
guardam back-pointer para o descritor dono.

### Os utilitários compartilhados

```
0x3186c0:  lea rax, [rcx+8]      ; ret    <- 6 bytes, getter de offset +8
0x318930:  test dl, dl
           je 0x31893e
           mov edx, 0x10
           jmp 0xa15260
           0x31893e: ret
           0x318940: lea rax,[rip+..] ; ret   <- proxima funcao
```

`0x3186c0` é um **getter trivial**: retorna `this + 8`.
`0x318930` é um **destruidor/liberador condicional** (testa flag em `dl`,
chama `0xa15260`).

Os dois são **utilitários de objeto**, não específicos de movimento.

---

## 5. Classificação revisada — candidata, não conclusão

O que a leitura **sustenta**:

- os três registros têm **layout idêntico** nos primeiros 0x18 bytes
- `+0x14` é auto-referência em todos
- `+0x0c` e `+0x10` apontam para `.data` e `.rdata`, distintos por registro
- os campos `+0x28` em diante **divergem** (não são mais um padrão uniforme)

O que **continua candidato**:

| hipótese | status |
| :--- | :--- |
| tabela de descritores de tipo | **compatível**, não provada |
| estrutura de binding | **compatível** — auto-ponteiro sugere registro ligado |
| vtable com metadados adjacentes | **não descartada** |
| outra organização | não excluída |

**Dois espaçamentos iguais (0x38) sustentam um padrão local**, não delimitam a
tabela inteira. Há pelo menos 3 registros; o 4º em `0x1f89a80` não foi lido.

---

## 6. O que mudou a interpretação

| antes | agora |
| :--- | :--- |
| "8 ponteiros de 64 bits por registro" | **16 DWORDs; os ponteiros são RVAs de 32 bits** |
| valores como `0x204ff700204ff18` | artefato de alinhamento errado; são dois RVAs |
| "vtable" | auto-ponteiro em `+0x14` sugere **registro encadeado/auto-registrado** |
| "descritores de tipo" | **candidato**, agora com layout documentado |

---

## 7. Lacuna específica que permanece

**O valor 4 continua não nomeado.** Nada nos 256 bytes diz o que "tipo 4"
significa. Os descritores não contêm texto legível (nenhum byte ASCII
imprimível nos intervalos lidos).

Os campos `+0x0c` apontam para `.data` (`0x22fe590`, `0x22fe6e0`,
`0x22fe610`). **São candidatos a nome/tipo**, mas ler aqueles endereços
exigiria outra leitura — e você limitou a esta rodada a 256 bytes.

**Destinos que uma leitura adicional responderia:**

| RVA | o que esperar |
| :--- | :--- |
| `0x22fe590` | identificador do registro 0 (string? enum?) |
| `0x22fe6e0` | identificador do registro 1 |
| `0x22fe610` | identificador do registro 2 |
| `0x204ff18` / `0x204fcd0` / `0x204fa98` | dados auxiliares por registro |

Não segui esses ponteiros: o orçamento era 256 bytes.

---

## 8. Duas hipóteses sobre a origem do "tipo 4"

1. **`4` é índice na tabela.** O código lê `[r8]`, compara com 4, e usaria
   `tabela + 4*0x38 + 0x18` para chegar a `0x37bc40`. Verificação: se
   `0x1f899d8 + 4*0x38 + 0x18` apontar para `0x37bc40`, confirma.
   - cálculo: `0x1f899d8 + 0xe0 + 0x18 = 0x1f89ad0`. **E `0x1f89ad0` é
     exatamente o slot que aponta para `0x37bd20`** — não para `0x37bc40`.
   - então 4 **não** indexa essa tabela com esse stride.

2. **`4` é um tipo de evento comparado diretamente**, e `0x37bc40` é o handler
   registrado para ele em outro mecanismo. Isso é consistente com o
   auto-ponteiro em `+0x14`: o objeto se registra, e o dispatcher o encontra
   por essa referência.

A hipótese 2 é mais compatível com os dados. **Não é prova.**

---

## 9. Não afirmo

- que seja clique de mouse — `4` não é `WM_*`
- que a estrutura seja descritor de tipo — é candidata
- que C seja exclusivo desse caminho (o wrapper `0x7b6346` também chama C)
- que 256 bytes resolvam movimento ou background — não resolvem

---

## 10. Preservado

- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- tracer congelado `810A87FF…318B`
- 20/20
- logs e dumps originais
- novos: `tools/read_binding_structs.py` (leitor 256 B),
  `tools/interpret_binding32.py`, `tools/dump_binding_read.py`
