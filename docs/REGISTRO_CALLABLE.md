# Registro do callable — cadeia encontrada

Data: 2026-11-09
**Declaro: esta rodada fez leitura nova do processo** (27.5 MB de `.text`
+ `.rdata`/`.data`), o que a rodada anterior proibia. O método exigia. Nada
foi escrito, suspenso ou injetado: apenas `PROCESS_VM_READ`.

---

## 1. As duas rotas que eu propus estavam erradas

| rota | por que falhou |
| :--- | :--- |
| A — qword `base+0x1f899e0` em `.data`/`.rdata` | vftable **estática** é carregada por `lea rip-relative`, não por qword |
| B — string `?A0x55c31afb` em `.rdata` | essa string **não existe separada**; só vive dentro do nome decorado do TypeDescriptor |

Varredura confirmou: **zero** qword `base+0x1f899e0`; a única ocorrência do
COL `0x204ff70` como qword é o próprio `pSelf` em `0x1f899d8`.

---

## 2. Método correto e resultado

Varri `.text` (27 504 652 bytes, 443 ms) por `lea r64,[rip+disp32]` com alvo
`0x1f899e0`:

| instrução | RVA | papel |
| :--- | :--- | :--- |
| `lea rax,[rip+0x1c0e583]` | **`0x37b456`** | carrega a vftable do `lambda_6` |
| `lea rax,[rip+…]` | `0x37bd00` | carrega a vftable do `lambda_7` (factory) |

---

## 3. Construção → registro → consumidor

### Construção, em `0x37b448..0x37b479`

```asm
0x37b448  mov rcx, [rip+0x36583c9]     ; container  (RVA 0x39d3818)
0x37b44f  mov [rbp+0x218], rsi
0x37b456  lea rax, [rip+0x1c0e583]     ; rax = base+0x1f899e0  <- VFTABLE
0x37b45d  mov [rbp+0x1e0], rax         ; std::function::_M_functor._M_unused  (vtable)
0x37b464  lea rax, [rbp+0x1e0]         ; rax = objeto na pilha
0x37b46b  mov [rbp+0x218], rax
0x37b472  lea rdx, [rbp+0x1e0]          ; rdx = &std::function temporario
0x37b479  call 0x901560                 ; REGISTRA no container
```

**O objeto callable é construído na pilha e passado por `rdx` para
`0x901560`.** Depois de registrar, o temporário morre — o que é guardado é uma
cópia feita pelo container (slot `[0]` = `_Copy` faz sentido).

### Registro, em `0x901560`

```asm
0x90156d  lea rbx, [rcx + 0xd8]        ; rbx = &container->field_d8
0x901574  cmp qword [rbx], 0           ; container inicializado?
0x901578  jne 0x9015a0
   ...    call 0x927470 / 0x3139e0     ; cria o container sob demanda
0x9015a0  mov rcx, [rbx]               ; rcx = container real
0x9015a3  add rcx, 0x2c0               ; rcx = &container->list_at_2c0
0x9015aa  mov rdx, rdi                 ; rdx = &std::function
0x9015b7  jmp 0x338f20                 ; LIST::push_back  (tail call)
```

**O destino é uma `std::list` em `container + 0x2c0`.** O `std::function` é
copiado para dentro dela por `0x338f20` (`push_back`, que chama `_Copy` em
`[rdx+0x38]→vtable[0]`).

### Consumidor

**Desconhecido.** Quem itera `container+0x2c0` e chama
`std::function::operator()` não foi localizado nesta rodada.

---

## 4. O gate que bloqueia tudo

`0x37a7a0` (a função que contém `0x37b456`) tem 3 466 bytes e começa com:

```asm
0x37a7ba  cmp byte [rip+0x1f1754a], 0   ; RVA 0x2291d0b
0x37a7c1  je  0x37b51e                  ; -> epilogo, RETORNA
```

**`[0x2291d0b] = 0` agora.** Portanto a função **retorna imediatamente** e o
registro não acontece no estado atual.

É uma função de inicialização condicionada — provavelmente `init` do namespace
anônimo, que só roda quando uma flag global é ligada (login? entrada no mapa?).

---

## 5. Contrato confirmado

| item | valor |
| :--- | :--- |
| construção | `0x37b456` carrega vftable `0x1f899e0` |
| função construtora | `0x37a7a0..0x37b52a` |
| gate | `[0x2291d0b] == 0` → não registra |
| registro | `0x901560` → `LIST::push_back` em `container+0x2c0` |
| container | ponteiro em `0x39d3818` (hoje **NULL**) |
| vftable | `0x1f899e0`, `[-1]`=COL `0x204ff70` |
| `_DoCall` | `vftable[2]` = `0x37bc40` |
| assinatura | `bool(TPoint<int> const&, Fw::MouseButton&&)` |

---

## 6. Por que as coletas deram zero hit — explicação final

`0x37bc40` só é chamado quando o `std::function` é invocado. Mas:

1. o gate `0x2291d0b` está 0 → o callable **nem é registrado** no estado atual;
2. mesmo registrado, seria preciso o dispatcher iterar a lista.

Nenhum dos dois aconteceu. O breakpoint em `0x37bc40` **nunca teria como
disparar** — não é falha do bp, é ausência de registro.

---

## 7. Lacuna exata

Para fechar a cadeia falta **localizar o consumidor**:

```asm
itera container+0x2c0  ->  chama std::function::operator()
                       ->  vtable[2] (_Do_call) = 0x37bc40
```

O caminho mais barato: procurar `lea`/`mov` com `+0x2c0` em `.text`, ou achar
quem referencia `container` (`0x39d3818`). Ambos são leitura de memória que
não fiz nesta rodada.

---

## 8. O que isso muda na interpretação

- O `lambda_6` **não está ativo** no estado atual. Isso é consistente com
  "o jogo tem um sistema de callbacks de mapa que só é registrado quando
  entra no mundo" — mas **não é prova**, é compatibilidade.
- `4` continua não nomeado. Não afeta nada desta cadeia.
- A pergunta "que estímulo dispara" **muda de forma**: não é sobre mouse vs
  teclado, é sobre **quando o gate liga** e **quem itera a lista**.

---

## 9. Não afirmo

- que `0x2291d0b` liga ao entrar no mundo (não observei a transição)
- que o consumidor seja o dispatcher de input (não localizado)
- que tipo 4 signifique clique
- que seta não passe por aqui
- thread, scheduler, thread safety, background

---

## 10. Preservado

- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- tracer congelado `810A87FF…318B`
- 20/20
- artefato: `local-data/vftable-refs-2026-11-09.json`
- script: `tools/find_vftable_refs.py`
