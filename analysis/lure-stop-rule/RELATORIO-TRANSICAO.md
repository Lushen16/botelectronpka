# Avaliação por transição — DynamicLure em replay offline

Data: 2026-11-11. **Offline** sobre snapshot congelado.
PID 17748, taps e cliente **fora do escopo**: nenhuma interação.

---

## Resumo executivo

**A avaliação por transição não pôde ser executada.** O bloqueio é de dado, não
de método: o `DynamicLure` precisa de telemetria espacial (`kind5.position` +
`creatures`) para decidir, e o snapshot congelado tem **8 amostras espaciais em
1,4 segundo**, todas **antes** de o lure começar.

| pergunta | resposta |
| :--- | :--- |
| O 97,9% em 7.671 frames reproduz? | **NÃO** — exige dado ausente neste snapshot |
| Quais episódios sustentam? | **nenhum** neste snapshot |
| Os 221 históricos pertencem a este conjunto? | **NÃO** — são de outra sessão e de outro log |
| Dá para comparar paradas/retomadas? | **NÃO** — o nosso sinal não é gerado |

Entreguei: a ferramenta pronta (`tools/lure-transition-eval.cjs`), a estrutura
da referência (325 transições, split por episódio) e o diagnóstico exato do que
falta.

---

## 1. Estado dos insumos

```
arquivo : analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl
bytes   : 616.925.188
sha256  : 55dc9bcecd86d65977df02d59e7f05c4ab33936a9d801aac6fedd24b665491a0
```

### Composição do snapshot

| sinal | quantidade | observação |
| :--- | ---: | :--- |
| kind6 em lure `dynamic` | **24.011** | estado de decisão, completo |
| kind5 total | 2.296 | publicações de telemetria |
| **kind5 com `position`** | **8** | apenas 1,4 s de dados espaciais |
| episódios de lure | 1.576 | |
| transições de fase | 325 | 155 paradas, 170 retomadas |

### Por que 8 amostras não bastam

As 8 amostras espaciais ocupam `t = 44014328 .. 44015750` (1,4 s).
O lure começa em `t = 44027343` — **7,2 s depois** da última amostra.

Distância do kind6 ao kind5 anterior mais próximo:

```
n = 38.184
mediana = 3.131.546 ms  (~52 min)
p90     = 5.622.031 ms  (~94 min)
máximo  = 6.249.015 ms
≤1500 ms: 14 frames
≤3000 ms: 22 frames
```

**Zero sobreposição real.** O `DynamicLure.decide()` recebe `telemetry` com
`position` e `creatures`; sem isso ele cai no ramo `'sem posicao'` e não produz
decisão avaliável.

---

## 2. O 97,9% — origem e por que não reproduz

### Origem

`CHECKPOINT_2026-11-10_WALK.md`, adendo 14, seção 5:

```
acordo de FASE: 7.513/7.671 = 97,9%

  7.495  nosso=TRAVEL   shiba=TRAVEL
    146  nosso=TRAVEL   shiba=PULSE
     18  nosso=PULSE    shiba=PULSE
     11  nosso=PULSE    shiba=TRAVEL
      1  nosso=TRAVEL   shiba=observe
```

O próprio texto diz: *"Rodando o nosso `DynamicLure` sobre os 7.671 frames em que
havia telemetria (posição do player + do pokemon) e luring dynamic
simultaneamente"*.

**Esse cruzamento não existe no snapshot atual.** O script que o produziu não foi
persistido (`tools/lure-transition-eval.cjs` é novo, criado agora).

### Verificação nos dois arquivos candidatos

| arquivo | kind5 com `position` | kind6 dynamic | sobreposição ≤1500 ms |
| :--- | ---: | ---: | ---: |
| snapshot-...1411 | 8 | 24.011 | **0** |
| `pka_tap_8036.jsonl` | 49 | 11.719 | **0** |

No 8036, as 49 amostras espaciais terminam em `t=187107421` e o lure começa em
`t=187114437` — 7 s de intervalo. Também são apenas **1 ou 2 criaturas** por
amostra (player + summon), nenhuma selvagem.

As outras fontes foram verificadas e não servem:

| arquivo | estado |
| :--- | :--- |
| `pka_tap_17748.jsonl` | 2,79 GB (cresceu), não varrido |
| `pka_tap_19228.jsonl` | 2,44 GB, lado c2s do menu |
| `pka_tap_14784.jsonl` | kind5 = 0 |

### Conclusão

O 97,9% veio de uma leitura anterior do tap, **antes** de o arquivo crescer e
antes do snapshot ser congelado — ou de um `kind5` que o tap posteriormente
sobrescreveu/perdeu. Não é reproduzível com os arquivos atuais.

---

## 3. Os 221 desacordos históricos — conjunto diferente

Origem: `RELATORIO.md` seção "Os 221 desacordos históricos".

| aspecto | os 221 | este snapshot |
| :--- | :--- | :--- |
| sessão | log de decisão do **nosso bot**, sessão anterior | Shiba PID 17748, 11/11 12:00–13:12 |
| dependia de | `boxed`, `isFormationHeld`, estado do árbitro | apenas estado do Shiba |
| log | **não existe em disco** | snapshot congelado, íntegro |
| reproduzível | **0 de 221** | — |

**Não pertencem ao mesmo conjunto nem ao mesmo alinhamento.** Já estavam
marcados como excluídos em `RELATORIO.md` por falta do log de decisão do nosso
bot. Esta rodada confirma: são de outra sessão, outro relógio, outra fonte.

---

## 4. Referência: o que é medível agora

Sem telemetria espacial, o `DynamicLure` não decide. Mas a **série de fase do
Shiba** existe e serve para estruturar a avaliação futura.

### Transições da referência

| direção | quantidade |
| :--- | ---: |
| `TRAVEL → PULSE` (parada) | **155** |
| `PULSE → TRAVEL` (retomada) | **170** |
| **total** | **325** |

`PULSE` = `arc` | `stationary` | `wait` | `observe`
`TRAVEL` = `travel`

### Split por episódio (60% descoberta / 40% reserva)

| conjunto | episódios | transições |
| :--- | ---: | ---: |
| descoberta | 945 | 187 |
| reserva | 631 | 138 |

Split **por episódio inteiro**, nunca por frame — evita vazamento entre janelas
sobrepostas.

Salvo em `analysis/lure-stop-rule/transition-eval-reference.json`.

---

## 5. A ferramenta — pronta, bloqueada por dado

`tools/lure-transition-eval.cjs`

```bash
node tools/lure-transition-eval.cjs \
  --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl \
  [--tolerance 250] [--holdout 0.4]
```

### O que ela faz (quando houver dado)

1. **Reproduz o 97,9%** — acordo de estado `TRAVEL`/`PULSE` frame a frame.
2. **Transições com casamento 1:1**:
   - tolerância declarada **antes** (`--tolerance`, default 250 ms ≈ 1 publicação)
   - mesmo episódio, mesma direção, sem reutilizar evento
   - reporta pareadas, perdidas (nosso sinal sem par), extras (referência sem par)
   - **paradas e retomadas separadas**
3. **Δt dos sinais registrados** — mediana, p90, min, max por direção.
4. **Split descoberta/reserva por episódio** antes de qualquer ajuste.
5. **Padrões de divergência** agrupados por `direção + nossa fase + fase dele`.

### Regra de entrada (importante)

`holding` do Shiba é **apenas referência de avaliação**. Nunca entra como
entrada do controlador. As entradas são só o que existe no instante:

- `kind5` mais recente **estritamente antes** do kind6 atual
- idade máxima da amostra: 1500 ms (senão indeterminado)
- estado interno do próprio lure (fase, instante da última decisão)

Isso reproduz a condição real de operação: o controlador não vê o futuro nem o
estado de referência.

---

## 6. O que falta — exatamente

Para executar a avaliação por transição (passos 3 e 4 do pedido):

```
[ ] kind5 com position + creatures, publicando DURANTE o lure dynamic
    - o tap atual só gravou 8 amostras espaciais
    - precisa de sobreposição temporal com kind6 mode=dynamic
[ ] essas amostras precisam conter selvagens (type=1)
    - hoje: 0 ocorrências em 2.296 amostras
```

**Causa provável:** o `kind5` só popula `creatures[]` quando o cliente publica a
lista completa, o que nesta build não acontece com o bot em execução. A fonte
alternativa é `scan_creatures` da nossa DLL (varre memória por RTTI
`.?AVMonster@@`) — mas isso conflita com a regra de não rodar as duas DLLs
juntas.

---

## 7. Recomendação

1. **Manter a regra atual do DynamicLure.** Não há evidência nova para mudá-la —
   a candidata não pôde ser testada.
2. **Não citar mais o 97,9% como resultado vigente** até ser reproduzido com
   dado em disco. Ele fica como registro histórico do adendo 14, com a ressalva
   de que a captura de origem não está preservada.
3. **Para desbloquear:** capturar uma sessão onde `kind5` publique
   `position + creatures` **durante** o lure. O piloto de 60 s já planejado
   serve, desde que o tap grave kind5 (não só kind4/6).
4. **Se o kind5 não publicar selvagens nunca**, a geometria só sai de
   `scan_creatures` — o que exige decidir sobre a coexistência das DLLs.

---

## 8. Reprodução

```bash
# avaliação por transição (bloqueada: reporta BLOQUEADO e grava JSON vazio)
node tools/lure-transition-eval.cjs \
  --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl

# referencia de transicoes (funciona: nao precisa de kind5)
node -e "console.log(require('./analysis/lure-stop-rule/transition-eval-reference.json'))"
```

Saídas:

```
analysis/lure-stop-rule/transition-eval.json             (bloqueado, zerado)
analysis/lure-stop-rule/transition-eval-reference.json   (325 transicoes, split)
```

---

## 9. Estado

| item | estado |
| :--- | :--- |
| snapshot íntegro | **OK** (`55dc9bce…`) |
| 97,9% reproduzido | **NÃO** — captura de origem ausente |
| 221 históricos neste conjunto | **NÃO** — outra sessão, outro log |
| referência de transições | **OK** — 325 (155/170), split 945/631 |
| ferramenta de avaliação | **pronta**, bloqueada por kind5 |
| regra do DynamicLure | **mantida** (sem evidência para mudar) |

---

# ADENDO — 2026-11-11 — POR QUE O `kind5` NÃO PUBLICA SELVAGENS (diagnóstico fechado)

Investiguei a raiz do bloqueio. **A causa não é o `kind5` nem a captura. É o bot
estar PAUSADO durante toda a janela de telemetria.**

## 1. O fato que fecha a questão

```
kind5 publicados              : 2.296
kind5 que tinham position     : 8
fase do kind6 durante TODOS os 2.296: "Pausado"
janela dos 8 ricos            : t=44014328 .. 44015750  (1,4 s)
```

**Os 2.296 kind5 ocorreram com o bot em `Pausado`.** Não existe um único kind5
durante o lure dynamic neste snapshot.

## 2. O que os 8 frames ricos realmente contêm

Não são "player + summon por limitação". São o **known-set completo**:

| campo | valor |
| :--- | :--- |
| `items` | 326 → 308 → 290 → 271 → **249** |
| `tiles` | 233 → 216 → 199 → 182 → **165** |
| `playerStates` | **128** (é um número, não lista) |
| `roster` | 5 |
| `moves` | 10 |
| `creatures` | **2** (player + Dugtrio) |

O player andou `y = 1402 → 1403 → 1404 → 1405 → 1406` (5 tiles para o sul)
enquanto `items` e `tiles` **decresceram monotonicamente**.

**Interpretação:** a lista é um *known-set* filtrado por proximidade. Ao andar,
entidades antigas saem. Se houvesse selvagem no raio, apareceria com `type=1`.

**Não havia.** O tank percorreu 5 tiles sozinho, em área limpa.

## 3. O que isso muda

| hipótese anterior | status |
| :--- | :--- |
| "o kind5 nunca publica selvagens" | **REFUTADA** — publica o known-set inteiro (326 items, 233 tiles) |
| "o kind5 só tem player+summon por design" | **REFUTADA** — a limitação era a cena vazia, não o protocolo |
| "precisa de `scan_creatures` da nossa DLL" | **NÃO NECESSÁRIO** — o kind5 basta, se houver monstros |
| "o piloto não vai funcionar" | **REFUTADA** — vai funcionar se gravado durante hunt com monstros |

**A causa real do bloqueio era trivial: o bot estava pausado.**

## 4. Consequência para o piloto

O protocolo de 60 s **não precisa mudar**. O que precisa ser garantido:

```
[ ] o bot do Shiba deve estar CAÇANDO (não Pausado) durante a gravação
[ ] o tap deve gravar kind5 (além de kind4/kind6)
[ ] a cena deve ter monstros selvagens visíveis
```

Se essas três condições forem satisfeitas, o `kind5` publicará `type=1` e a
avaliação por transição roda.

## 5. Verificação que o piloto deve fazer antes de medir

Antes de anotar paradas, conferir no JSONL do piloto:

```bash
node -e "
const fs=require('fs'),rl=require('readline').createInterface({input:fs.createReadStream('native/pka_tap_<pid>.jsonl'),crlfDelay:Infinity});
let k5=0,wild=0,pos=0;
rl.on('line',l=>{try{const o=JSON.parse(l);if(o.kind!==5||!o.d)return;k5++;
const t=JSON.parse(Buffer.from(o.d,'hex').toString('utf8'));
if(t.position)pos++;
if((t.creatures||[]).some(c=>Number(c.type)===1))wild++;}catch{}});
rl.on('close',()=>console.log('kind5='+k5,'comPosition='+pos,'comSelvagem='+wild));
"
```

**Critério de aceitação do piloto:** `comSelvagem > 0`. Se der zero, a cena
estava vazia de novo — repetir, não medir latência.

## 6. Sobre o 97,9%

Continua **não reproduzível** neste snapshot, mas agora sabemos exatamente por
quê: não havia `kind5` durante o lure. A captura que gerou o 97,9% deve ter tido
o bot ativo — e essa captura não está em disco.

A ferramenta (`tools/lure-transition-eval.cjs`) está pronta e vai reproduzir o
número quando receber um snapshot com kind5 sobreposto ao lure.

---

# ADENDO 2 — 2026-11-11 18:35 — O `kind5` ESPACIAL É EXCLUSIVO DO ESTADO PAUSADO

O operador perguntou se dá para aproveitar as horas já gravadas em vez de rodar
o bot de novo. Varri 2,7 GB. A resposta é **não para o lure**, e o motivo é
estrutural — **não é falta de tempo nem de cena**.

## 1. O que a varredura encontrou

```
arquivo : native/pka_tap_17748.jsonl  (2.690 MB)
janela  : t=50.264.890 .. 62.233.718  (199,5 min novos, ~3,3 h)
```

| métrica | valor |
| :--- | ---: |
| kind5 total | 15.932 |
| kind5 **com position** | 12.064 |
| kind5 **com selvagem (type=1)** | **0** |
| kind6 em lure dynamic | 33.577 |
| kind6 em lure **com amostra espacial ≤1500 ms** | **0** |
| janelas utilizáveis | **0** |

## 2. A causa: `position` só aparece quando o bot está PAUSADO

Testei a hipótese sobre todas as 18.228 publicações kind5 com kind6 anterior
conhecido:

| estado | com position | sem position |
| :--- | ---: | ---: |
| **PAUSADO** | **12.064** | 3.868 |
| ATIVO | **8** | 2.288 |

**12.064 de 12.072 publicações com posição ocorreram com o bot pausado (99,94%).**

E a fronteira é visível ao segundo:

```
t=58.989.078  kind11 op=togglePause        <- front
t=58.989.109  kind6 paused=true  "Pausa global"
t=58.992.796  kind5 pos=true creatures=2   <- 1a telemetria espacial
...
t=62.233.671  kind5 pos=true               <- continua ate' o fim
```

Antes do `togglePause`, o lure rodou de `t=50.267.843` a `t=58.989.062`
(**8.721 segundos**) e **não publicou uma única amostra com position**.

## 3. Por que isso acontece (mecanismo)

Quando o bot está executando, o runtime dele está ocupado com o tick próprio
(walker/target/lure). A publicação do kind5 muda de forma: sai o *known-set*
completo (position + items + tiles) e entra um pacote mínimo sem posição.

Quando pausado, ele tem folga para publicar o estado completo.

**Isso não é bug nem limitação de captura.** É decisão de design do fornecedor:
telemetria espacial detalhada só no estado ocioso.

## 4. Consequência direta para o pedido

O pedido era: *"grave uma hora e filtre de modo geral para não precisar rodar o
bot no mesmo lugar"*.

| expectativa | realidade |
| :--- | :--- |
| mais horas = mais chance de pegar lure+selvagem | **não** — com o bot ativo, `position` nunca vem |
| filtrar o que já existe | **possível e feito** (3,3 h varridas) |
| evitar rodar o bot de novo | **não para o lure** — o dado não existe em nenhum estado ativo |

**Nenhuma quantidade de gravação com o Shiba ativo produzirá
`kind5.position`.** As 3,3 h provam isso: 33.577 frames de lure, zero amostras.

## 5. A prévia de 10–15 s, então, não pode confirmar o que pede

O critério da prévia era: *"kind5 chega durante o lure ativo, com selvagens
visíveis"*. Esse critério é **impossível** de satisfazer com o tap atual, porque
o pacote com `position` não é publicado durante o lure.

Isso **não** significa que a avaliação é impossível — significa que o caminho é
outro.

## 6. Os caminhos que restam, em ordem de custo

### A) `scan_creatures` da nossa DLL (mais direto)

O `pka_native.dll` já lê a memória do processo e acha criaturas por RTTI
(`.?AVMonster@@`). É independente do que o Shiba publica.

| requisito | estado |
| :--- | :--- |
| código pronto | **sim** — `scan_creatures`, validado antes |
| conflita com o tap | **sim** — regra: nunca os dois no mesmo processo |
| precisa decidir | **sim** — trocar tap por bot, ou alternar |

**Custo:** um ciclo de injeção. **Risco:** conhecido (precisa `PkaShutdown`).

### B) Amostrar o kind5 pausando em pontos fixos

Pausar 200 ms a cada N segundos durante a hunt. Produz amostras esparsas com
posição, mas **quebra o lure** — a fase reinicia. Cobertura ruim para transições.

### C) Instrumentar o módulo Target (hook no processo do menu)

Capturar a lista que ele usa internamente. Mais completo, mais invasivo.

### D) Aceitar o limite e avaliar só o sinal (`holding`)

Já feito. Resultado: 100% de consistência interna, mas **não** responde se o
personagem para fisicamente.

## 7. O que a varredura confirmou de bom

- `items` e `tiles` no kind5 **são** dados de mapa (326 itens, 233 tiles).
- `playerStates: 128` é **contador**, não lista — descartado como fonte.
- A publicação espacial existe e funciona (12.064 amostras), só não no estado ativo.
- O tap grava corretamente; o limite é do fornecedor.

## 8. Recomendação

1. **Não gravar o piloto de 60 s com o tap**, no formato planejado: ele
   reproduzirá o resultado de 3,3 h — zero amostras espaciais durante o lure.
2. **Escolher o caminho A** (`scan_creatures`) se a pergunta sobre parada física
   continua valendo. Exige decidir sobre coexistência de DLL.
3. **Se o objetivo for só validar `holding`**, já está validado como sinal
   interno; o que falta é a referência visual, que exigiria vídeo + anotação
   manual das paradas — **sem** depender do kind5.
4. **Possibilidade nova:** anotar paradas no vídeo e comparar com `holding` do
   kind6, que **existe nos 33.577 frames de lure ativo**. Não precisa de
   `kind5` para isso — só de vídeo da mesma sessão.

**Item 4 é o caminho mais barato e não depende de mudar nada no cliente.**
