# Auditoria do registro ABC — conclusão

Data: 2026-11-09
Escopo: auditoria de artefatos. Nenhuma anexação, injeção ou ação no jogo.

---

## 1. Achado: o registro **executou corretamente**; não houve defeito

Consultei o console completo (167 linhas), não só procurando `[A]/[B]/[C]`.

| verificação | resultado | linha |
| :--- | :--- | :--- |
| `Couldn't resolve` | **0** | — |
| `Syntax error` | **0** | — |
| `Bad format` | **0** | — |
| `Unknown option` | **0** | — |
| `Hit breakpoint` | **0** | — |
| `.printf` ecoado | 3× (comando), 0× (saída) | 132–134 |
| `bl` com 3 entradas `/1` `e` `0:****` | **sim** | 136–138 |
| `.time` | executou | 126–131 |
| `g` | executou | 139 |
| `r rip` / `.lastevent` | executaram | 145–149 |
| `bc *` / `.detach` | executaram, `Detached` | 152–156 |

**Não há defeito de registro.** Se um breakpoint tivesse disparado, o
`.printf` teria rodado — a sintaxe foi provada no auxiliar.

### Prova de que a expressão funciona

No ensaio auxiliar, **a mesma forma exata** disparou:

```
0:004> bp /1 walktrace_target+15c6 ".printf \"[A] tid=%x rip=%p\n\", $tid, @rip; kb; g"
[A] tid=83e8 rip=00007ff6090a15c6 ...
Last event: 2684.83e8: Hit breakpoint 2
```

`$tid` resolveu para `83e8`. Script e ensaio usam `$tid` 3× e **zero** `$pid`.
O erro antigo com `$pid`/`$tid` era a tentativa 02, cujo script era outro e que
falhou por **caminho de arquivo inexistente** — não por expressão.

### O que os cinco níveis distinguem

| nível | evidência neste caso |
| :--- | :--- |
| (a) bp **cadastrado** | `bp /1 …` aceito sem erro, linhas 132–134 |
| (b) bp **instalado** | `bl` mostra os três com endereço resolvido = `base+RVA`, linha 136–138 |
| (c) **disparo** | **nenhum** — zero `Hit breakpoint`, zero `[A]/[B]/[C]` |
| (d) registro **executado** | não houve (dependente de c) |
| (e) marcador **gravado** | não houve |

---

## 2. Inferências corrigidas

| afirmação anterior | correção |
| :--- | :--- |
| "`bl` ao fim provaria sobrevivência do `0xCC`" | **falso**: `bl` é cadastro do debugger. Lista vazia não prova que o cliente removeu; cheia não prova que o `0xCC` está na memória |
| "lista vazia → anti-tamper" | **não sustentado** |
| "lista cheia → cobertura efetiva" | **não sustentado** |
| "ausência de marcador = ausência de hit" | **não automaticamente**. Marcador só aparece se o disparo acontecer e o `.printf` executar |

Adicionalmente: o próprio debugger pode ler bytes originais no lugar do `0xCC`
(o CDB restaura temporariamente o byte para leitura). Portanto **qualquer
verificação de memória via debugger é inconclusiva** sobre a presença do
breakpoint.

---

## 3. Evidência adicional coletada (somente leitura)

Proteção das três páginas, agora:

| ponto | VA | Protect |
| :--- | :--- | :--- |
| A | `0x7ff643f163d0` | `0x20` = **RX** (execute-read, não gravável) |
| B | `0x7ff643f1742a` | `0x20` = RX |
| C | `0x7ff643f50c90` | `0x20` = RX |

Páginas **read-only**. Para instalar `bp`, o debugger precisa remover a
proteção de escrita temporariamente — o que é normal e ele mesmo faz. Isso não
explica ausência de hit; apenas registra o estado.

---

## 4. Classificação final

> **Movimento confirmado; nenhum hit registrado; eficácia dos breakpoints
> durante a janela não estabelecida.**

Zero marcador prova que o `.printf` não executou. Não prova que a instrução
não executou — pode ter executado sem que o `0xCC` estivesse lá naquele
instante.

**Não afirmo anti-tamper. Não afirmo caminho alternativo.**

---

## 5. Próxima decisão

Parar de repetir este desenho (`bp` em A/B/C). Ele já respondeu o que podia:
os três pontos estavam cadastrados e instalados, e nenhum registrou disparo.

### Experimento que realmente diferenciaria as hipóteses

**Remover o `bp` da equação: usar hardware breakpoint (`ba`) em UMA thread
conhecida.** Isso muda a pergunta de "o `0xCC` sobreviveu?" para "este ponto
executou?".

| aspecto | detalhe |
| :--- | :--- |
| pergunta | a thread X executa o endereço de A (ou C)? |
| mecanismo | `ba e1 <addr>` — sem escrever bytes, sem depender de `0xCC` |
| evidência esperada | `Hit breakpoint` com `r rip` no endereço, ou nada |
| limite novo | `ba` é **por thread**; cobre uma só. Exige escolher a thread |
| risco | sabe-se lá qual thread; escolher errada dá falso negativo |
| por que é melhor | elimina a variável "o `0xCC` foi removido" |

**Como escolher a thread sem adivinhar:** enumerar as threads do processo e
usar a que processa a janela (`windowThreads`) — é a mesma que já
identificamos em coletas anteriores (`13520` na sessão antiga, hoje
desconhecida).

**Risco declarado:** se a caminhada não roda na thread da janela, `ba` nela
também não dispara, e o resultado continua inconclusivo. Nesse caso o próximo
passo seria `ba` por thread, uma por vez — caro.

**Alternativa sem depurador:** investigar o caminho do input por análise
estática a partir de `0x37a320` (função que calcula direção e chama A) e
localizar onde a direção vira passo. Isso não depende de o ponto executar
durante a coleta.

---

## 6. Preservado

- logs originais de todas as tentativas
- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- tracer congelado `810A87FF…318B`
- 20/20
