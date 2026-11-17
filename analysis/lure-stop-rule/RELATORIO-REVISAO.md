# Relatório final — replay de parada do Shiba no lure

Data: 2026-11-11. Análise **offline** sobre snapshot congelado. Processo do jogo
e tap ativo fora do escopo: **nenhuma ação executada no PID 17748**.

---

## 0. Integridade do insumo

```
arquivo : analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl
bytes   : 616.925.188   (esperado 616.925.188 — confere)
sha256  : 55dc9bcecd86d65977df02d59e7f05c4ab33936a9d801aac6fedd24b665491a0
prefixo : 55dc9bce   (confere)
```

**O que foi conferido:** tamanho exato em bytes e o SHA-256 completo,
recalculado nesta execução por streaming. O prefixo `55dc9bce` do enunciado
confere com os 8 primeiros dígitos do hash completo.

**O que NÃO foi conferido:** não existe hash de referência independente no
projeto. A varredura por `55dc9bce|616925188` só encontra os próprios relatórios
que eu escrevi (`RELATORIO-REPLAY.md`, `RELATORIO-REVISAO.md`). Ou seja: o hash
está **auto-consistente**, mas não há atestação de terceiro. A integridade
depende de o snapshot não ter sido corrompido entre a cópia e agora — e isso o
rehash desta execução demonstra.

---

## 1. Reconciliação das séries

### Definições fixas (congeladas antes de medir)

| conceito | definição |
| :--- | :--- |
| frame válido | `luring.mode === 'dynamic'` e `paused !== true` |
| episódio | sequência contígua; corta quando gap entre publicações > **600 ms** |
| replay | decide no frame *N* usando o `holding` do frame *N−1* (nunca o atual) |
| INDETERMINADO | sem frame anterior no episódio, OU idade > 600 ms, OU `holding` ausente |
| run | sequência contígua de `holding === true` **dentro do mesmo episódio** |

### Volume

```
frames em lure : 24.011
episódios      : 1.576
```

### Os cinco totais, cada um com sua fonte

| total | valor | série | unidade | borda | o que NÃO conta |
| ---: | :--- | :--- | :--- | :--- | :--- |
| **305** | trocas de decisão do **replay** | decisões previstas (frame anterior) | mudança `STOP`↔`MOVE` | INDET quebra a sequência | transições no último frame do episódio |
| **325** | trocas booleanas de **`holding` observado** | sinal bruto | mudança `true`↔`false` | só dentro do episódio | nada (é o sinal completo) |
| **326** | **runs** de `holding=true` | sequências de `true` | abertura de run | run cortado na borda conta | ⚠️ rótulo anterior estava errado |
| **329** | mudanças de **`phase`** | `luring.phase` | mudança de string de fase | só dentro do episódio | — |
| **179** | runs **completos+incompletos** de `holding=true` | runs de `true` | run inteiro | run cortado na borda conta | — |

#### Correção do rótulo de 326

O total **326** foi rotulado como "runs de `holding=true`" e está **errado**.
A contagem correta de runs é **179** (170 completos + 9 incompletos).

**326 é o número de runs do replay** — sequências de decisão `STOP`/`MOVE`
consecutivas, onde `INDETERMINADO` quebra a sequência. Como cada episódio começa
com um INDET, ele gera até 1.576 fronteiras; 326 é quantos runs de decisão
sobreviveram.

Rótulo correto:

```
179 = runs de holding=true observado   (o sinal)
326 = runs de decisão do replay        (sequências STOP/MOVE sem INDET)
```

### Decomposição de 329 (phase)

```
entradas em parada (!stopPhase -> stopPhase) : 155
saídas de parada  (stopPhase -> !stopPhase)  : 170
stop -> stop (mudança de fase dentro da parada, ex. arc->stationary) : 4
                                                    soma = 329
```

E `entradas + saídas = 325` — **igual às trocas de `holding`**. Isso não é
coincidência: cada entrada/saída de fase de parada corresponde a exatamente uma
mudança booleana de `holding`, porque `holding` e `isStopPhase` são a mesma
função (0 divergências em 24.011 frames).

### A hipótese das 20 saídas ausentes — REFUTADA e substituída

**Hipótese anterior (errada):** as 20 transições perdidas pelo replay ocorreriam
no *primeiro* frame do episódio.

**Teste:** eventos de `holding` observados que coincidem com `firstOfEpisode`.

```
eventos no primeiro frame do episódio : 0
```

Zero. A hipótese está **refutada**.

**Causa real, provada evento a evento:** as 20 transições ocorrem no **último
frame do episódio**.

| evidência | resultado |
| :--- | :--- |
| transições observadas | 325 |
| no último frame do episódio (`idx === len-1`) | **20** |
| 325 − 20 | **305** = valor do replay ✓ |
| direção das 20 | **todas `true→false`** |
| tamanho do episódio nesses casos | mediana 19 frames, máx 48 |

Mecanismo: o replay decide no frame *N* comparando com *N−1*. Se a transição
acontece **no** frame *N* e não existe *N+1* (fim do episódio), o replay nunca
a observa. É perda de borda direita, não de borda esquerda.

Tabela de eventos perdidos: `analysis/lure-stop-rule/eventos-perdidos.json`.

### Total de `INDETERMINADO` e causa

```
1.576 INDETERMINADO  =  1.576 episódios × 1 (primeiro frame)
```

Todas as causas são "sem kind6 anterior no episódio". **Nenhum** caso de idade
> 600 ms: o intervalo máximo observado foi 281 ms.

---

## 2. `minCount` e duração — correções

### Entradas em parada — 155 transições, 0 excluídas

| `count` no frame de entrada vs `minCount` | ocorrências |
| :--- | ---: |
| `<` (abaixo) | **98** |
| `=` (igual) | 31 |
| `>` (acima) | 26 |
| inválido (`count`/`min` nulo) | **0** |

Cruzaram o limiar **para cima** (anterior `< min`, atual `>= min`): **13**.
Todos `7→8` com `min=8`.

Cruzaram sem mudar de bucket (não houve salto de `<` para `>=` podendo ocorrer
por saltos internos): 142 não cruzaram.

### Saídas de parada — 170 transições, 0 excluídas

| `count` no frame de saída vs `minCount` | ocorrências |
| :--- | ---: |
| `<` (abaixo) | **111** |
| `=` | 30 |
| `>` | 29 |
| inválido | **0** |

Cruzaram **para baixo** (anterior `>= min`, atual `< min`): **2**.

### O que estes números refutam

| afirmação | veredito | base |
| :--- | :--- | :--- |
| `count >= minCount` é **necessário** para retomar | **REFUTADO** | 111/170 (65,3%) retomam abaixo |
| a parada exige **cruzar** o limiar naquele frame | **REFUTADO** | 142/155 (91,6%) não cruzam |
| `count` tem **influência indireta** sobre a duração | **não sustentado** | r = −0,116 |

### A correlação r = −0,116 — quem entrou

```
runs usados             : 170  (todos completos)
runs sem count na entrada: 0   (o count estava observado em todos)
```

O `count` de entrada foi lido do **primeiro frame do próprio run** — nunca
herdado de frame anterior ao run. Não houve caso de episódio começando em
`true` onde o count estivesse ausente: `countAtFirst != null` em 170 de 170.

**Limitação declarada:** r = −0,116 é correlação linear observada nesta
amostra, com uma única leitura de `count` por run (a do início). Qualquer teste
com **histórico** de `count` exigiria janela explícita; a cadência mediana de
2 amostras por run **não fornece histórico suficiente** — 114 dos 179 runs têm
exatamente 2 amostras. Esse teste fica **pendente por falta de resolução**.

### Duração por timestamp

| métrica | n | mediana | p90 | máx |
| :--- | ---: | ---: | ---: | ---: |
| observada `t(false)−t(true)` — **só completos** | 170 | **172 ms** | 656 | 2.250 |
| limite inferior `t(último true)−t(primeiro true)` — todos | 179 | **31 ms** | 672 | 3.843 |
| limite inferior — só completos | 170 | 31 | — | — |

Intervalo local entre publicações (mesmo episódio):

```
mediana 203 ms | p90 235 ms | máx 281 ms
```

**172 ms está abaixo da cadência de 203 ms.** Isso significa que, tipicamente,
a transição para `false` chega **no próximo registro**. A leitura correta:
"172 ms é o intervalo observado entre registros, sujeito à resolução da
telemetria" — não é uma medida contínua da duração do estado.

### Distribuição por número de amostras — corrige a afirmação anterior

| amostras no run | runs |
| ---: | ---: |
| 1 | **7** |
| 2 | 114 |
| 3 | 27 |
| 4 | 13 |
| 5 | 2 |
| 6 | 3 |
| 7 | 3 |
| 8 | 2 |
| 9 | 1 |
| 10 | 2 |
| 11 | 1 |
| 13 | 1 |
| 15 | 1 |
| 18 | 1 |
| 19 | 1 |

**Runs com um único `true`: 7 de 179 = 3,9%.**

A afirmação anterior ("a maioria dos runs tem um único `true`") estava
**errada**. A distribuição modal é **2 amostras (114 runs, 63,7%)**. Com mediana
2 e intervalo de 203 ms, a duração observada de 172 ms é consistente com "o
registro seguinte já é `false`", mas não implica amostra única.

### Runs nas bordas

| condição | runs |
| :--- | ---: |
| começam no primeiro frame do episódio | **24** |
| terminam na borda do episódio (incompletos) | **9** |

Os 24 runs que começam em `true` têm **início real possivelmente anterior** ao
episódio: o que veio antes não foi observado (gap > 600 ms ou troca de modo).
Sua duração é limite inferior, não medida.

---

## 3. Protocolo reproduzível para sessão futura com vídeo

### 3.1 Pré-requisitos

| item | requisito |
| :--- | :--- |
| gravação | tela inteira, **60 fps**, taxa de quadros constante |
| relógio do vídeo | monotônico próprio (OBS fornece PTS por frame) |
| log | tap ativo na mesma sessão, kind6 + kind4 |
| marcadores | **dois** eventos visíveis no vídeo **e** no log, um no início e um no fim |

### 3.2 Escolha do marcador

Candidatos que aparecem nas duas fontes:

1. **Abrir/fechar o menu do Shiba** — muda `modules`/`phases` no kind6 e é
   visível na tela.
2. **`!autocombo`** — aparece no chat do jogo e como `phase` `AutoCombo: ...`.

**Critério de aceitação:** o marcador só vale se for identificável
inequivocamente nos dois registros. Se não for, **a latência absoluta não é
mensurável** — registrar isso e parar.

### 3.3 Alinhamento

```
1. t_video(marcador_inicio), t_video(marcador_fim)    [PTS do frame]
2. t_log(marcador_inicio),   t_log(marcador_fim)      [campo `t` do kind6]
3. offset    = t_video(inicio) - t_log(inicio)
4. deriva    = (t_video(fim)-t_video(inicio)) - (t_log(fim)-t_log(inicio))
5. incerteza = ±(1/2 frame) + |deriva|/2     [declarar por escrito]
```

Se `|deriva|` for maior que 2 frames, reportar e reduzir a janela de medição.

### 3.4 Identificação de movimento — sem depender do personagem na tela

A câmera pode seguir o personagem e mantê-lo fixo. Portanto **usar o cenário**:

- referência: um tile estático (árvore, pedra, borda de parede) na vizinhança
- "parado" = a referência não se desloca em relação à moldura por **N frames
  consecutivos**
- **N = 6 frames** (100 ms a 60 fps) — abaixo disso é ruído de captura
- **início da parada** = o **primeiro** dos N frames consecutivos

Alternativa se houver contador de coordenadas na tela: usar o número.

### 3.5 Associação evento ↔ parada

```
janela de associação W = 1000 ms   (declarada ANTES de olhar os dados)
```

Para cada transição `false→true` no log:

1. procurar no vídeo uma parada cujo início caia em
   `[t_log - W, t_log + W]` (após aplicar offset)
2. se houver **exatamente uma** parada na janela → caso **válido**
3. se houver **duas ou mais** → **ambíguo**, registrar e excluir
4. se **nenhuma** → registrar em uma destas categorias:
   - personagem já estava imóvel
   - personagem não parou
   - personagem saiu de vista

### 3.6 Métrica

```
latência = t_video(parada) - t_log(primeiro holding=true)
```

- **positivo** → o sinal registrado **precede** a parada física
- **negativo** → a parada física precede o registro

Reportar: `n` válidos, mediana, p90, incerteza de alinhamento, e contagem em
cada categoria de exclusão.

### 3.7 Fora de escopo

Posição de selvagens **não** entra neste teste. Ela só será necessária se a
pergunta mudar para *qual formação dispara a decisão de parar*.

---

## 4. Tabela de eventos para auditar as discrepâncias

### 4.1 Os 20 eventos perdidos pelo replay

Arquivo completo: `analysis/lure-stop-rule/eventos-perdidos.json`

| # | episódio | tam. ep. | idx | direção |
| ---: | ---: | ---: | ---: | :--- |
| 1 | 0 | 14 | 13 | `true→false` |
| 2 | 61 | 24 | 23 | `true→false` |
| 3 | 160 | 23 | 22 | `true→false` |
| 4 | 355 | 17 | 16 | `true→false` |
| 5 | 513 | 14 | 13 | `true→false` |
| 6 | 514 | 5 | 4 | `true→false` |
| 7 | 550 | 17 | 16 | `true→false` |
| 8 | 769 | 21 | 20 | `true→false` |
| ... | (12 restantes no JSON) | | | |

Padrão: **todos** com `idx === len-1` (último frame) e **todos** `true→false`.

### 4.2 Reconciliação numérica

| igualdade | valor | verificação |
| :--- | :--- | :--- |
| `holding_trocas − replay_trocas` | 325 − 305 = **20** | = eventos no último frame ✓ |
| `phase_entradas + phase_saídas` | 155 + 170 = **325** | = trocas de `holding` ✓ |
| `phase_entradas + phase_saídas + stop→stop` | 155+170+4 = **329** | = mudanças de `phase` ✓ |
| `runs completos + incompletos` | 170 + 9 = **179** | = runs de `holding` ✓ |
| `INDETERMINADO` | **1.576** | = episódios × 1 ✓ |

---

## 5. Estado das verificações

### Verificado nesta análise

| item | status |
| :--- | :--- |
| integridade do snapshot (bytes + sha256) | **OK** |
| 1.576 episódios reproduzidos | **OK** |
| causa de cada `INDETERMINADO` | **OK** — 1º frame do episódio |
| reconciliação dos 5 totais | **OK** — todas as igualdades fecham |
| causa das 20 saídas ausentes | **OK** — último frame do episódio |
| refutação de `count >= minCount` necessário | **OK** — 111/170 abaixo |
| refutação de cruzamento obrigatório na parada | **OK** — 142/155 não cruzam |
| correlação count × duração | **OK** — r = −0,116, n=170, sem exclusões |
| distribuição de amostras por run | **OK** — modal 2 (63,7%), único 3,9% |
| duração por timestamp | **OK** — 172 ms mediana (completos) |

### Não verificado — e por quê

| item | motivo |
| :--- | :--- |
| **parada física do personagem** | **não existe vídeo da sessão antiga** |
| **latência `holding` → parada real** | idem |
| influência do histórico de `count` | cadência mediana de 2 amostras/run não fornece histórico |
| qual formação dispara a parada | exige posição de selvagem, ausente do kind5 (0 de 2.296 com `type=1`) |
| `minCount` governa o release do combo | exige observar o combo; não é objeto deste log |

---

## 6. Reprodução

```bash
# integridade
node -e "const c=require('crypto'),f=require('fs');const h=c.createHash('sha256');\
f.createReadStream('analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl')\
.on('data',d=>h.update(d)).on('end',()=>console.log(h.digest('hex')))"

# auditoria completa (series, minCount, duracao, eventos perdidos)
node tools/lure-audit-final.cjs \
  --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl

# replay da regra (decicoes STOP/MOVE/INDET)
node tools/lure-replay.cjs \
  --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl

# reconciliacao (primeira passada)
node tools/lure-reconcile.cjs \
  --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl
```

Saídas: `auditoria-final.json`, `replay-holding.json`, `reconciliacao.json`,
`eventos-perdidos.json`.

---

## 7. Conclusão

**O que está estabelecido:** `holding` é o sinal de intenção de parada do
Shiba. É internamente consistente (0 divergências contra `phase` em 24.011
frames), pontual (idade ≤ 281 ms) e **independente de `count`** para a decisão
de parar e retomar — 111 de 170 retomadas ocorrem abaixo do `minCount`.

**O que mudou nesta revisão:**

1. **326 não são runs de `holding`** — são runs de decisão do replay. Runs de
   `holding` são **179**.
2. **As 20 transições ausentes não estão no 1º frame** — estão no **último**, e
   são todas `true→false`. Mecanismo: o replay precisa do frame seguinte para
   detectar a mudança.
3. **Runs com único `true` são 3,9%**, não a maioria. O modal é 2 amostras
   (63,7%). A mediana de 172 ms não demonstra amostra única.
4. **`count` não cruza o limiar na parada** em 91,6% das entradas.

**O que permanece aberto:** se o personagem **fisicamente** para quando
`holding=true`, e com que latência. Isso exige vídeo da mesma sessão, que não
existe. O protocolo da seção 3 está pronto para a próxima gravação.

**Decisão prática recomendada:** usar `holding` como gatilho de intenção
(parar/retomar), com validade de 600 ms e `INDETERMINADO` quando não houver
amostra na janela. Não usar `count` para essa decisão.
