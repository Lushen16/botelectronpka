# Validação — `holding` × parada física

Data: 2026-11-11. **Offline** sobre snapshot congelado.
PID 17748 e tap **fora do escopo**: nenhuma interação.

Esta revisão corrige quatro erros da versão anterior da análise de `count`:
estimador pooled inflado (+7,3 → **−0,57 p.p.** padronizado), "máximo de 3
amostras" (real: **8**), "três leituras incluem a transição" (o teste usa
**apenas anteriores**), e ausência da análise com cobertura completa
(**−6,55 p.p.**).

---

## 0. Insumos

| item | valor |
| :--- | :--- |
| snapshot | `analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl` |
| bytes | 616.925.188 ✓ |
| sha256 | `55dc9bcecd86d65977df02d59e7f05c4ab33936a9d801aac6fedd24b665491a0` |
| vídeo da sessão | **não existe** — busca encerrada, conforme instruído |
| frames em lure | 24.011 · episódios 1.576 · entradas `false→true` 155 |

---

# PARTE 1 — Análise de `count` (corrigida)

Script: `tools/lure-count-history.cjs`
Saída: `analysis/lure-stop-rule/count-history.json`

## 0.1 As duas diferenças registradas nesta revisão

### Diferença 1 — 20.348 vs 20.334 (14 frames)

**Origem:** o estrato (`stratified.bySamples`) contém **todos** os 23.473
frames de controle, inclusive os de n=0 e n=1. O estimador **pooled** só soma
estratos que têm **pelo menos uma entrada** (campo `entries > 0`).

| grupo | frames | observação |
| :--- | ---: | :--- |
| todos os controles | 23.473 | inclui n=0 (1.554) e n=1 (1.571) |
| com ≥2 amostras anteriores | **20.348** | população elegível do teste |
| **usados no pooled** | **20.334** | só estratos com `entries > 0` |

Os **14** ausentes são exatamente os estratos que têm controles mas **nenhuma
entrada**:

```
n=7: 10 frames de controle, 0 entradas
n=8:  4 frames de controle, 0 entradas
     ----
       14
```

Não é bug: consequência de o pooled ser média ponderada por grupo, e grupo sem
entrada não tem taxa de entrada para comparar. O estimador padronizado também
ignora esses estratos pelo mesmo motivo.

**Verificação na saída do script:** campo `stratified.controlAccounting`:

```
allControls        : 23473
withAtLeast2       : 20348
inPooled           : 20334
excludedFromPooled : n=0 (1554), n=1 (1571), n=7 (10), n=8 (4)
```

### Diferença 2 — 68 vs 102 históricos estáveis

**Origem:** duas definições diferentes de "histórico estável", publicadas em
versões distintas do relatório.

| definição | contagem | correto? |
| :--- | ---: | :--- |
| (A) apenas amostras **anteriores** iguais entre si | **102** | **SIM** |
| (B) anteriores iguais **+ o frame da transição** | **68** | **NÃO** |

A definição (B) inclui o próprio frame que se quer prever — circularidade. O
teste de histórico usa apenas o que vem **antes** da entrada, então **102 é o
número válido**.

O 68 apareceu no primeiro relatório porque o cálculo fazia
`[...anteriores, countAtEntry]` e exigia todos iguais. A versão atual conta
apenas as anteriores.

**Verificação na saída do script:** campo `stratified.stability`:

```
prevOnly       : 102   <- predicado valido
includingEntry :  68   <- circular, nao usar
```

## 1.1 Os dois grupos e os filtros que os geram

Esta é a origem da confusão entre 1.075 e 20.334:

| etapa do filtro | frames |
| :--- | ---: |
| frames em lure (`mode=dynamic`, `!paused`) | 24.011 |
| frames com `holding === false` (candidatos a controle) | 23.473 |
| **+** com ≥2 amostras anteriores válidas na janela de 600 ms | **20.348** |
| **+** com cobertura desde o início da janela | **15.973** |

E as entradas:

| etapa | entradas |
| :--- | ---: |
| transições `false→true` | 155 |
| **+** com ≥2 amostras anteriores | **155** |
| **+** com cobertura desde o início | **143** |

**Os 1.075 do relatório anterior** eram o controle **pareado ao count da
entrada** (`f.count === e.countAtEntry`) — um subconjunto muito restrito.
Os 20.334 são o controle **sem esse pareamento de count**.

São populações diferentes. Não devem ser comparadas diretamente:

| grupo | definição | tamanho |
| :--- | :--- | ---: |
| **Controle bruto** | `holding=false`, ≥2 anteriores, **sem** parear count | 20.348 |
| **Controle pareado** | idem **+** `count === count da entrada` | 1.075 |

No relatório anterior eu comparei entradas (155) contra o controle **pareado**
(1.075) e chamei o resultado de "pooled". Foi uma mistura. Corrigido abaixo.

## 1.2 Os dois estimadores, separados

### Estimador A — pooled (pondera pelo tamanho do grupo)

```
delta_pooled = (47/155) − (4672/20334) = 0,3032 − 0,2298 = +7,35 p.p.
```

**Por que é enganoso:** o denominador do controle (20.334) é distribuído de
forma desigual entre estratos — n=3 sozinho tem 12.169 controles (59,8%). O
pooled deixa o estrato n=3 mandar no resultado, mesmo sendo 47,7% das entradas.

### Estimador B — padronizado pela distribuição das 155 entradas

```
delta_padronizado = Σ_estrato ( (n_entradas_estrato / 155) × (taxa_entradas − taxa_controles) )
```

| estrato | n_ent | peso | taxa entradas | taxa controles | diferença | contribuição |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 12 | 0,0774 | 0,0% | 5,54% | −5,54 | **−0,43** |
| 3 | 74 | 0,4774 | 24,32% | 24,97% | −0,65 | **−0,31** |
| 4 | 43 | 0,2774 | 44,19% | 37,50% | +6,69 | **+1,86** |
| 5 | 18 | 0,1161 | 38,89% | 42,07% | −3,18 | **−0,37** |
| 6 | 8 | 0,0516 | 37,50% | 63,04% | −25,54 | **−1,32** |
| **soma** | **155** | **1,0000** | | | | **−0,57** |

**`delta_padronizado = −0,57 p.p.`**

Confirmado: a revisão apontou ≈ −0,6 p.p. e o cálculo reproduzível dá −0,57.

**Correção de explicação:** removi a justificativa anterior de que "mais frames
= mais chance de detectar subida". A oportunidade de observar uma subida depende
do número de **amostras válidas e dos intervalos dentro de cada janela** — não
do número de frames. O problema real é outro: episódios e janelas se
**sobrepõem**, gerando muitos controles correlacionados (não independentes). Um
IC calculado sem agrupar por episódio seria artificialmente estreito. **Não
calculei IC** justamente por isso.

## 1.3 Cobertura completa em ambos os grupos

155/155 têm ≥2 amostras, mas só **143/155** têm cobertura **desde o início** da
janela (amostra em `t ≤ entryT − 600 ms`, no mesmo episódio). Exigindo
cobertura completa nas entradas **e** nos controles:

| estrato | entradas | taxa ent. | controles | taxa ctrl. | contribuição |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 9 | 0,0% | 3.043 | 8,3% | −0,52 |
| 3 | 72 | 25,0% | 10.681 | 27,3% | −1,18 |
| 4 | 37 | 43,2% | 2.023 | 47,8% | −1,18 |
| 5 | 17 | 41,2% | 177 | 58,8% | −2,09 |
| 6 | 8 | 37,5% | 35 | 65,7% | −1,58 |
| **soma** | **143** | | **15.973** | | **−6,55** |

**`delta_padronizado (cobertura completa) = −6,55 p.p.`**

Com cobertura rigorosa, a associação é **negativa e maior em magnitude**: ele
sobe **menos** antes de parar do que durante o movimento normal.

## 1.4 Correções factuais

### "No máximo 3 amostras em 600 ms" — ERRADO

Distribuição real de amostras **anteriores** numa janela de 600 ms:

```
0: 1.581   1: 1.591   2: 4.659   3: 12.294
4: 3.294   5: 505     6: 71      7: 12     8: 4
máximo observado: 8
```

**São até 8 amostras**, não 3. A confusão veio de usar a mediana (203 ms) como
se fosse o único intervalo possível.

### A estatística de 203 ms

| estatística | valor |
| :--- | ---: |
| mínimo | 15 ms |
| **mediana** | **203 ms** |
| média | 162,4 ms |
| p90 | 235 ms |
| p95 | 250 ms |
| máximo | 281 ms |

O valor mais frequente é 203 ms (4.791 de 22.392 = **21,4%**) — é a **moda**,
não a mediana. A distribuição é bimodal (picos em 203 e 250), com cauda de
intervalos curtos (47 ms, 94 ms). Descrever como "cadência de 203 ms" é
impreciso; o correto é "mediana 203 ms, média 162 ms, distribuição irregular
entre 15 e 281 ms".

### As "três leituras" do estrato n=2 — incluíam a transição

O teste de histórico usa **apenas amostras anteriores**. Verificado em 4 casos:

```
ep=220  anteriores: count=7 (t=44893062), count=7 (t=44893281)
        frame da transição: count=7  ← EXCLUÍDO
ep=297  anteriores: 6, 6   | transição: 6
ep=513  anteriores: 8, 8   | transição: 8
ep=573  anteriores: 7, 7   | transição: 7
```

O `7,7,7` que reportei antes era "2 anteriores + o atual". A afirmação
"count idêntico nas 3 leituras" estava inflada pelo frame da transição. O teste
correto usa 2 valores, ambos anteriores.

## 1.5 As duas respostas separadas

### (a) A subida é condição **necessária** para parar?

**NÃO**, no intervalo observado.

| métrica | valor |
| :--- | ---: |
| entradas testáveis (≥2 anteriores) | 155 |
| com subida nos 600 ms anteriores | 47 (30,3%) |
| **sem subida** (todas anteriores iguais) | **108 (69,7%)** |
| histórico totalmente estável (anterior) | 102 (65,8%) |

**108 de 155 paradas ocorreram sem nenhuma subida prévia observada.** Exemplos:

```
ep=0   t=44027750  anteriores=[5,5,5,5]          transição → count 5
ep=39  t=44194515  anteriores=[7,7,7]            transição → count 7
ep=61  t=44269406  anteriores=[7,7,7,7,7,7]      transição → count 8
ep=74  t=44311140  anteriores=[10,10,10,10,10]   transição → count 9
ep=78  t=44325500  anteriores=[8,8,8]            transição → count 8
```

**Ressalva obrigatória:** isso refuta a condição necessária **apenas no
intervalo efetivamente observado** (600 ms, resolução de ~203 ms). Uma subida
que aconteça em janela menor que a cadência é **invisível** a este log.

### (b) Qual associação foi estimada após o ajuste?

| estimador | delta | interpretação |
| :--- | ---: | :--- |
| pooled (enviesado) | +7,35 p.p. | artefato de ponderação |
| **padronizado (155 entradas)** | **−0,57 p.p.** | **nulo** |
| **padronizado (cobertura completa, 143)** | **−6,55 p.p.** | **negativo** |

**Estimativa ajustada: −0,57 p.p.** (população completa) ou **−6,55 p.p.**
(cobertura rigorosa). Ambos **não sustentam** a hipótese "count sobe antes da
parada".

**Limitação:** a amostra é de uma única sessão; episódios e janelas se
sobrepõem, então os controles não são independentes. Sem IC (justificado em
1.2). O resultado vale como **descrição da amostra**, não como estimativa
populacional.

---

# PARTE 2 — Piloto de 60 segundos (BLOQUEADO — material ausente)

## 2.0 Estado da verificação

Verificado em 2026-11-11 16:49. **O piloto não existe.**

| busca | resultado |
| :--- | :--- |
| `captures/pilot-*` | **0** |
| `*.mp4/mkv/webm/avi/mov` com `Poke\|PKA\|Shiba\|Alliance\|pilot\|Usobot` (Videos, Desktop, Downloads, Documents, OneDrive) | **0** |
| `pilot-sync-*.json` em qualquer lugar do projeto | **0** |
| vídeos criados nas últimas 6 h | 3 arquivos, **todos do League of Legends** (SteelSeries Moments) |

Portanto **a Parte 2 não foi executada** e **a Parte 3 não pôde rodar**.

Não há PTS de frame, não há linha de JSONL pareada, não há alinhamento A/B/C.
Nenhum número de latência pode ser produzido.

## 2.1 Arquivos a produzir

Checklist para o operador:

| # | arquivo | especificação |
| ---: | :--- | :--- |
| 1 | `captures/pilot-<data>.mp4` | tela inteira, **60 fps CFR**, sem escala dinâmica, sem reescalonamento |
| 2 | `native/pka_tap_<pid>.jsonl` | tap ativo **antes** de iniciar a gravação; mesma sessão |
| 3 | `analysis/lure-stop-rule/pilot-sync-<data>.json` | anotações manuais (formato abaixo) |

## 2.2 Roteiro do piloto

1. Tap já ativo. Iniciar gravação.
2. **Marcador A (início):** abrir e fechar o menu do Shiba uma vez. Aguardar 3 s.
3. Deixar o bot rodar ~20 s (para haver lure).
4. **Marcador B (meio):** disparar `!autocombo` no chat. Aguardar 3 s.
5. Deixar rodar ~20 s.
6. **Marcador C (fim):** abrir e fechar o menu outra vez. Aguardar 2 s.
7. Parar gravação. Parar tap.

## 2.3 Formato do arquivo de sincronização

```json
{
  "session": "pilot-2026-11-XX",
  "videoFps": 60,
  "videoFile": "captures/pilot-2026-11-XX.mp4",
  "logFile": "native/pka_tap_<pid>.jsonl",
  "markers": [
    { "id": "A", "kind": "menu-open",  "videoFrame": 123,  "logT": 44123456, "logLine": 17 },
    { "id": "B", "kind": "autocombo",  "videoFrame": 1892, "logT": 44158900, "logLine": 342 },
    { "id": "C", "kind": "menu-open",  "videoFrame": 3610, "logT": 44175100, "logLine": 655 }
  ]
}
```

`videoFrame` = número do frame no arquivo (PTS/duração por frame).
`logT` = campo `t` do kind6 correspondente.
`logLine` = número da linha no JSONL que comprova.

## 2.4 Verificação antes de medir latência

| verificação | critério |
| :--- | :--- |
| marcador aparece no vídeo | inspeção visual do frame indicado |
| marcador tem registro no log | linha do JSONL aponta transição coerente |
| offset A→C consistente | `deriva = (Δt_video − Δt_log)` |
| marcador B confere | `t_video(B) − offset` deve cair perto de `t_log(B)` |

```
offset  = t_video(A) − t_log(A)              [ms]
deriva  = (t_video(C) − t_video(A)) − (t_log(C) − t_log(A))   [ms total]
deriva_ms_per_min = deriva / ((t_video(C) − t_video(A)) / 60000)
erro_B  = (t_video(B) − offset) − t_log(B)   [ms]
incerteza = ±(0,5 frame = 8,3 ms) + |deriva|/2 + |erro_B|
```

**Critério de aceitação:**

| grandeza | limite | ação se exceder |
| :--- | :--- | :--- |
| `erro_B` | **33 ms** (= 2 frames a 60 fps) | revisar o pareamento dos marcadores e, se necessário, repetir o piloto com trecho mais curto |
| `deriva_ms_per_min` | reportar sempre, sem limite fixo | se a deriva for alta, encurtar a janela de medição |

**Encurtar a janela de associação (±1.000 ms) NÃO corrige sincronização.** A
janela é para associar eventos, não para esconder desalinhamento de relógio.

Se `erro_B > 33 ms` mesmo após revisar o pareamento, o alinhamento não é
confiável e a latência absoluta fica **indisponível**.

## 2.5 Sobre o atraso visual→pipe

O `t` do log é `GetTickCount()` na **escrita no pipe** (`pka_tap.c:149`). Entre o
evento visual e essa escrita há latência desconhecida do próprio jogo/menu.

**Se esse atraso não puder ser limitado**, reportar a diferença de tempo como
**estimativa sob o alinhamento adotado** e deixar a **ordem absoluta em aberto**.

---

# PARTE 3 — Validação por evento (NÃO EXECUTADA — depende do piloto)

Protocolo pronto. Executa assim que os três arquivos da seção 2.1 existirem.

## 3.1 Detecção de movimento

A câmera centraliza o personagem → usar **cenário fixo** (tile, árvore, quina).

- **repouso** = ≥100 ms entre o primeiro e o último frame imóvel
- a 60 fps: **7 frames** do primeiro ao último (6 intervalos = 100 ms)
- **início da parada** = o **primeiro** frame da sequência imóvel confirmada

Classificar como **não avaliável**: oclusão, imagem congelada (frame repetido),
referência visual insuficiente.

## 3.2 Associação — 1:1 obrigatória

```
janela = ±1.000 ms   (declarada antes da análise)
```

| classificação | critério |
| :--- | :--- |
| **parada associada** | exatamente 1 parada na janela; cada parada usada **uma vez** |
| **já imóvel** | personagem já parado; início fora da janela |
| **sem parada confirmada** | nenhuma parada na janela |
| **ambígua** | 2+ paradas plausíveis — **não forçar par** |
| **não avaliável** | trecho com oclusão/congelamento |

Contar também **paradas visuais sem transição associada** (recíproca).

## 3.3 Métrica

```
Δt = t(parada visual, alinhado) − t(primeiro holding=true no pipe)
```

- **Δt > 0** → a escrita no pipe **precedeu** a parada visual sob o alinhamento
- **Δt < 0** → a parada visual precedeu o registro

**Se o intervalo de incerteza incluir zero → ordem INDETERMINADA.**

Reportar: pares válidos, mediana, p90, incerteza (alinhamento + 8,3 ms de
resolução de frame).

## 3.4 Estado

**Nenhuma linha desta tabela pode ser preenchida** sem o piloto. Não há:

- PTS de frame (não há MP4)
- linha de JSONL pareada (não há `pilot-sync-*.json`)
- alinhamento A/B/C verificado

O atraso sistemático entre a aparição visual do marcador e sua escrita no pipe
permanece **desconhecido**. Se continuar assim após o piloto, a diferença de
tempo será reportada como **estimativa sob o alinhamento adotado**, com a
**ordem absoluta em aberto** — exatamente como instruído.

---

# Entrega

## Tabela corrigida (resumo)

| estimador | população | delta | veredito |
| :--- | :--- | ---: | :--- |
| pooled | 155 entradas / 20.334 controles | +7,35 p.p. | **artefato de ponderação** |
| **padronizado** | 155 entradas | **−0,57 p.p.** | **nulo** |
| **padronizado, cobertura completa** | 143 entradas / 15.973 controles | **−6,55 p.p.** | **negativo** |

## Fórmula do ajuste

```
delta_padronizado = Σ_estrato ( (n_entradas_estrato / N_entradas_total) × (taxa_entradas_estrato − taxa_controles_estrato) )
```

## Comando para reproduzir

```bash
node tools/lure-count-history.cjs \
  --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl
```

Saída completa (incluindo `stratified.pooled`, `stratified.standardized` e
`fullCoverage`): `analysis/lure-stop-rule/count-history.json`.

## Estado final

| item | estado |
| :--- | :--- |
| integridade do snapshot | **OK**, hash reconferido |
| diferença 20.348 vs 20.334 | **explicada** — estratos n=7 (10) e n=8 (4) sem entradas ficam fora do pooled |
| diferença 68 vs 102 | **explicada** — 68 incluía o frame da transição; 102 usa só anteriores (válido) |
| estimador corrigido | **−0,57 p.p.** (≠ +7,3) |
| cobertura completa | **−6,55 p.p.** |
| subida como condição necessária | **refutada** no intervalo observado (108/155) |
| máximo de amostras em 600 ms | **8** (não 3) |
| 203 ms | **moda** (mediana 203, média 162,4) |
| frame da transição no teste | **excluído** (confirmado em 4 casos) |
| **piloto de 60 s** | **NÃO EXISTE** — verificado 2026-11-11 16:49 |
| **validação por evento** | **NÃO EXECUTADA** |
| **parada física** | **NÃO VERIFICADA** |
| **latência holding → parada** | **INDISPONÍVEL** |

## Checklist único (o que falta)

```
[ ] 1. captures/pilot-<data>.mp4        tela inteira, 60 fps CFR
[ ] 2. native/pka_tap_<pid>.jsonl       tap ativo na MESMA sessão
[ ] 3. pilot-sync-<data>.json           marcadores A (início), B (meio), C (fim)
                                        com videoFrame + logT + logLine
[ ] 4. verificar offset/deriva/erro antes de medir latência
```

Com esses três arquivos, a Parte 3 roda em ~90 min para 60–80 paradas.

A posição dos selvagens fica fora desta tarefa.
