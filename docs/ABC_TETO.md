# ABC com teto de registros — script final

Data: 2026-11-08
Escopo: ajuste do desenho. **Nenhuma anexação ao jogo.**

---

## 1. O problema do teto e a solução nativa

Você pediu teto de 10 registros. Testei o recurso nativo do CDB:

| tentativa | resultado |
| :--- | :--- |
| `bp /1` | **funciona**: dispara 1 vez e se auto-remove (`bl` fica vazio depois) |
| `bp /3` | **não existe**: `Unknown option ' '` — o `/N` só aceita `1` |

Portanto o teto global de 10 via contador exigiria `.if`, que **já crashou o
CDB** (`0xC0000005`, observado). Isso é exatamente o caso de fallback que você
autorizou:

> Se o teto exigir implementação nova ou não verificada, não improvisar:
> simplificar para breakpoints de disparo único por ponto.

**Adotado: `bp /1` nos três pontos = teto efetivo de 3 registros.**

### Limitação de correlação (declarada)

Com `/1`, cada ponto registra **no máximo uma vez**. Se a função for chamada
muitas vezes durante o toque, você vê apenas a **primeira** ocorrência de cada
ponto.

**Cada breakpoint é independente.** O auto-remover de A **não** desabilita B
nem C. Cada um tem seu próprio contador `/1` e dispara uma vez quando a
execução passa por ele. Não há ordem garantida entre os primeiros disparos.

Consequências, declaradas:

- Os primeiros hits podem pertencer a **invocações diferentes**. Um toque não
  garante que sejam a mesma.
- A→B→C na mesma thread é **correlação temporal**, não prova de invocação
  única.
- Se a ordem real for A, A, A… (chamadas repetidas), B e C podem nunca
  aparecer — e isso **não prova** que o caminho não passa por eles.
- O teto de 3 é mais restritivo que 10. Aceito em troca de não introduzir
  mecanismo não verificado.

---

## 2. Script final

`tools/cdb/walktrace-abc.txt` — ASCII puro, sem `//`:

```asm
.printf "=== WALKTRACE ABC BEGIN ===\n"
.time
bp /1 pokealliance_dx+7463d0 ".printf \"[A] tid=%x rip=%p\n\", $tid, @rip; kb; g"
bp /1 pokealliance_dx+74742a ".printf \"[B] tid=%x rip=%p rdx=%d r8=%d\n\", $tid, @rip, @rdx, @r8; g"
bp /1 pokealliance_dx+780c90 ".printf \"[C] tid=%x rip=%p rdx=%d r8=%d\n\", $tid, @rip, @rdx, @r8; kb; g"
bl
g
.echo "=== STOP CLASSIFY ==="
r rip
.lastevent
.echo "=== CLEANUP ==="
bc *
.echo "=== DETACH ==="
.detach
```

Nenhum `.if`. Nenhum comando de limpeza em contexto que já falhou. `.detach`
como último comando, forma já ensaiada.

### O que cada um registra

| ponto | RVA | TID | RIP | EDX/R8 | pilha |
| :--- | :--- | :--- | :--- | :--- | :--- |
| A | `0x7463d0` | sim | sim | — | **sim** (`kb`) |
| B | `0x74742a` | sim | sim | **sim** | — |
| C | `0x780c90` | sim | sim | **sim** | **sim** (`kb`) |

TID do sistema vem de `$tid` (funciona nesse contexto; só `$pid`/`$tid` dentro
de `.printf` com sintaxe errada falharam antes — aqui a sintaxe está validada).

---

## 3. Validação de sintaxe (auxiliar, sem anexar ao jogo)

```
bp /1 walktrace_target+15c6 "..."   ->  0 e ... /1 0001 (0001) 0:****
bp /1 walktrace_target+14c5 "..."   ->  1 e ... /1 0001 (0001) 0:****
bp /1 walktrace_target+1000 "..."   ->  2 e ... /1 0001 (0001) 0:****
bl -> SYNTAX_OK
```

Os três aparecem com flag `/1`, estado `e`, sem restrição de thread
(`0:****`).

---

## 4. Pré-validação da instância (feita agora)

| item | valor |
| :--- | :--- |
| PID | **28308** (único cliente) |
| criado | **2026-11-08T19:50:39Z** |
| base | `0x7ff6437d0000`, size 103645184 |
| **A** `+0x7463d0` | `4055535657415441` ✓ |
| **B** `+0x74742a` | `e861980300` ✓ |
| **C** `+0x780c90` | `48895c2408555657` ✓ |
| B → destino | `0x74742a+5+0x39861 = 0x780c90` ✓ |
| módulos nossos | nenhum (79) |
| depurador concorrente | nenhum |

Será revalidado imediatamente antes de anexar.

---

## 5. Riscos desta coleta

| risco | nota |
| :--- | :--- |
| apenas 3 registros | se a 1ª chamada não for a do toque, perde-se a informação |
| `bp` grava `0xCC` | removido no `bc *`; verificado 4× que restaura |
| pausa no attach | suspende threads por instantes |
| cliente encerra sozinho | não observado até agora; risco declarado |

Mitigação do primeiro: um **único toque**, para que a primeira chamada seja a
do movimento.

---

## 6. Entrega esperada

1. pontos atingidos e TIDs
2. pilha mais informativa
3. confirmação visual de movimento
4. limpeza e caminho do log
5. próxima ação sustentada pelos dados

Interpretação já fixada: B é um call site, não o único chamador de C (o wrapper
`0x7b6346` também chama). C sem B pode vir do wrapper — usar a pilha. A→B→C na
mesma thread é correlação, não prova de invocação única. Sem hits = resultado
limitado à cobertura.

---

## 7. Pedido de autorização

**Uma execução**, com `cdb -p <PID> -cf tools\cdb\walktrace-abc.txt`, um toque
breve, janela de 20 s, teto de 3 registros (`bp /1`).

Nada de `-o`, nada de `.if`, nada de encerrar cdb à força.
