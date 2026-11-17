# Cadeia fechada — e uma contradição concreta

Data: 2026-11-09
Escopo: análise offline dos artefatos. **Nenhuma leitura nova do processo.**

---

## 1. Cadeia estrutural: **FECHADA**

O "registro de 7 ponteiros" **é** uma vftable com `[-1] = COL`. Minha base
anterior (`+0x00` do registro) estava certa como **endereço do COL**, e o
**address point é `registro + 8`**.

### Elo a elo, com endereço, largura e valor

| # | elo | endereço | largura | valor |
| :--- | :--- | :--- | :--- | :--- |
| 1 | slot contendo `0x37bc40` | `0x1f899f0` | qword | `0x37bc40` |
| 2 | índice na vftable | `0x1f899e0 + 2*8` | — | **vftable[2]** |
| 3 | address point da vftable | `0x1f899e0` | — | `= registro + 8` |
| 4 | `vftable[-1]` = COL | `0x1f899d8` | qword | `0x204ff70` (RVA) |
| 5 | COL `+0x0c` = pTypeDescriptor | `0x204ff7c` | DWORD | `0x22fe590` |
| 6 | TypeDescriptor `+0x10` = nome | `0x22fe5a0` | bytes | `.?AV?$_Func_impl_no_alloc@V<lambda_6>...W4MouseButton@Fw@@@std@@` |

**Confirmado nos 3 registros:** `[-1]` aponta para COL conhecido
(`0x204ff70`, `0x204fca8`, `0x204fbf0`) — 3/3.

### Layout dos slots (papéis)

| slot | reg0 | reg1 | leitura |
| :--- | :--- | :--- | :--- |
| [0] | `0x37bd00` | `0x37bc20` | copy |
| [1] | `0x37bd00` | `0x37bc20` | move (mesma do copy) |
| [2] | **`0x37bc40`** | `0x37bbb0` | **`_Do_call`** |
| [3] | `0x37bc30` | `0x37bba0` | `_Delete_this` |
| [4] | `0x318930` | `0x318930` | **compartilhado** |
| [5] | `0x3186c0` | `0x3186c0` | **compartilhado** |

Ordem compatível com `_Func_base` do MSVC: `_Copy`, `_Move`, `_Do_call`,
`_Delete_this`. Slots 4-5 idênticos entre registros = base comum.

**`0x37bc40` é o `_Do_call` do callable `lambda_6`.**

---

## 2. Separação de identidades

| identidade | o que é | o que não é |
| :--- | :--- | :--- |
| `pVFTable` do TypeDescriptor (`0x7ff778f34008`) | type_info do template `_Func_impl_no_alloc` | **não** é vftable do objeto callable |
| vftable do callable (`0x1f899e0`) | slots copy/move/do_call/delete | não é o TypeDescriptor |
| `_Func_impl_no_alloc` | wrapper de `std::function` | não identifica o sistema de eventos |
| `<lambda_6>@?1??init@?A0x55c31afb` | definição em `init()` de namespace anônimo | **não** prova onde/como foi registrada |

O nome decorado associa a lambda a uma função `init`, não ao dispatcher.

---

## 3. Contrato do `_Do_call` — o `[r8]` está correto

Você pediu para não presumir que `r8` é enum por valor. Verifiquei: **não é**.

### Por que o código desreferencia `[r8]`

A assinatura é:

```cpp
_Func_impl_no_alloc<lambda_6, bool, TPoint<int> const&, Fw::MouseButton>
_Rx _Do_call(_Types&&... _Args)
```

`_Types...` = `{ TPoint<int> const&, Fw::MouseButton }`. Aplicando reference
collapsing:

| parâmetro | `_Types&&` colapsa para | passagem |
| :--- | :--- | :--- |
| `TPoint<int> const&` | `TPoint<int> const&` | ponteiro (rdx) |
| `Fw::MouseButton` | `Fw::MouseButton&&` | **referência** (r8) |

**O enum chega como *referência rvalue*, não por valor.** `r8` é ponteiro para
o enum. Por isso `cmp dword ptr [r8], 4` está **correto** — desreferencia para
ler o valor.

Consistente com o prólogo: `rdx` vai para `r9` (a coordenada é usada depois),
e `rcx` (`this`) **não é tocado** — lambda sem captura.

### O que isso muda

Minha "contradição" cai. O `== 4` lê o **valor** do enum via ponteiro. Se o
cliente tiver um quinto membro (fork/extensão), `4` existe e é lido
normalmente.

**Divergência com o upstream, não impossibilidade.** O enum do OTClient
público tem 0..3; este cliente pode ter mais. Não provo nem refuto o fork
sem evidência do cliente.

### Comparação com o irmão `reg1`

`lambda_7` é `bool(TPoint const&, TPoint const&)` — dois pontos.

```
0x37bbb0  mov r8, [rip+0x3657c61]   ; SOBRESCREVE r8 com um global
```

Aqui `r8` **não** é usado como argumento recebido: é sobrescrito. Isso é
coerente — nessa lambda o 2º parâmetro é `TPoint const&` (vai em `r8`), mas o
código imediatamente o substitui por um global antes de usar. **Nenhuma
contradição**; funções diferentes, fluxos diferentes.

### O que a assinatura sustenta e não sustenta

**sustenta:** callback recebendo posição e botão de mouse.

**não sustenta:** press / release / click / invocação por script. O `_Do_call`
não distingue — só recebe o botão e a posição.

## 4. Significado de 4: **desconhecido**

- Upstream tem 0..3. `4` **não existe** lá.
- RTTI comum **não armazena** nomes/valores de enum (sua correção está certa).
- O repo local não contém `MouseButton` nem `TPoint` fora dos meus próprios docs.
- `Extracted_Source` não tem essas classes.

**Mantenho "MouseButton com valor 4"** — sem nome simbólico.

O upstream tem 0..3, mas isso **não define** este cliente. Um fork pode ter
`MouseButtonX1 = 4`. A comparação é válida; o nome é que falta.

---

## 5. Construção → registro → consumidor: onde a cadeia para

### O que já está estabelecido

| elo | evidência |
| :--- | :--- |
| construção | o objeto é `_Func_impl_no_alloc<lambda_6,...>` — criado por `std::function` |
| vftable | `0x1f899e0` (address point), `[-1]` = COL `0x204ff70` |
| `_Do_call` | `vftable[2]` = `0x37bc40` |
| assinatura | `bool(TPoint<int> const&, Fw::MouseButton&&)` |
| armazenamento/registro | **DESCONHECIDO** |
| consumidor | **DESCONHECIDO** |
| dispatcher | **DESCONHECIDO** |

### O que falta, com precisão

Nenhum intervalo lido cobre os locais onde uma referência a `0x1f899e0`
poderia estar:

| alvo | coberto? |
| :--- | :--- |
| address point `0x1f899e0` | **não** |
| COL reg0 `0x204ff70` | sim (`descriptor_reg0`) |
| string `?A0x55c31afb` | **não** |
| `_Do_call 0x37bc40` | **não** (só o disasm textual) |

Total lido até agora: **1024 bytes** em 8 intervalos.

### Duas rotas, custos muito diferentes

**Rota A — varrer `.rdata` + `.data` por `(base + 0x1f899e0)` como qword.**

- intervalo: `0x1a3d000..0x226d04c` (8.6 MB) + `0x2274000..0x3a1b5f0` (24.8 MB)
- total: **33.4 MB**
- responde: quem guarda ponteiro para essa vftable (vtable estática? membro?)
- risco: muitas referências espúrias; precisa filtrar por contexto

**Rota B — achar `init@?A0x55c31afb`.**

O objeto é construído dentro dessa função (o nome decorado diz
`?1??init@?A0x55c31afb@@YAXXZ`). Achar `init` localiza o `emplace` do
`std::function`, que está a poucas instruções do registro.

- a string `?A0x55c31afb` existe em `.rdata` (referenciada pelo TypeDescriptor
  do namespace)
- ler a string dá a RVA; procurar xrefs a essa RVA dá `init`
- custo: uma varredura de `.rdata` por uma string de ~12 bytes, ~8.6 MB
- responde **direto**: onde a lambda é embrulhada em `std::function` e o que
  é feito com o objeto

**Rota B é mais barata e mais informativa.** A ainda diria "alguém guarda um
ponteiro", sem dizer quem nem para quê.

### O intervalo exato que falta (Rota B)

```
.rdata   RVA 0x01a3d000 .. 0x0226d04c    (8 609 868 bytes)
busca:   bytes "?A0x55c31afb"  (13 bytes ASCII)
resultado esperado: 1..N RVAs de string
depois:  xref a essa RVA -> endereco de init
```

Isso é uma **leitura nova** e não está autorizada nesta rodada.

---

## 5.1 Distinção que preservo

| papel | o que é | status |
| :--- | :--- | :--- |
| wrapper | `_Func_impl_no_alloc` + vftable `0x1f899e0` | identificado |
| consumidor | quem chama `_Do_call` (via `std::function::operator()`) | **desconhecido** |
| dispatcher | quem decide chamar esse `std::function` para um evento | **desconhecido** |

O primeiro chamador indireto **não é automaticamente** o dispatcher: pode ser
outro wrapper, um adapter, ou uma camada de binding.

## 6. Não afirmo

- que 4 seja `MouseLeftButton` ou qualquer membro (não existe no upstream)
- que o cliente seja fork (não verificado)
- que `_Do_call` seja chamado por clique (só a assinatura sugere)
- que o teclado use ou não esse caminho
- thread, scheduler, thread safety, background

---

## 7. Preservado

- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- tracer congelado `810A87FF…318B`
- 20/20
- fonte consultada: `github.com/edubart/otclient` `src/framework/const.h`
  (branch `master`, consultado 2026-11-09)
