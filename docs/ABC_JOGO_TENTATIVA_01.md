# Coleta ABC no jogo — tentativa 01

Data: 2026-11-09
Resultado: **zero hits em A, B e C, com os três breakpoints verificados e
movimento confirmado durante a janela.**

---

## 1. Configuração efetiva (`bl`, antes do `g`)

```
0 e 00007ff6`43f163d0  /1 0001 (0001)  0:****  PokeAlliance_dx+0x7463d0   [A]
1 e 00007ff6`43f1742a  /1 0001 (0001)  0:****  PokeAlliance_dx+0x74742a   [B]
2 e 00007ff6`43f50c90  /1 0001 (0001)  0:****  PokeAlliance_dx+0x780c90   [C]
```

- os três **habilitados** (`e`)
- flag `/1` (disparo único) em todos
- `0:****` = **todas as threads**, sem restrição
- endereços conferidos: `base 0x7ff6437d0000` + RVA = VA listado

Pré-checagem imediatamente antes: A `4055535657415441`, B `e861980300`,
C `48895c2408555657`; B→destino calculado `0x780c90`. Sem módulo nosso,
sem depurador concorrente.

---

## 2. Cronologia

| UTC | evento |
| :--- | :--- |
| 00:22:54 | driver inicia |
| 00:22:55 | `bl` confere os três; **READY** |
| 00:22:55–00:23:15 | janela de 20 s — **movimento confirmado** |
| 00:23:15 | interrupção operacional (`Ctrl+Break`) |
| 00:23:15 | `r rip` = `0x7ff9da183f40` = `ntdll!DbgBreakPoint` |
| 00:23:15 | `.lastevent` = `Break instruction exception - code 80000003` |
| 00:23:15 | `bc *` → `.detach` → `Detached` |

**Nenhuma linha `[A]`, `[B]` ou `[C]` no log.** Nenhum `Hit breakpoint`.

---

## 3. Pontos atingidos

**Nenhum.**

| ponto | RVA | hit |
| :--- | :--- | :--- |
| A entrada | `0x7463d0` | **não** |
| B call | `0x74742a` | **não** |
| C destino | `0x780c90` | **não** |

Sem TIDs, sem argumentos, sem pilhas — não houve evento para registrar.

---

## 4. Confirmação visual

Você confirmou: **andou durante a janela.**

---

## 5. Limpeza e continuidade

| verificação | resultado |
| :--- | :--- |
| A `+0x7463d0` | `4055535657415441` — **restaurado** |
| B `+0x74742a` | `e861980300` — **restaurado** |
| C `+0x780c90` | `48895c2408555657` — **restaurado** |
| cliente | vivo, PID 28308, mesma instância (`19:50:39Z`) |
| threads | 67 |
| cdb | encerrado, sem órfãos |

Log: `local-data/cdb-tests/abc-game-01/cdb-console.txt` (167 linhas).

---

## 6. O que isso permite concluir

**Permitido:**

> Nessa janela, com A, B e C armados, habilitados, em todas as threads, e com
> movimento confirmado, **nenhum dos três pontos foi executado**.

Isso é consistente com a tentativa 03 (C não disparou com movimento) e
**estende** o resultado: nem a entrada candidata A, nem o call site B, nem o
destino C foram atingidos.

**Não permitido:**

- dizer que "o caminho é outro, comprovado" — não observamos qual caminho foi;
- dizer que `Game::walk` não é usado pelo jogo em absoluto — só que **não foi
  observado nesta janela**;
- declarar scheduler, thread safety, background ou minimizado.

---

## 7. Lacuna específica (importante)

**Não há prova de que o `0xCC` permaneceu durante os 20 s.** O `bl` foi lido
**antes** do `g`; nenhum `bl` foi executado **durante** a janela.

Se o cliente verifica integridade da `.text` ou reescreve a página, o
breakpoint pode ter sido removido silenciosamente. Isso explicaria zero hits
sem que o caminho seja outro.

**Não testei essa hipótese.** Ela é a primeira candidata a explicar o
resultado antes de assumir "o teclado não usa esses pontos".

---

## 8. Próxima ação mínima

A pergunta que os dados deixam aberta: **o breakpoint sobreviveu à janela, ou
foi removido?**

Teste mais barato, sem attach novo:

1. Antes de anexar, ler os bytes dos três pontos (feito, baseline).
2. Anexar, instalar, `bl` (verificado).
3. **Durante** a janela, executar `bl` periodicamente — mas isso exige um
   script com laço, que não temos e não vamos improvisar.

**Alternativa sem laço:** instalar os breakpoints e, ao **fim** da janela
(antes do `bc *`), rodar `bl` de novo. Se os três ainda aparecerem, o `0xCC`
sobreviveu e o caminho realmente não passou por eles. Se sumiram, o cliente
removeu.

Custo: um comando a mais (`bl` duplicado no script, um antes do `g` e um no
bloco de classificação). Não é infraestrutura nova — é o mesmo comando em
outro ponto.

Se o `bl` final mostrar os três vivos → **hipótese do caminho alternative
ganha força forte**, e o próximo passo seria localizar o caminho real a partir
do input (sem breakpoint em `Game::walk`).

Se o `bl` final mostrar vazio → **anti-tamper** é a explicação, e a conclusão
muda completamente.

---

## 9. Preservado

- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- tracer congelado `810A87FF…318B`
- 20/20
- logs das tentativas 01–03 e ensaios anteriores, intocados
