# RTTI confirmado — os três lambdas e o `MouseButton`

Data: 2026-11-09
Escopo: verificação offline + **uma** leitura de 768 bytes. Sem depurador,
breakpoint, injeção ou input.

---

## 1. Hipótese RTTI: **CONFIRMADA**

Revalidei os três CompleteObjectLocators no processo vivo (PID 19400,
base `0x7ff7774c0000`) antes de ler os TypeDescriptors:

| registro | `+0x00` sig | `+0x14` pSelf | `base+pSelf == próprio` | `+0x0c` pTypeDesc |
| :--- | ---: | ---: | :--- | ---: |
| reg0 `0x204ff70` | **1** | `0x204ff70` | **sim** | `0x22fe590` |
| reg1 `0x204fca8` | **1** | `0x204fca8` | **sim** | `0x22fe6e0` |
| reg2 `0x204fbf0` | **1** | `0x204fbf0` | **sim** | `0x22fe610` |

E o ClassHierarchyDescriptor de reg1 (dentro da janela já lida, em `+0x28`):

```
signature=0   attributes=0x0   numBaseClasses=2   pBaseClassArray=0x204ffc8
```

`signature=0` é exatamente o esperado para `RTTIClassHierarchyDescriptor`.
O layout é **RTTICompleteObjectLocator do MSVC x64**, 24 bytes.

**Sua leitura estava certa e a minha anterior estava errada** — eu li os
termos como DWORDs de uma "estrutura própria" quando na verdade era RTTI
padrão. Os 64 bytes que eu li eram **24 do COL + 40 de outra coisa**.

### Distinção que eu havia misturado

| coisa | largura | onde |
| :--- | :--- | :--- |
| slots da tabela original (`0x37bc40` etc.) | **qword** | `0x1f899d8`.. |
| campos RTTI (COL) | **DWORD** | `0x204ff70`.. |

São estruturas **diferentes**, com larguras diferentes. Não houve erro de
largura na tabela — só na minha leitura dos COLs.

**`pSelf` não é elo de lista.** É campo obrigatório do ABI; todo COL aponta
para si mesmo. Minha inferência de "registro encadeado" cai.

---

## 2. Leituras realizadas

Artefato: `local-data/rtti-typedescriptors-2026-11-09.json`

| TypeDescriptor | RVA | pedido | lido | ok |
| :--- | :--- | ---: | ---: | :--- |
| reg0 | `0x22fe590` | 256 | 256 | sim |
| reg1 | `0x22fe6e0` | 256 | 256 | sim |
| reg2 | `0x22fe610` | 256 | 256 | sim |

**Orçamento 768 bytes, lidos 768.** Zero falhas. Nome com terminador em todos.

---

## 3. Nomes recuperados (completos, sem simplificar)

```
reg0: .?AV?$_Func_impl_no_alloc@V<lambda_6>@?1??init@?A0x55c31afb@@YAXXZ@_NAEBV?$TPoint@H@@W4MouseButton@Fw@@@std@@
reg1: .?AV?$_Func_impl_no_alloc@V<lambda_7>@?1??init@?A0x55c31afb@@YAXXZ@_NAEBV?$TPoint@H@@AEBV4@@std@@
reg2: .?AV?$_Func_impl_no_alloc@V<lambda_2>@?1??init@?A0x55c31afb@@YAXXZ@X$$V@std@@
```

`pVFTable` idêntico nos três: `0x7ff778f34008` (type_info de instanciação do
template — esperado para o mesmo template com args diferentes).

### Decodificação

| reg | assinatura do lambda | papel |
| :--- | :--- | :--- |
| 0 | `bool(TPoint<int> const&, Fw::MouseButton)` | **evento de clique** |
| 1 | `bool(TPoint<int> const&, TPoint<int> const&)` | dois pontos |
| 2 | `void()` | sem argumentos |

Todos são `?1??init@?A0x55c31afb` — lambdas capturados em um `init()` de
namespace anônimo.

---

## 4. O que isso resolve e o que não resolve

### resolve

1. **A estrutura era RTTI**, não um formato proprietário.
2. **O primeiro argumento de reg0 é `Fw::MouseButton`** — um enum de
   **botão de mouse**. Isso é evidência direta, não inferência de "tipo 4".
3. `TPoint<int>` é coordenada. Confirma a leitura espacial do relatório
   anterior.
4. Os três são `std::function` wrappers (`_Func_impl_no_alloc`), não vtables
   de classe do jogo.

### não resolve

1. **O valor 4 continua não nomeado.** `Fw::MouseButton` é o **tipo** do
   argumento, não o valor 4. "4" pode ser botão direito, botão do meio, ou
   qualquer coisa — não sei o enumerador.
2. **Não prova que este é o caminho do teclado.** Prova que existe um callback
   com assinatura de mouse. Seta pode usar outro.
3. **`0x37bc40` é o handler de qual desses três?** Não mapeei o slots
   `+0x18` da tabela para os COLs. A relação tabela→COL ainda não está
   demonstrada.
4. Não identifica thread.

---

## 5. Relação com a tabela original — o que dela se sabe

| fato | evidência |
| :--- | :--- |
| tabela tem registros de 7 qwords (0x38) | strides `0x38` duas vezes |
| `+0x18` aponta para `0x37bc40` (reg0) e `0x37bbb0` (reg1) | lido |
| os COLs estão em `0x204ff70`, `0x204fca8`, `0x204fbf0` | lido |
| **o vínculo tabela→COL é desconhecido** | não lido |

Os COLs não estão nos registros da tabela. São estruturas **separadas**, em
`.rdata`. Quem os associa aos slots é o código que ainda não mapeei.

---

## 6. O "tipo 4" revisitado

Com `Fw::MouseButton` agora conhecido como **tipo de argumento**, a leitura
muda:

- `0x37bc40` compara `[r8] == 4` — se `r8` aponta para o **enum**
  `MouseButton`, então `4` seria um **valor do enum**.
- Isso é compatível com "botão 4" ou "quarto botão".
- **Não é compatível** com `WM_*` (que seria 0x100+).

Isso **fortalece** a hipótese de mouse e **não** prova qual botão.

---

## 7. Próxima ação diretamente ligada

**Ler o enum `Fw::MouseButton`.** Um enum C++ com 4 membros teria os valores
0..3; se houver valor 4, é um quinto membro.

O caminho barato: o TypeDescriptor de `Fw::MouseButton` está em algum lugar;
procurar `.?AW4MouseButton@Fw@@` em `.rdata` daria o RVA, e ler os usos
daria os enumeradores. **Isso exige uma leitura nova** — não faço sem
autorização.

Alternativa mais direta: os três COLs de `_Func_impl_no_alloc` têm
`pClassDescriptor` com `numBaseClasses=2`. O `pBaseClassArray` em
`0x204ffc8` apontaria para os COLs base — que é como se liga o lambda ao tipo
do argumento. **Mas isso não nomeia o valor 4.**

**O que realmente fecha:** localizar onde `4` é comparado e o que o código faz
nos outros ramos. Isso é análise de `0x37bc40` já lida — a comparação é a
**primeira instrução**, e o ramo é só "igual ou retorna 0".

---

## 8. Não afirmo

- que tipo 4 significa clique esquerdo/direito (não sei qual membro)
- que o caminho do teclado passa por C ou não
- que a tabela de 7 qwords seja de eventos (continua candidata)
- que `0x37bc40` corresponda a um dos três COLs (vínculo não lido)
- thread, scheduler, thread safety, background

---

## 9. Preservado

- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- tracer congelado `810A87FF…318B`
- 20/20
- todos os artefatos anteriores
- novos: `tools/verify_rtti_offline.py`, `tools/read_rtti_typedescriptors.py`
