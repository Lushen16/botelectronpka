# Verificação independente — rodada 15

Data: 2026-11-06. Somente leitura. Nenhuma execução, chamada, injeção, hook,
suspensão, movimento ou alteração de foco.

Verifiquei as três correções do relatório `native-walk-20261106/RELATORIO.md`
com medição própria no cliente (PID 21900, `PokeAlliance - Usobot`, no mundo).

---

## 1. As três correções: CONFIRMADAS

### 1.1 O objeto é `LocalPlayer` / `ProtocolGame`, não `Game`

RTTI lido por `vtable → COL → TypeDescriptor`:

```
[base+0x39c7268] va=0x29618ae5300 vtable=0x7ff6aa8717d0  .?AVLocalPlayer@@
[base+0x39c72a8] va=0x2967e6870a0 vtable=0x7ff6aa86aff8  .?AVProtocolGame@@
[LocalPlayer+0x9a8] va=0x29603b6c410 vtable=0x7ff6aa869210  .?AVTile@@
```

**Correção aceita.** Meu documento anterior tratava tudo como "objeto Game".
O handler chama `Game::walk` (a string), mas os objetos são de outras classes.

### 1.2 O gate estava lido errado

Recalculei o fluxo com os valores atuais:

```
ProtocolGame: +0x40=0  +0x24=1963560364  +0x20=0  +0x68=0
gate correto   -> (p40 != 0) ? (p20==0)
                : (p24 != 0) ? (p20==0)
                : (p68 == 0) ? false
                : ([[p68]+0x3d0] != 0)
             = true      (porque p24 != 0 e p20 == 0)

criterio antigo (todos juntos) = false
```

**Correção aceita.** O critério anterior **rejeitaria** o objeto real. O fluxo
real **aprova**. Os `jne` em `0x88ec25`/`0x88ec2b` saltam para `0x88ec42`
(caminho alternativo), não para falha.

Confirmei os larguras pelos `cmp`: `+0x40` QWORD, `+0x24` DWORD, `+0x20` BYTE,
`+0x68` QWORD.

### 1.3 Não há prova de "fila de pacotes"

Medi o par:

```
[LocalPlayer+0x9a8] = 0x29603b6ac50  (Tile)
[LocalPlayer+0x9b0] = 0x29603b6ac40  (bloco de controle)
diferença = 16 bytes  (bloco antes do objeto)
refcount = 3, 2
```

O layout `bloco(0x0) | objeto(+0x10)` com contadores em `+8/+0xc` e
`lock inc` no epílogo é **par de `shared_ptr<Tile>`**, não head/tail de fila.

**Correção aceita.** Meu "enfileira" anterior estava errado. O handler
**substitui a propriedade de um Tile** — provavelmente o tile de destino do
caminho.

---

## 2. O alvo de continuação: CONFIRMADO, e é código ofuscado

Cadeia verificada ao vivo:

```
ProtocolGame vtable (0x1faaff8) + 8
  -> 0x80f6b0   jmp (thunk)
  -> 0x88ec50   jmp (thunk)
  -> 0x41a37c7  corpo
```

Bytes em `0x41a37c7`:

```
48 89 5c 24 18 66 d3 fb 55 56 40 8a f0 0f ba f0 b3
d2 e0 57 e9 1c 00 00 00 b1 b6 7a 20 0c a4 f5 25 ...
```

| sinal | resultado |
| :--- | :--- |
| bytes distintos em 64 | **51** |
| strings num raio de 0x400 | **0** |
| `jmp rel8` para meio de instrução | sim (`e9 1c 00 00 00` para `0x41a37fc`) |
| entrada em `.pdata` | **não há** |

Não há entrada `.pdata`, o que é anômalo: funções compiladas normalmente têm.
Junto com a densidade de bytes e ausência de strings, isso indica
**região de código ofuscado/protegido** — consistente com as seções estranhas
do módulo (`.ny1`, `.$:`, `.*>C`).

Portanto `0x41a37c7` não é analisável por disassembly linear confiável. O
relatório está certo ao dizer que o comportamento completo é desconhecido.

---

## 3. O que isso significa para a implementação

### O que já está resolvido

| item | estado |
| :--- | :--- |
| objeto (`ProtocolGame`) | **identificado por RTTI** |
| `LocalPlayer` | identificado por RTTI, com posição e hp legíveis |
| gate | **lido corretamente**; aprova o objeto real |
| direção | 0..7, tabela de 8 opcodes |
| `R8B` | **0**, determinado pelo único chamador conhecido |
| pré-condição de sessão | `[0x39c7268] != 0` e `[+0xb0] > 0` |

### O que continua bloqueado

O **caminho virtual** `ProtocolGame+8` termina em código ofuscado. Não sei:
- se ele envia sincronamente ou delega;
- se é thread-safe;
- qual thread o chama naturalmente.

Chamar `Game::walk` de uma thread do pipe, sem saber isso, tem risco real:
- o `shared_ptr<Tile>` tem `lock inc` (atômico), mas a substituição **do par**
  em `+0x9a8/+0x9b0` não é atômica como conjunto — pode haver janela de corrida;
- se `ProtocolGame` tiver afinidade de thread (típico em cliente de jogo), a
  chamada de outra thread pode corromper estado.

**Não é fundamentado disparar da thread do pipe.** Concordo com o relatório.

---

## 4. Caminhos possíveis agora

### A) Observação dinâmica limitada (precisa autorização)

Determinar empiricamente a thread que chama `ProtocolGame+8`:

- ferramenta: enumerar threads do PID + `GetThreadStartAddress`; se necessário,
  um hook de leitura em `0x41a37c7` que apenas registra `GetCurrentThreadId`
  (não altera comportamento);
- duração: um passo manual de caminhada no jogo, observado;
- efeito: hook é intromissão no processo. Sem ele, só enumeração (inócua).
- pergunta: qual thread executa o envio? ela sobrevive a minimizar?

Este é o menor caminho para desbloquear. Mas **hook exige autorização
explícita** e eu não faço sem ela.

### B) Chamada na thread do jogo via injeção de thread única

Em vez de chamar do pipe, a DLL posta o comando numa fila própria e usa
`SetThreadContext`/`QueueUserAPC` na thread do jogo. Resolve a afinidade, mas
exige saber qual thread — volta ao item A.

### C) Declarar background bloqueado e parar

Honesto, mas prematuro: falta **uma** observação, não uma parede.

---

## 5. Recomendação

Fazer **A** na forma mínima: só enumeração de threads (inócua, sem hook),
tentando casar com o `ProtocolGame` da sessão. Se isso não responder, então
propor o hook de leitura com autorização específica, escopo e rollback.

Enquanto isso, as duas pendências funcionais seguem **separadas e abertas**:

- B: motor corrigido sem overshoot no cliente;
- executor nativo: não implementado.

Nenhuma delas foi promovida nesta rodada.
