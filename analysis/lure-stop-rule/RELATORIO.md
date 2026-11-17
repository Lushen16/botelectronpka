# Análise offline — regra de parada/retomada do Shiba no lure

Data: 2026-11-11. Somente leitura nos originais. Nada foi executado contra o
jogo, nada foi capturado. Scripts e resultados em `analysis/lure-stop-rule/`.

---

## Passo 0 — Preparação e sanidade

### Arquivos e sessões

| arquivo | MB | registros | kind4 | kind5 | kind6 | kind11/12 | span |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `pka_tap_14784.jsonl` | 1,1 | 2.235 | 1.729 | 0 | 506 | 0 | 1,8 min |
| `pka_tap_17748.jsonl` | 454,1 | 138.863 | 92.980 | 2.296 | **34.034** | 9.569 | **97,0 min** |
| `pka_tap_19228.jsonl` | 450,4 | 127.790 | 91.813 | 2.296 | 33.681 | 0 | 95,8 min |
| `pka_tap_8036.jsonl` | 577,1 | 171.781 | 111.150 | 9.222 | **37.702** | 13.707 | 115,8 min |
| `pka_tap_33524.jsonl` | 572,8 | 158.067 | 111.148 | 9.221 | 37.698 | 0 | 115,8 min |

**Sessões cronológicas (por `t`):** 8036/33524 (05/11) → 14784 (11/11 11:51)
→ 17748/19228 (11/11 12:00–13:12).

Divisão usada (**sessões inteiras, nunca fatiadas**):

- **Descoberta:** `pka_tap_8036.jsonl` (sessão de 05/11, 115,8 min)
- **Validação:** `pka_tap_17748.jsonl` (sessão de 11/11, 97,0 min)

São sessões distintas de dias diferentes. 2 sessões é o mínimo defensável; a
limitação está declarada na seção 5.

**`pka_tap_19228` / `pka_tap_33524` foram excluídos:** são o lado c2s
(100% `dir=c2s`), não contêm kind6 do jogo com `luring`. Não servem para
estudar decisão do runtime.

### Campos efetivamente presentes

O envelope do tap é **fechado**: `{t, dir, pid, h, kind, n, trunc, d}`.
Não existe campo de horário de recebimento.

Dentro do kind6 decodificado (`d` → base64? não: hex → JSON):

```
phase, phases, core, paused, tick, pid
luring.{actorId, count, holding, minCount, mode, phase, target}
```

### Relógios — o que é possível e o que não é

`t` = **`GetTickCount()` do processo do jogo** (confirmado na fonte:
`native/pka_tap.c:149`).

| propriedade | valor |
| :--- | :--- |
| tipo | monotônico relativo ao boot do Windows |
| resolução | ~15,6 ms |
| data/hora | **ausente** |
| horário de recebimento | **ausente** (o tap grava no momento do hook, não expõe ambos) |
| horário da decisão | aproximado pelo `t` da publicação |

**Consequências declaradas:**

- Latência publicação→recebimento: **INDISPONÍVEL**.
- Alinhamento com relógio externo: **INDISPONÍVEL**.
- O que `t` **permite**: intervalo entre publicações, ordem, duração de fase,
  distância temporal entre decisões. É tudo que esta análise usa.

### O rótulo de parada/andou

**Rótulo adotado: `stopped(f) = luring.holding`.**
`null` (indeterminado) quando `paused=true` ou `mode='off'`.

**Este rótulo NÃO é independente.** É exatamente o preditor dos Testes A e B.
Verificação de independência:

| fonte alternativa | disponibilidade |
| :--- | :--- |
| `kind5.position` (movimento real) | **8 de 2.296 publicações** (0,35%) |
| comando de movimento registrado (kind9 `manual`) | **0 ocorrências** em todas as 5 sessões |
| `core.movementOwner` | existe, mas é estado inferido, não movimento |

Portanto: **não há rótulo independente de movimento.** Os Testes A, B e C
medem **consistência interna**, não acurácia contra movimento real. Isto não é
limitação de método — é ausência de dado.

### Episódios de lure e alinhamento

Episódio = trecho contíguo com `luring.mode === 'dynamic'` e `!paused`, cortado
quando o gap entre publicações excede **N**.

| conjunto | kind6 | em lure dynamic | episódios | frames/episódio (primeiros) |
| :--- | ---: | ---: | ---: | :--- |
| descoberta | 37.702 | 11.719 | **744** | 4,7,14,15,18,20,23,18,16,22,6,6,15,17,24 |
| validação | 34.934 | 19.219 | **1.261** | 14,19,8,16,15,18,18,9,16,16,23,14,15,8,14 |

### Distribuição de intervalos e escolha de N

| conjunto | n | mediana | p90 | p95 | p99 | máx |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| descoberta | 11.683 | **203 ms** | 250 | 250 | 265 | 44.719 |
| validação | 19.184 | **203 ms** | 250 | 250 | 265 | 20.125 |

Cadência **estável entre sessões** (mediana idêntica, p95 idêntico).

O máximo de 44,7 s é **borda de log** (transição entre trechos), não cadência.

**N = 600 ms** — cobre com folga o p99 (265 ms) e é 2,4× a mediana.
Congelado antes da validação.

**X** (distância máxima entre decisões para a mesma sequência de desacordo) =
**600 ms**, pelo mesmo raciocínio: é a janela em que duas publicações
pertencem ao mesmo episódio.

### Transições observadas

| conjunto | transições | paradas | retomadas |
| :--- | ---: | ---: | ---: |
| descoberta | 662 | 318 | 344 |
| validação | 265 | 126 | 139 |

### Os 221 desacordos históricos

**Não são reproduzíveis nesta análise.** Motivo: eles dependiam do log de
decisões do **nosso bot** (`boxed`, `isFormationHeld`, estado do árbitro), e
esse log **não existe em disco**. Varredura em todo o repositório por arquivos
contendo `boxed|isFormationHeld|decision|arbiter` só encontrou
`reconstruction/spec/decision-rules-v1.json` (especificação, não log).

| categoria | contagem |
| :--- | ---: |
| desacordos históricos reportados | 221 |
| reproduzíveis com os arquivos atuais | **0** |
| avaliáveis | **0** |
| excluídos | **221** (falta o log de decisão) |

A classificação original — "nosso bot andava, Shiba classificado como parado" —
veio de **inferência por phase/holding do kind6**, não de movimento observado
nem de comando registrado. Confirmado: `kind9 manual = 0` em 5 sessões.

---

## Passo 1 — Teste A (holding)

| conjunto | acordo | desacordo | indeterminado | denominador |
| :--- | ---: | ---: | ---: | ---: |
| descoberta | 11.719 | **0** | 0 | 11.719 |
| validação | 19.219 | **0** | 0 | 19.219 |

**Resultado: 100% — e é tautológico.** O preditor é `holding`; o rótulo é
`holding`. Não há informação nova.

Matriz de confusão (descoberta): `tp=318`, `tn=11.401`, `fp=0`, `fn=0`.

Latência parada/retomada: **0 ms por construção** (mesma fonte).
**INDISPONÍVEL para medir atraso real.**

---

## Passo 2 — Testes B e C

### Teste B — holding + count ≥ minCount

| conjunto | acordo | desacordo | indeterm | tp | tn | fp | fn |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| descoberta | 11.097 | **622** | 0 | 233 | 10.864 | **0** | **622** |
| validação | 18.943 | **276** | 0 | 156 | 18.787 | **0** | **276** |

**Leitura:** o erro de B é **100% "parada perdida"** (`fn`), zero "pausa
indevida" (`fp`). Ou seja: existem frames em que `holding=true` — ele está
parado — mas `count < minCount`.

Isso **refuta** a hipótese de que a parada exige o limiar de contagem.
Ele para com 1, 2, 3, 5, 7 monstros. O `minCount` governa o *release* do
combo, não a parada do lure.

`minCount` estava presente em 100% dos frames de lure (nunca ausente), então
não foi preciso testar grade de limiares fixos.

### Teste C — phase + holding

| conjunto | frames em lure | divergências phase↔holding |
| :--- | ---: | ---: |
| descoberta | 11.719 | **0** |
| validação | 19.219 | **0** |

Tabela `luring.phase × holding` (validação):

```
18587  phase=travel      holding=false
  212  phase=stationary  holding=true
  179  phase=arc         holding=true
   38  phase=wait        holding=true
    3  phase=observe     holding=true
```

**Zero divergências em 30.938 frames.** `phase` e `holding` são a mesma
informação em dois formatos.

**Teste C é marcado NÃO AVALIÁVEL** por circularidade: `phase` foi usado para
construir o rótulo (`holding`), e `holding` deriva de `phase`. Resultado
idêntico a A por construção.

A pergunta do enunciado — "arc, stationary e wait exigem condições diferentes
para parar?" — **não é respondível** com estes dados, porque a única forma de
distinguir seria um rótulo independente, que não existe.

---

## Passo 3 — Árvore rasa

**Não executado.** Justificativa: o único alvo disponível é `holding`, que já é
predito com 100% por uma regra de uma linha. Uma árvore treinada contra
`holding` aprenderia `phase in {arc,stationary,wait,observe}` — que é a mesma
regra. Não há lacuna a preencher porque não há rótulo independente.

---

## Passo 4 — Plano de calibração espacial (só plano)

O que falta é **posição de selvagem**. Ordem de teste:

**4.1 Estabilidade de `scan_creatures`** (nossa DLL, não o Shiba)
- Cena estável, 20 leituras seguidas: comparar contagem, conjunto de `id` e
  posição por tile. Critério: contagem idêntica, `id` idêntico, posição
  idêntica. Registrar leituras incompletas e duplicatas.
- Cena com movimento: as diferenças devem ser compatíveis com o intervalo
  entre amostras (deslocar ≤ 1 tile por leitura a 100 ms).

**4.2 Alinhamento temporal**
- Nossa DLL escreve com `GetTickCount()` do **mesmo processo** → relógio
  comparável ao `t` do tap. Isto é o que permite alinhar.
- Exige coleta **simultânea** na mesma cena: só assim dá para comparar
  `scan_creatures` com `luring.count`.

**4.3 Candidatos de geometria**
- centro: posição do `ownPokemon` vs posição do player
- raio: `perfectingLureRange` (4) vs `bestTileRange` (4) vs 1..8
- exclusão do summon próprio (`type=3`) e do player (`type=0`)
- métrica: Chebyshev (medida em todos os logs anteriores)

**4.4 Validação**
- Ajustar em sessões de calibração, validar em outra sessão.
- Comparar: erro de |contagem nossa − `luring.count`| e ganho na previsão de
  parada nos frames em que `holding` sozinho não explica.

**4.5 Riscos, em ordem**
1. Incompatibilidade de coleta (nossa DLL e o Shiba no mesmo processo — regra
   de coexistência proíbe)
2. Instabilidade de leitura (refcount, GC movendo entidades)
3. Sincronização (o `count` pode ser calculado em outro momento)
4. Representatividade (cena precisa ter selvagens agrupados de verdade)

---

## Entrega

### Tabela de testes

| teste | regra | descoberta | validação | avaliação |
| :--- | :--- | ---: | ---: | :--- |
| A | `holding` | 100% (0/11.719) | 100% (0/19.219) | **tautológico** |
| B | `holding` + `count ≥ minCount` | 94,7% (622 desac.) | 98,6% (276 desac.) | **refuta o limiar** |
| C | `phase` + `holding` | 100% (0/11.719) | 100% (0/19.219) | **circular** |
| árvore | — | não executado | — | sem rótulo independente |

Denominadores: descoberta 11.719 frames / 744 episódios; validação 19.219
frames / 1.261 episódios.

### Desacordos resolvidos e novos

- **Resolvidos pelo Teste A:** 0 — não havia desacordo a resolver (rótulo =
  preditor).
- **Novos desacordos criados por B:** 622 (descoberta) e 276 (validação),
  **todos paradas perdidas**. B é estritamente pior que A para prever parada.
- **Latência:** indisponível. Sem rótulo independente, não há "transição
  observada" para parear com "transição prevista".

### Padrões restantes

**Grupo 1 — Para com contagem abaixo do minCount** (o achado principal)

```
frames: 622 (descoberta) + 276 (validação)
exemplo descoberta: fase=arc, count=3/8, holding=true
exemplo validação:  fase=wait, count=5/8, holding=true
localização: análise/lure-stop-rule/resultado.json → tests.B
```

Não é ruído: é a maioria dos frames de parada. Ele para para **esperar o
monstro chegar**, não porque já tem o número.

**Grupo 2 — Ocupação de tile indeterminada**

```
2.288 de 2.296 publicações kind5 com creatures[] vazio
8 restantes: apenas player (type=0) e summon próprio (type=3)
selvagens (type=1): ZERO em todas as sessões
```

Sem selvagem na telemetria, `boxed` não é calculável. Nossos 221 desacordos
históricos vêm daqui.

### Recomendação

1. **Adotar `holding` como gatilho de parada/retomada** — é o que ele publica,
   e Teste B provou que adicionar `count ≥ minCount` só cria erro.
2. **Não usar `count` para decidir parada.** `minCount` governa o release do
   combo; a parada acontece antes e independente da contagem.
3. **Decisão indeterminada** quando `mode='off'` ou `paused=true` — nesses
   casos o lure não está decidindo.
4. **Permanece incerto:** *por que* ele para. `holding` descreve, não explica.
   A causa é geométrica e a geometria não está no log.
5. **Dado que falta:** posição dos selvagens por tile, sincronizada com o
   kind6. Com ela, testa-se se `holding` = "formação em progresso" e
   calibra-se `boxed` contra `luring.count`.
