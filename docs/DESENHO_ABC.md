# Desenho A-B-C — reconciliação e correção

Data: 2026-11-08
Escopo: análise e correção do script. **Nenhuma anexação ao jogo.**

---

## 1. Reconciliação dos três pontos (bytes atuais do build)

Base em uso: `0x7ff6437d0000` (PID 28308, criado 2026-11-08T19:50:39Z).

| ponto | RVA | VA | bytes | é início de função? |
| :--- | :--- | :--- | :--- | :--- |
| **A** entrada candidata | `0x7463d0` | `0x7ff643f163d0` | `40555356574154415541564157488dac` | **sim** |
| **B** instrução call | `0x74742a` | `0x7ff643f1742a` | `e861980300` | não (dentro da função de A) |
| **C** destino | `0x780c90` | `0x7ff643f50c90` | `48895c240855565741564157488d6c24` | **sim** |

### Destino calculado de B (verificado nos bytes, não herdado)

```
0x74742a:  E8 61 98 03 00        ; call rel32
rel32 = 0x00039861
destino = 0x74742a + 5 + 0x00039861 = 0x780c90   ✓ coincide com C
```

### Alinhamento de instrução

Desmontei de A até passar B: `0x74742a` **é fronteira de instrução**
(`call 0x780c90`), e a instrução seguinte começa em `0x74742f`. Não cai no meio
de nenhuma instrução.

### Limites e caminhos entre A e B

| métrica | valor |
| :--- | :--- |
| tamanho da função | `0x7463d0..0x74752c` = 3420 bytes |
| instruções de A até B | **997** |
| desvios condicionais na função | 140 |
| instruções `j*` (todas) | 168 |
| `call`s na função | 83 |
| desvios **antes de B** que saem para o epílogo (`0x7474c0+`) | **5** |

Os cinco que podem evitar B:

```
0x746434  je  0x7474cb      ; objeto nulo (call 0x31c560)
0x746441  jne 0x7474cb      ; gate1 [0x39cba9a] != 0
0x74644e  jbe 0x7474cb      ; gate2 [obj+0xb0] == 0
0x74647a  jne 0x7474cb      ; virtual [rax+0x108] retornou true
0x746c81  ja  0x747504      ; caminho alternativo interno
```

**Não chamo A de "handler de teclado físico".** O que está provado é: A é
início de função, contém B, e B chama C. A ligação de A com `WM_KEYDOWN` **não
está provada** — só a assinatura (cálculo de direção por deltas) é compatível.

**Não transporto valores de gate** de uma leitura posterior para o instante do
movimento. A leitura anterior (`[0x39cba9a]=0`, `[obj+0xb0]=216`,
`[obj+0xcf6]=0``) foi feita com o jogo parado, após o detach. Não vale como
estado durante o movimento.

---

## 2. Por que o desenho anterior estava errado

O script anterior parava no **primeiro** hit e desanexava. Se o primeiro hit
fosse em A, o teste terminaria antes de observar B e C. Portanto:

- "A aconteceu, mas B não" **não era concluível** com aquele desenho;
- a ausência de B seria **consequência do próprio teste**, não observação.

---

## 3. Desenho corrigido

### Pergunta exata que a coleta responde

> Quando há movimento, a execução passa por **A** e por **B**, chegando a **C** —
> na mesma thread, dentro de uma janela curta?

### Pontos necessários: os três, mas com semântica de **sequência**

Diferente do desenho anterior, o comando de cada breakpoint **não desanexa**:
ele registra e continua (`g`). A parada só ocorre por limite de eventos, por
tempo, ou por interrupção operacional.

### Comportamento após cada hit

| hit | ação | dado registrado |
| :--- | :--- | :--- |
| A | registra, `g` | TID, RIP, hora, pilha |
| B | registra, `g` | TID, RIP, `rdx`, `r8` |
| C | registra, `g` | TID, RIP, `rdx`, `r8`, pilha |
| qualquer | — | contador por ponto |

### Força da correlação (declarada)

- Hits em **threads diferentes** → **não** são a mesma chamada. Não correlaciono.
- Hits na **mesma thread** dentro da janela → **compatível** com a mesma
  chamada, **não prova**. Entre A e B há 997 instruções, 83 calls e 5 saídas
  antecipadas; a mesma thread pode executar a função várias vezes.
- A correlação forte que este desenho **pode** dar: **A → B → C na mesma thread
  em ordem temporal crescente, dentro de poucos milissegundos**. Isso é
  evidência de sequência, ainda não prova de causalidade única.

### Limites e limpeza

- janela de 20 s, sem repetição automática
- limite de eventos: 12 (4 por ponto), para não inundar o log
- interrupção: `CTRL_BREAK` no processo do cdb (mecanismo já ensaiado)
- limpeza: `bc *` e `.detach` como comandos de script (nunca dentro de `.if`)
- detach preserva o alvo (verificado 4×)

---

## 4. Ensaio focal realizado (auxiliar, uma instância)

Rodei o padrão A/B/C no `walktrace_target.exe` para validar **a continuação
após hit**, que era a mudança do desenho.

Resultado:

```
C_HIT apareceu 4 vezes (TIDs 84cc, b94, ...)
B_HIT apareceu 0 vezes
```

**Por que B falhou no ensaio:** usei `walktrace_target+14c5` como B, mas os
workers chamam `target_function` por **cinco call sites diferentes**
(`0x149f`, `0x14c5`, `0x14eb`, `0x1511`, `0x15c6`). O `0x14c5` é um ramo
específico; os hits reais vieram por outro. **Isso é um erro do meu ensaio,
não do mecanismo.**

**O que o ensaio validou:**
- o comando do bp com `g` **continua** a execução (C disparou 4×, não parou no
  primeiro);
- múltiplos breakpoints coexistem e cada um registra seu TID/RIP;
- `kb` produz pilha no ponto C.

**O que o ensaio NÃO validou:** a sequência A→B→C completa, porque meu B
estava no call site errado do auxiliar.

**Conclusão do ensaio:** o mecanismo de "registrar e continuar" funciona. O
endereço de B no jogo (`0x74742a`) é único e verificado nos bytes, então o
problema do auxiliar não se transfere.

---

## 5. Script final

```asm
.printf "=== WALKTRACE ABC BEGIN ===\n"
.time

; A — entrada candidata
bp pokealliance_dx+7463d0 ".printf \"[A] tid=%x rip=%p\n\", $tid, @rip; kb; g"

; B — instrucao call (antes do destino)
bp pokealliance_dx+74742a ".printf \"[B] tid=%x rip=%p rdx=%d r8=%d\n\", $tid, @rip, @rdx, @r8; g"

; C — destino
bp pokealliance_dx+780c90 ".printf \"[C] tid=%x rip=%p rdx=%d r8=%d\n\", $tid, @rip, @rdx, @r8; kb; g"

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

Características:
- nenhum comando desanexa no meio;
- cada hit continua via `g`;
- `.detach` só ao final, após interrupção;
- `bl` confirma os três endereços antes de rodar.

---

## 6. Critérios honestos (o que cada resultado permite dizer)

| observação | conclusão permitida |
| :--- | :--- |
| hit em A | a função de A executou; **nada sobre B ou C** |
| hit em B | a execução alcançou a instrução `call`; **não** que ela concluiu |
| hit em C | C executou; **não** que o passo terminou |
| A→B→C, mesma thread, ordem temporal | sequência compatível com uma chamada; ainda não causalidade |
| A sem B | caminho até B **não observado**; **nenhum gate específico identificado** |
| nenhum hit | os pontos não foram observados nessa janela; **não** exclui
  participação no teclado |
| movimento sem C | cobertura e caminho executado **permanecem questões abertas**;
  **não** declarar falha do bp nem caminho alternativo |

---

## 7. Pedido de autorização

**Uma execução** do script acima, na instância atual revalidada:

```
cdb.exe -p <PID_VERIFICADO> -cf tools\cdb\walktrace-abc.txt
```

Um toque breve de seta durante a janela de 20 s. Sem envio de teclas por mim.

O que o resultado vai discriminar:
- **A→B→C**: o caminho do teclado usa `Game::walk` → próxima pergunta é como
  agendar nessa thread.
- **A→B, sem C**: chegou à chamada mas não entrou — investigar o destino/gate.
- **A sem B**: saiu antes de B; os 5 desvios mapeados dizem **onde olhar**,
  mas não qual disparou (para isso seria preciso breakpoint em cada desvio —
  fora de escopo agora).
- **nenhum hit**: A não é o caminho do teclado; reabrir a busca.

---

## 8. Preservado

- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs` — intocados
- tracer congelado `810A87FF…318B`
- 20/20
- logs das tentativas 01–03 intocados
