# Medir `holding` contra o movimento real — sem vídeo, sem API

Data: 2026-11-12. Substitui o caminho vídeo + visão para esta pergunta.

---

## Por que este caminho

A pergunta é: **`holding` do kind6 acompanha a parada e a retomada físicas do
personagem?**

O caminho proposto antes era gravar vídeo e mandar frames para uma API de visão.
Funciona, mas é indireto, caro e depende de chave externa. A posição do
personagem está na memória do processo e pode ser lida com **RPM puro** — sem
injeção, sem DLL, sem API, sem enviar nada para fora.

Mais importante: a posição vem do **mesmo relógio** do kind6 (`GetTickCount` do
sistema). Isso elimina toda a etapa de sincronização por marcadores.

| | vídeo + visão | posição por RPM |
| :--- | :--- | :--- |
| precisa de API | sim | **não** |
| precisa de anotação humana | sim | **não** |
| sincronização | marcadores A/B/C | **mesmo relógio** |
| sujeito a oclusão/câmera | sim | **não** |
| precisão | frames (16–33 ms) | **33 ms a 30 Hz** |
| custo | API + tempo | zero |

O pipeline de vídeo (`tools/video_motion/`, entregue pelo GPT, 18 testes) fica
como **documentação de fallback** — não é o caminho principal.

---

## Ferramentas

### `tools/position_sampler.py`

Amostra a posição real via `OpenProcess` + `ReadProcessMemory`, reusando
`tools/lp_state.py` (que já resolve o LocalPlayer por global e por vtable).

```bash
python tools/position_sampler.py --pid <PID> --seconds 120 --hz 30 \
    --out captures/motion/pos.jsonl
```

Medido no cliente (PID 1712):

```
30 Hz solicitado -> 30,17 Hz efetivo, 181/181 amostras OK, 0 erros
10 Hz solicitado -> 10,2 Hz efetivo,   81/81 amostras OK, 0 erros
```

Saída (uma linha por amostra):

```json
{"t": 5813843, "x": 957, "y": 1403, "z": 6, "hp": 100,
 "name": "Usobot", "id": 268440331, "online": true, "err": null}
```

`t` é `GetTickCount()` do sistema — **a mesma API que o tap usa**. Daí o
alinhamento ser direto.

Transição de mapa invalida o VA do LocalPlayer; o sampler re-resolve pelo vtable
até 10 vezes, com intervalo mínimo de 2 s.

### `tools/holding_vs_motion.py`

Compara as duas séries e produz o resultado.

```bash
python tools/holding_vs_motion.py \
    --kind6 native/pka_tap_<pid>.jsonl \
    --position captures/motion/pos.jsonl \
    --out captures/motion/result.json \
    --tolerance-ms 250 --stop-min-ms 300
```

---

## Definições (congeladas)

**Movimento real**, derivado só da posição:

| evento | definição |
| :--- | :--- |
| *move* | `(x,y)` diferente entre amostras consecutivas |
| **parada** | `(x,y)` constante por ≥ `--stop-min-ms` (default 300 ms) |
| **retomada** | primeira mudança de `(x,y)` após uma parada |

O início da parada é datado no **fim do último deslocamento** — a última amostra
antes de ficar imóvel — não no instante de confirmação. Isso evita enviesar
Δt com o tempo de confirmação.

`z` diferente **não** conta como movimento horizontal (andar de andar).

**`holding`**:

| evento | definição |
| :--- | :--- |
| parada | transição `false→true` |
| retomada | transição `true→false` |

Só entram amostras com `mode=dynamic` e `paused != true`.

**Pareamento**: 1:1 por direção, mesmo episódio de lure, `|Δt| ≤ tolerance`.
Evento sem par de qualquer lado é preservado no relatório, nunca forçado.
Empate técnico (dois candidatos a menos de 1 ms de distância) é marcado
**ambíguo** e não pareado.

---

## Contratos verificados

`tests/holding_vs_motion.test.cjs` — 7 testes:

```
1. detecção de parada+retomada e pareamento com holding          OK
2. movimento de uma amostra NÃO vira parada                      OK
3. z diferente não conta como movimento horizontal               OK
4. parada no fim do registro não inventa retomada                OK
5. sem kind6 válido o comparador RECUSA (não inventa resultado)  OK
6. tolerância zero pareia só timestamp idêntico                  OK
7. sampler recusa pid inexistente sem travar                     OK
```

Suíte geral: **794 testes, 0 falhas** (subiu de 786).

---

## Procedimento para medir

Requer o Shiba **caçando** (não pausado) e a janela do jogo aberta.

```bash
# 1. descobrir o PID
Get-Process -Name PokeAlliance_dx | Select-Object Id

# 2. tap já deve estar carregado (se não, native/pka_inject.exe --pid <PID> --dll native/pka_tap.dll)

# 3. amostrar posição por 2–3 minutos, enquanto o bot caça
python tools/position_sampler.py --pid <PID> --seconds 180 --hz 30 \
    --out captures/motion/pos-<data>.jsonl

# 4. congelar um snapshot do tap (só a janela usada, para não carregar 2,7 GB)
#    (o tap continua escrevendo; o comparador exige entrada imutável)

# 5. comparar
python tools/holding_vs_motion.py \
    --kind6 <snapshot>.jsonl \
    --position captures/motion/pos-<data>.jsonl \
    --out captures/motion/result-<data>.json \
    --tolerance-ms 250 --stop-min-ms 300
```

---

## Como ler o resultado

```json
"stop": {
  "visual_events": 12,        <- paradas reais que a posição mostrou
  "holding_events": 11,       <- transições false->true do kind6
  "pairs": 10,                <- casadas dentro de 250 ms
  "unmatched_visual": 2,      <- ele parou e o sinal não mudou
  "unmatched_holding": 1,     <- o sinal mudou e ele não parou
  "dt_ms": { "median": 45, "p90_abs": 120 },
  "holding_after_motion": 8,  <- publicação veio depois da parada
  "holding_before_motion": 2
}
```

**Interpretação:**

| padrão | leitura |
| :--- | :--- |
| `pairs` alto, `unmatched_*` baixo, Δt pequeno | `holding` acompanha o movimento |
| `unmatched_visual` alto | ele para e o sinal não avisa — falso negativo |
| `unmatched_holding` alto | o sinal avisa e ele não para — falso positivo |
| Δt mediano negativo grande | o sinal **antecipa** a parada (pode ser preditivo) |
| Δt mediano ≈ métade da cadência do kind6 | apenas defasagem de publicação |

**Incerteza:** o relatório grava `alignment_uncertainty_ms` = metade do
intervalo mediano de amostragem. A 30 Hz, ~16 ms. Se `|Δt|` for menor que isso,
a ordem é indeterminada.

---

## Limites declarados

1. **Posição por tile, não sub-tile.** Um passo parcial entre tiles aparece como
   parada até completar. O limiar de 300 ms reduz isso, mas não elimina.
2. **RPM depende do layout do build.** `lp_state.py` detecta o deslocamento
   (`-0x10` no subobjeto base) e cai no vtable-scan quando o global é NULL.
   Build nova exige revalidar.
3. **30 Hz limita a resolução a ~16 ms** por amostra. Eventos mais rápidos que
   isso não são vistos — mas nenhuma parada real dura menos que isso.
4. **A causa da parada continua fora de escopo.** Este teste mede se o sinal
   acompanha o movimento, não por que ele para.
5. **Não reproduz os 97,9% históricos.** Aquele número usava `kind5`, que não é
   publicado no lure ativo.

---

## O que a medição vai responder

| pergunta | resposta esperada |
| :--- | :--- |
| `holding=true` corresponde a parada física? | sim/não, com contagem de falsos positivos |
| `holding=false` corresponde a retomada? | sim/não, com contagem de falsos negativos |
| o sinal antecipa ou atrasa o movimento? | Δt mediano e p90 |
| quantos eventos ficam sem par? | `unmatched_*` de cada lado |

Isso é exatamente o que a tarefa pedia — e não precisa de vídeo nem de chave.

---

# ADENDO — 2026-11-12 — MEDIÇÃO COM A NOSSA DLL (sem RPM, sem vídeo, sem API)

O caminho RPM foi descartado: é contra o objetivo do projeto. A posição agora vem
da **nossa `pka_native.dll`**, pelo canal nativo (kind 5), que é o produto final.

## 1. Três bugs reais corrigidos na DLL

### 1.1 `refresh_state()` rodava só a cada 8 s

`build_telemetry` publicava a posição que `scanner_thread` atualizava a cada
`SCAN_INTERVAL_MS = 8000`. A 20 Hz, isso publicava a **mesma posição 442 vezes**.

Medido: 442 amostras, 1 posição única.
Corrigido: `refresh_state()` antes de cada telemetry do canal de observação.

### 1.2 `g_playerVa` stale após transição de mapa

A DLL publicava `(956,1401)` enquanto o global `[base+0x39cb958]` já era
`(958,1401)`. O cache sobrevivia porque nome/hp/id continuavam válidos — só a
posição congelava.

Corrigido: em `refresh_state`, compara `g_playerVa` com o global. Se divergir,
descarta o cache e re-resolve.

### 1.3 Duas fontes de posição

`build_telemetry` chamava `entity_read(g_playerVa)` por conta própria, então uma
posição stale era publicada sem que `refresh_state` soubesse.

Corrigido: fonte única. `refresh_state` resolve e grava em
`g_posX/g_posY/g_posZ/g_havePos`; `build_telemetry` só lê essas globais.

## 2. Cadência configurável em runtime

`native/pka_observe_hz.txt` — conteúdo é o Hz (1..50). Lido pela DLL 1x/s.

| valor | intervalo | uso |
| :--- | :--- | :--- |
| ausente | 1000 ms | comportamento do fornecedor |
| `20` | 50 ms | observação de movimento |
| `50` | 20 ms | resolução máxima |

`TELEMETRY_INTERVAL_MS` não mudou — o protocolo do menu continua igual.

## 3. Medição no cliente (PID 1712)

```
358 amostras · 100% com position
8 walks enviados · 8 movimentos capturados
cadência: mediana 63 ms · p90 65 ms · max 73 ms
```

Transições reais observadas:

```
957,1402 -> 958,1402 -> 959,1402 -> 958 -> 957 -> 957,1403 -> 957,1404 -> 957,1403 -> 957,1402
```

## 4. DynamicLure sobre telemetria real

```
t+0ms    phase=arc         action=adjust-step  boxed=0
t+400ms  phase=stationary  action=hold         boxed=0
t+800ms  phase=arc         action=adjust-step  boxed=0
t+1200ms phase=travel      action=walk-route   boxed=0  (sem progresso em 4 ciclos)
```

Comportamento correto: pulsos curtos de ajuste, desiste e volta a andar quando
`boxed` não cresce.

## 5. Cena observada e por que `boxed=0`

```
player: (957,1402,z=6)
11 Magnemite, todas z=7, hp=100, dist 8..16 tiles
```

Duas razões independentes para `boxed=0`:

1. **`z` diferente** — `chebyshev` devolve `Infinity` quando `z` difere. Todas as
   11 estão um andar acima.
2. **distância 8..16** — mesmo em z igual, `range=4` do Perfect Lure não inclui
   nenhuma.

Isso é cena real, não bug: o personagem está embaixo e os monstros espalhados em
cima.

## 6. O que ainda falta para a medição completa

`holding` é conceito do **Shiba** (kind 6 dele). Nossa DLL não publica esse
campo. Três opções:

| opção | custo | observação |
| :--- | :--- | :--- |
| A. Shiba + tap em paralelo | precisa coexistência | conflita com nossa DLL no mesmo processo |
| B. adicionar `holding` ao nosso canal | DLL + protocolo | replica conceito do Shiba no produto |
| C. usar `DynamicLure.isRepositioning()` como sinal | **zero** | já existe e é nosso |

**C válida agora**: comparar o `isRepositioning()` do nosso engine (que vem do
`DynamicLure.decide`) com o movimento real medido pela nossa DLL. É a versão
autocontida da pergunta: "o nosso sinal de intenção acompanha o nosso movimento?"

A pergunta original era sobre o sinal **do Shiba**. Para ela, A ou B.

## 7. Estado

```
794 testes · 0 falhas
DLL pka_native.dll 227840 bytes
jogo 1712 vivo, DLL carregada, 11 criaturas detectadas
```

---

# ADENDO 2 — 2026-11-12 — ACHADO DA IA PARCEIRA: `roster` VAZIO BLOQUEIA O HEALER

Contribuicao de um segundo agente. Confirmado por leitura de codigo e de dados.

## 1. O bug

`native/pka_native.c:1861` publica literalmente:

```c
"\"roster\":[],\"creatures\":%s,\"items\":[],\"tiles\":[],"
```

E `:1858`:

```c
"\"playerName\":\"%s\",\"activeSlot\":0,\"moves\":[],..."
```

`roster`, `activeSlot`, `moves` e `comboPokemonName` sao **hardcoded vazios**.

## 2. Por que isso e' grave

`reconstruction/engines/healer-engine.cjs:9-15`:

```js
function rosterMatches(telemetry, name) {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  const matches = (Array.isArray(telemetry?.roster) ? telemetry.roster : [])
    .filter(entry => normalizeName(entry.name) === wanted);
  return matches.length === 1 ? matches[0] : null;
}
```

E na linha 80:

```js
const pokemon = rosterMatches(telemetry, healer.healPokemonName)
  || (options.keyboardOnly && ...);
```

**Em modo nativo (`keyboardOnly=false`), o fallback nao existe.** Portanto:

```
roster vazio  ->  rosterMatches() === null  ->  state.blocked('heal-pokemon-unresolved')
              ->  NENHUMA acao de cura
```

Isso aparece como `heal-pokemon-unresolved` em diagnostico, mas o efeito real e'
que o healer **nunca dispara** em modo nativo. O bot nao cura.

## 3. O Shiba publica esse campo

Medido nos 2.296 kind5 do snapshot (8 com roster nao-vazio, os unicos com
`position`):

```json
{"slot":1,"uuid":"f09e657e-5ab5-4de4-b265-197b33f49024","name":"Squirtle",
 "identityAvailable":true,"healthPercent":100,
 "moves":[{"spellword":"m1","remainingMs":0,"totalMs":12000}, ...]}
```

Campos: `slot`, `uuid`, `name`, `identityAvailable`, `healthPercent`, `moves[]`
com `spellword`/`remainingMs`/`totalMs`.

## 4. Impacto por capacidade

| capacidade | sem roster |
| :--- | :--- |
| walk | OK |
| attack | OK |
| talk / combo | OK |
| **healer (cura)** | **BLOQUEADO** |
| **switchPokemon** | **BLOQUEADO** (comando nem implementado na DLL) |

## 5. O que fazer

Duas partes, ambas ja' existentes no Shiba:

**a) Implementar `roster` na DLL.** Ler a lista de Pokemon do time da memoria
(como o Shiba faz) e publicar `slot`/`uuid`/`name`/`healthPercent`/`moves`.
Sem isso o healer nao tem identidade para curar.

**b) Implementar `switchPokemon` (tipo 8) e `potion` (tipo 12)** na DLL.
Hoje devolvem `STATUS_UNSUPPORTED`.

## 6. Correcao de uma afirmacao minha

Eu havia dito que "o healer existe e esta' testado, mas o comando nunca chega".
Estava incompleto: **o comando nem e' emitido**, porque o healer para antes, no
`rosterMatches`. O bloqueio e' anterior ao transporte.

## 7. Prioridade revisada do que falta

```
1. roster na DLL                  -> destrava o healer inteiro
2. switchPokemon + potion         -> acoes do healer
3. revive                         -> sobrevive a morte do pet
4. rota longa validada            -> prova o ciclo
5. captura / loot                 -> completa a hunt
```

O item 1 e' agora o mais critico, porque sem ele nem o diagnostico mostra a
causa certa.

---

# ADENDO 3 — 2026-11-12 — INVESTIGACAO DO `roster`: O CONCEITO E' "POKEBAR"

Tentativa de implementar `roster` na nossa DLL. Progresso e bloqueio.

## 1. O que o Shiba chama de roster e' a POKEBAR do jogo

Strings encontradas no modulo do jogo **em memoria** (o exe em disco esta'
empacotado, sem strings):

```
rva 0x1fbf950  POKEBAR_OFFENSIVE_MODE  POKEBAR_  "Pok..bar Pok..mon"
               pokebarProfile  DEFENSIVE_MODE  "Action Bar Order"  actionProfile
rva 0x1ff7417  "the pokeball in use will always appear at the top of the pokebar"
               "Quando ativado, a pokebola em uso sempre aparecera' no topo da barra"
rva 0x61c2e7   handler: ... H..I.pokebar ... (codigo que referencia a string)
```

E no payload do Shiba:

```
0xe4a9a  "roster"
0xe5c68  "Nome duplicado na pokebar: "
0xe75c0  "Pokemon nao encontrado na pokebar: "
0xe46ea  "spellword"
0xe4df2  "identityAvailable"
```

Ou seja: o "roster" do Shiba **e' a pokebar** — a barra de 6 pokebolas do jogo.
Cada slot tem um Pokemon, e o `identityAvailable` indica se o Pokemon daquele
slot e' identificavel (nome resolvido).

## 2. O que NAO funcionou (registrado para nao repetir)

| tentativa | resultado |
| :--- | :--- |
| procurar nomes do time (Squirtle, Diglett...) na memoria | achou 5, mas eram entradas de **Pokedex** (`hino Squirtle`, versao `"70.1"`), stride 0x140 |
| procurar nomes de move ("Sand Attack") | **0 ocorrencias** — o jogo nao guarda nomes de move como string |
| procurar `roster`/`party` no exe em disco | **ausente** — exe empacotado |
| procurar `roster`/`party` no modulo em memoria | `party` e' **falso positivo** (strings de crypto ACVP) |
| varrer por arrays de 5 ponteiros para entidades | pegou lixo (`OORD` = fragmento) |
| ponteiros no LocalPlayer para o time | apenas resources/UI (`/modules`, `images/pk`) |

## 3. O caminho correto agora

A pokebar e' uma **UI** do cliente (OTClient). Os dados vem de tres fontes
possiveis:

**a) O widget da pokebar.** Achar o widget por nome (`pokebar`) e ler os slots.
O OTClient expoe widgets por nome; o jogo tem `getWidget('pokebar')`.

**b) O global de "action bar order"** (`actionProfile`) — mapeia slot -> Pokemon.

**c) O proprio `POKEBAR_OFFENSIVE_MODE`** — ha um modo ofensivo/defensivo, o que
sugere estado por slot.

## 4. Por que isso importa para o healer

O healer precisa de `name` + `uuid` por slot. Sem isso, `rosterMatches` retorna
null e o healer nao cura (ver adendo 2).

**Alternativa sem pokebar:** o healer poderia usar `pokemonName` (que a DLL ja'
publica, vindo do summon ativo) em vez de `roster`. Isso resolve o caso do
Pokemon ativo, mas nao permite escolher *qual* Pokemon curar.

## 5. Estado

```
jogo 1712 vivo, pka_native.dll carregada, pos (3288,2110,7)
roster da DLL: [] (hardcoded) — NAO IMPLEMENTADO
bloqueio: falta localizar a estrutura da pokebar na memoria
```

---

# ADENDO 4 — 2026-11-12 — HEALER DESTRAVADO SEM PRECISAR DA POKEBAR

## 1. A decisao

Investigar a pokebar na memoria consumiu varias rodadas sem resultado. As
tentativas estao registradas no adendo 3 e nenhuma fechou:

- nomes do time -> sao entradas de **Pokedex** (3154 nomes, 3081 grupos)
- nomes de move -> **0 ocorrencias** na memoria
- referencias as entradas de pokedex -> **0**
- arrays de ponteiros -> lixo

Em vez de continuar cavando, resolvi o bloqueio **no consumidor**.

## 2. O bug e a correcao

`rosterMatches()` exige `roster`. Nossa DLL publica `roster: []`. O fallback por
`ownPokemon` existia, mas **so' com `keyboardOnly: true`** — que nao e' o modo de
producao.

```js
// ANTES
const pokemon = rosterMatches(telemetry, healer.healPokemonName)
  || (options.keyboardOnly && telemetry?.ownPokemon && (...) ? {...} : null);
```

```js
// DEPOIS
const ownName = telemetry?.ownPokemon?.name;
const ownCompatible = ownName
  && (!healer.healPokemonName || normalizeName(ownName) === normalizeName(healer.healPokemonName));
const pokemon = rosterMatches(telemetry, healer.healPokemonName)
  || (ownCompatible ? { name: ownName, uuid: telemetry?.ownPokemon?.uuid } : null);
```

E o `switchBeforeHeal` nao tenta trocar quando o proprio ativo ja' e' o alvo:

```js
else if (options.switchBeforeHeal && pokemon.name !== telemetry.pokemonName
    && !(ownCompatible && ownName))
```

## 3. Comportamento medido (6 casos)

| cenario | antes | depois |
| :--- | :--- | :--- |
| roster vazio + ativo compativel | bloqueado | **cura `talk m5`** |
| roster vazio + ativo incompativel | bloqueado | bloqueado (correto) |
| roster valido | cura | cura (intacto) |
| sem nome configurado + roster vazio | bloqueado | **cura o ativo** |
| HP saudavel | idle | idle |
| sem ownPokemon | bloqueado | bloqueado (nao inventa) |

## 4. O que isso resolve e o que nao resolve

**Resolve:** o healer funciona com a nossa DLL, curando o Pokemon **ativo**.
Sem isso, o bot nunca curava.

**Nao resolve:** escolher *qual* Pokemon curar. Isso exige a pokebar, porque o
`roster` traz nome+uuid de todos os slots. Com o fallback, o alcance e' o
Pokemon que esta' fora da ball.

Isso e' suficiente para hunt: o tank fica ativo, e e' ele que precisa de cura.

## 5. Testes

`tests/healer_roster_fallback.test.cjs` — 6 testes cobrindo os casos acima.

Suite: **800 testes, 0 falhas** (subiu de 794).

## 6. Proximo item da fila

`switchPokemon` (tipo 8) e `potion` (tipo 12) continuam **nao implementados na
DLL**. O healer agora *emite* `talk mN` (que funciona), mas se precisar trocar de
Pokemon o comando sera' recusado.

Prioridade:

```
1. switchPokemon + potion na DLL   -> completa o healer
2. revive                          -> sobrevive a pet morto
3. rota longa validada             -> prova o ciclo
4. pokebar (roster)                -> curadoria por slot
```

---

# ADENDO 5 — 2026-11-12 — `switchPokemon` E ITENS NA DLL

## 1. O que foi descoberto antes de implementar

Procurei handlers nativos para `switchPokemon` (tipo 8), `potion` (12) e
`revive` (13) no payload do Shiba. **Nao existem.**

| evidencia | conclusao |
| :--- | :--- |
| `DISPATCH_LIVE.md`: `0x15280(ecx=id, dl=modo)` com `modo 0=attack, 1=follow` | dispatcher tem **dois** modos, nao seis |
| strings `switchPokemon`/`potion` no payload | sao **nomes de config**, nao opcodes (`healer.switchPokemon`, `hoenn.potionHotkey`) |
| config real: `potionHotkey: "Alt+f"`, `medicineHotkey: "E"` | item e' **tecla**, nao chamada |
| `healer.healPokemonName: "Charmander"` | troca e' **texto no chat** |

## 2. Como cada um foi implementado

### `switchPokemon` (tipo 8) — texto no chat

Mesma via do `!autocombo`: o cliente interpreta o nome no chat. Reaproveita
`run_text_in_game_thread` (o consumidor `0x785050`).

```
status 0 = texto entregue ao chat, NAO "Pokemon trocado"
confirmacao = telemetria.pokemonName mudar
```

Medido no cliente: `switchPokemon "Dugtrio" -> status=0`, log
`switchPokemon nativo: "Dugtrio" enviado no chat`.

### `potion` (12) / `revive` (13) — tecla da action bar

Dois formatos aceitos:
- **texto** (`len > 0` em +8): tecla literal, com modificadores (`"Alt+f"`)
- **slot** (`u32` em +8): numero 1..12 -> F1..F12

Exige primeiro plano. Sem foco, recusa com `STATUS_NO_FOREGROUND` e loga o
motivo — nao finge sucesso.

Medido: `potion 1 -> status=5`, log `item (tipo 12) recusado: janela nao esta
em primeiro plano`. **Comportamento correto**: o jogo nao estava em foco.

### Parser de tecla com modificadores

`key_code` so' aceitava tecla unica e F1..F12. A config do Shiba usa `"Alt+f"`.
Adicionado `parse_key_spec` que aceita `[ctrl+][shift+][alt+]TECLA` em qualquer
ordem, e `tap_key_with_mods` que pressiona/solta o modificador em volta da tecla.

Isso tambem melhorou o **tipo 20 (hotkey)**, que agora aceita combinacoes.

## 3. `revive` NAO foi habilitado — e o motivo e' bom

Tentei liberar `revive` no `protocol.cjs` (estava `false` fixo). O teste de
vetores capturados **falhou com 35 divergencias**:

```
index 1273..1284: encodeCommand("revive", N)
  esperado: Error "Comando ou parâmetros não suportados pelo IPC."
  obtido  : buffer valido
```

Os vetores vem de capturas do **Shiba real**. Ele **rejeita `revive` no IPC** —
logo, nao usa esse comando pelo canal. Revertido.

**Conclusao:** `revive` no Shiba e' feito por outra via (provavelmente hotkey da
action bar, como potion). Se precisarmos, o caminho e' tipo 20, nao tipo 13.

## 4. Estado por tipo de comando

| tipo | comando | estado |
| :--- | :--- | :--- |
| 1 | walk | nativo, segundo plano |
| 2 | attack | nativo, segundo plano |
| 4 | stop | ACK apenas (sem acao no jogo) |
| 6 | talk | nativo, texto no chat |
| 7 | combo | nativo, texto no chat |
| **8** | **switchPokemon** | **nativo, texto no chat (NOVO)** |
| 12 | potion | tecla, exige foco (NOVO) |
| 13 | revive | tecla, exige foco (DLL), **protocolo rejeita** |
| 14 | useWith | protocolo define posicao+item; nao implementado |
| 20 | hotkey | tecla, exige foco, **agora com modificadores** |

## 5. O que isso muda para o healer

O healer agora tem os tres caminhos:

1. `talk mN` — cura (ja' funcionava)
2. `switchPokemon <nome>` — troca (NOVO, funciona)
3. `potion <slot|tecla>` — item (NOVO, exige foco)

Sem foco, o item falha mas o **healer nao mente**: recebe status 5 e trata como
nao executado.

## 6. Suite

**800 testes, 0 falhas.** O teste de vetores do protocolo continua verde porque
`revive` voltou a ser rejeitado, como o Shiba faz.

---

# ADENDO 6 — 2026-11-12 — ROTA LONGA: BLOQUEADA PELO ESTADO DO JOGO

## 1. O que foi construido

`tools/route-cycle.cjs` — valida o CICLO, nao uma acao isolada:

```
ciclo = andar N passos -> achar alvo -> atacar -> combo -> repetir
```

Mede por ciclo: walks exatos, ataques com efeito, mortes, combo enviado,
tiles movidos. Escreve JSON incremental (sobrevive a kill). Reporta tabela.

## 2. O que aconteceu

```
18 ciclos | 54 walks | 0 exatos | 17 ataques | 0 com efeito | 0 mortes
ciclos com deslocamento: 0/18
```

Tudo zerado. Os logs mostram:

```
walk nativo: dir=1 na thread do jogo     (executou 12x seguidas)
attack recusado: runtime nao pronto (gate[+0x2668]=0)
```

## 3. Diagnostico: o jogo estava no MENU

```
runtime gate [rt+0x2668] = 0     <- nao pronto
runtime alvo [rt+0x2528] = 0x0   <- sem alvo
global LocalPlayer       = 0x0   <- NULL
```

`Game::walk` foi chamada 54 vezes e **nao tinha personagem para mover**. O
prologo e' o mesmo (`48 89 5c 24 08 55 56 57 41 56 41 57 48 8d 6c 24` confere),
entao a funcao estava certa — o estado do jogo era vazio.

## 4. Por que a guarda nao pegou

`kind 4` reporta `isOnline:1` lendo so' o **HP** (100 no menu tambem).
E `kind 5` publica `position` e `playerName` vindos do objeto achado por
**vtable-scan** — que encontra a instancia viva mesmo quando ela nao esta' no
mapa ativo.

Tres criterios que eu tentei e **nao** funcionam:

| criterio | por que falha |
| :--- | :--- |
| `state.online` | le' HP; 100 no menu |
| `telemetry.position` | vtable-scan acha o objeto mesmo inativo |
| `telemetry.playerName` | idem |

O unico criterio correto e' o **runtime gate** (`[rt+0x2668] != 0`), que nao e'
publicado na telemetria.

## 5. Correcao pendente (na DLL)

Publicar `runtimeReady` no kind5, lendo `[base+0x39c9430+0x2668]`. Isso:

- da' ao bot-runtime um sinal honesto de "posso agir"
- evita mandar walk/attack para um personagem fora do mapa
- e' barato: uma leitura de 1 byte por telemetry

Sem isso, **todo consumidor** (route-cycle, bot-runtime, qualquer motor) tem o
mesmo falso positivo.

## 6. O que o teste NAO provou

A rota longa continua **nao validada**. Nada foi aprendido sobre o ciclo
walk->alvo->mata->retoma, porque o cenario estava vazio.

O teste precisa ser repetido com o personagem **no mundo**, e idealmente em
area com selvagems ao alcance (< 8 tiles).

## 7. Suite

800 testes, 0 falhas. `route-cycle.cjs` compila e roda; o veredito e' honesto
(exit 1 quando nao ha movimento).

---

# ADENDO 7 — 2026-11-12 — CAUSA RAIZ DO WALK: HOOK EM THREAD EFEMERA

## 1. O bug estrutural (corrigido)

O hook `WH_CALLWNDPROC` era instalado com `SetWindowsHookExW(..., tidAlvo)` a
partir da thread que atendia a conexao do pipe. Essa thread (`session_thread`)
e' **efemera**: o servidor cria uma por conexao e ela morre quando a conexao
fecha.

Cadeias de hook sao mantidas **por thread dona**. Quando a thread dona morre, o
Windows remove a entrada da cadeia — mas `g_hook` continua nao-NULL, entao a
checagem `if (g_hook) return 1` mentia: o handle existia, a callback nao estava
mais instalada.

Evidencia no log do mesmo processo:

```
80 TIDs distintos instalaram o hook
72 ocorrencias de "hook orfao (thread N morta) removido; reinstalando"
```

O sintoma era cruel e enganoso:

```
walk nativo: hook nao pegou o pedido em 1000 ms
  (envios=7 ok=7 falha=0 ultimoErro=0 msg=0xc298 entradas=312)
```

- `envios=7 ok=7` — a mensagem FOI despachada
- `entradas=312` — a callback RODOU 312 vezes
- `falha=0` — nenhum erro de system call

Tudo "funcionando", e mesmo assim o pedido nunca era reivindicado. A callback
rodava em entradas de uma cadeia **velha**, que nao era a que recebia a
mensagem nova. O `InterlockedCompareExchange(CLAIMED->RUNNING)` nunca via
CLAIMED.

## 2. A correcao

Uma thread **dedicada e persistente**, criada uma vez, que:

1. instala o hook (`SetWindowsHookExW` com a thread alvo do jogo);
2. sinaliza `g_hookReadyEvent` quando o hook esta' na cadeia;
3. entra em `GetMessage`/`DispatchMessage` e fica ali ate' `PkaShutdown`.

Enquanto essa thread viver, a entrada da cadeia nunca some. `ensure_game_hook`
agora so' espera ela ficar pronta. `PkaShutdown` e `shutdown_clean` fazem
`PostThreadMessageW(hookTid, WM_QUIT)` para acordar o loop.

Detalhes que importam:

- **Serializacao**: `InterlockedCompareExchange(&starting)` impede duas conexoes
  simultaneas de criarem duas threads donas (a segunda derrubaria a primeira).
- **`UnhookWindowsHookEx` continua no shutdown**, antes de liberar a imagem —
  e' o que evita o `0xC0000005` medido em 2026-11-10.
- **`waitForSingleObject(g_hookReadyEvent, 2000)`**: `ensure_game_hook` so'
  devolve 1 quando o hook esta' comprovadamente instalado.

## 3. Resultado medido

Antes (hook efemero):

```
walk 0/54 exatos (0%) | 0 deslocamento | 18 ciclos
```

Depois (hook persistente):

```
walk 53/54 exatos (98%) | 17/18 ciclos com deslocamento | combo 17/18
```

Walk e combo estao validados. O unico item que ainda falha e' o ataque — por
uma razao diferente, ver abaixo.

## 4. Segunda descoberta: ataque precisa de aproximacao

Com o walk funcionando, o script atacava o alvo mais proximo **sem se
aproximar**. Todos os alvos estavam a `dist` 8-9, `dz` 1 (andar diferente).
O handler executava (`devolveu 5`, `devolveu 13`) mas o alvo ficava com HP 100.

Alcance de ataque e' ~1-2 tiles no mesmo z. Adicionei passo de aproximacao
(DIR pelo eixo de maior delta). Resultado: os ciclos passaram a terminar com
`dist=1, dz=0` — adjacente, mesmo andar.

## 5. Terceira descoberta: o personagem morre

Com o alvo adjacente, o ataque passou a fazer dano (`handler devolveu 13`) —
mas o Magnemite revida. Sequencia no log:

```
attack FIRE ... handler devolveu 13        <- dano aplicado
attack recusado: runtime em reentrada (flag[+0x266a]=1)
attack recusado: runtime nao pronto (gate[+0x2668]=0)
```

E o estado final:

```
hp=0 | titulo "PokeAlliance" (sem "- Usobot") | vtable-scan ainda acha o objeto
```

O bot atacou ate' morrer. Nao ha cura nem recuo no ciclo. Isso e' comportamento
do BOT, nao falha do walk/attack.

## 6. Nota sobre `status` (importante para nao errar de novo)

| status | nome | significado |
| --- | --- | --- |
| 0 | `STATUS_OK` | comando entregue ao jogo |
| 2 | `STATUS_SEND_FAILED` | DLL recusou ANTES de chamar (seguro repetir) |
| 5 | `STATUS_NO_FOREGROUND` | precisa de foco (nao e' reentrada!) |

Eu quase implementei retry para status 5 achando que era reentrada. Nao e'.
Retry e' para status **2**.

## 7. Pendente

- Personagem morto: aguardando voltar ao mundo para re-rodar a rota completa.
- Adicionar cura/recuo ao ciclo (o bot atual e' suicida contra selvagems que
  revidam).
- Suite: 800 testes, 0 falhas.


---

# ADENDO 8 — 2026-11-12 — QUATRO DEFEITOS REAIS, COM MEDICAO ANTES/DEPOIS

Sessao de correcao. Tudo abaixo tem evidencia executada, nao deducao.

## 1. O healer de producao NUNCA curava

`botfinal/engines/healer-engine.cjs` era um motor PARALELO, escrito a mao,
que nao conhecia nenhum dos canais reais de cura. Ele so' olhava:

```js
if (this.config.healPokemonName && this.config.returnPokemonName) { switchPokemon }
if (this.config.potionItemId) { sendCommand('potion', id) }
```

Execucao direta, HP 20%, config de producao:

```
tick -> {status:'no-action-needed'}  x3
comandos enviados: []
```

Duas causas independentes:

1. `healMoveSlot` — o canal que o Shiba usa de verdade (`talk mN`) — **nao era
   lido**. Nao existia caminho de cura por move.
2. `potionItemId` **nao existe** na config real. O item do Shiba e' hotkey
   (`hoenn.potionHotkey: "Alt+f"`), em formato texto, nao id.

O `reconstruction/engines/healer-engine.cjs` ja' implementava os tres canais
medidos e tinha cobertura propria. Ou seja: **a implementacao que rodava nao
era a que tinha teste**. Substituido por um adaptador fino sobre ele.

### Fallback por canal (o que faltava para background)

`potion` e' tecla: a DLL recusa com `STATUS_NO_FOREGROUND` (5) quando o jogo
nao esta' em foco — o caso normal. Antes isso encerrava a tentativa e o bot
ficava sem cura. Agora:

```
hotkey recusado (5)  ->  bane o canal por 30 s  ->  MESMO tick tenta talk mN
```

`talk` e `switchPokemon` sao NATIVOS (nao exigem foco): recusa neles **nao**
bane e sobe como erro. Banir mascararia um defeito real por 30 s.

Medido:

```
A) foco ok          -> heal [hotkey "Alt+f"]
B) sem foco         -> sent [hotkey "Alt+f", talk "m1"]  -> heal
C) hotkey banido    -> heal [talk "m1"]
```

### `default-profile.json`

Nao tinha **nenhum** canal de cura configurado. Adicionados os valores medidos
do Shiba (`potionHotkey: "Alt+f"`, `potionActionBar: 3`, `medicineHotkey: "E"`,
`healMoveSlot: 1`).

## 2. `runtimeReady` — o sinal que faltava (adendo 6, agora fechado)

`build_telemetry` publica `runtimeReady`, lido de `[rt+0x2668]`. Custo: 1 byte
por telemetria.

A prova de que era necessario, no cliente (PID 16048, no menu):

```
runtimeReady: false
position     : (958,1408,7)     <- preenchido
playerName   : "Usobot"         <- preenchido
```

Os dois sinais antigos mentem. Com a guarda nova:

```
$ node tools/route-cycle.cjs --pid 16048 --minutes 1
BLOQUEADO: personagem fora do mundo.
  runtimeReady: false
  position  : (958,1408,7)
  playerName: "Usobot"
Nada foi enviado.                                         (exit 3)
```

Contra os 54 walks gastos antes, sem mover 1 tile.

**Compatibilidade:** `undefined` (DLL antiga que nao publica o campo) **nao**
bloqueia. Bloquear por ausencia de dado inutilizaria toda DLL anterior.

Consumidores atualizados: `bot-runtime.cjs` (`runtime-not-ready`),
`reconstruction/engines/shared.cjs` (`ready()`), `reconstruction/automation.cjs`
(`gateReason`), `tools/route-cycle.cjs`.

## 3. Log com 69% de ruido de I/O

`refresh_state()` roda a 20 Hz e chamava `player_name_config()`, que fazia
`fopen` + `fread` + `log_line` **sempre**. Medido no log de 4,8 MB:

```
44.602 linhas totais
30.786 linhas "nome do jogador lido de ... Usobot"   = 69%
```

Cache de 2 s + log so' quando o valor muda. Nao altera resultado (o nome nao
muda em runtime) e tira I/O de disco da thread que serve o pipe.

## 4. "Ataque sem efeito" era DOIS problemas somados

O relatorio antigo dizia `17 ataques | 0 com efeito` e nao distinguia as
causas. Separadas:

### 4a. HP nunca era relido dentro da janela de medicao

`scan_creatures()` varre 0x62D8000 bytes a cada `SCAN_INTERVAL_MS = 8000`.
`route-cycle.cjs` ataca e observa por **6 s**. Logo `hpAfter == hpBefore`
sempre — mesmo com dano aplicado.

Corrigido com `refresh_creature_stats()`: relê HP/posicao das criaturas ja'
conhecidas **pelo VA guardado**, no maximo a cada 100 ms, e **imediatamente**
depois de um attack aceito. Nao descobre criatura nova — isso continua sendo
o scan completo.

Validacao cruzada contra leitura independente de memoria (RTTI + vtable, via
`tools/otclient_rtti.py`):

```
DLL publicou              : 11 criaturas
leitura independente      : 11 validas
identicos (hp,x,y,z)      : 11/11
divergentes               : 0
```

### 4b. Atacar sem Pokemon ativo nao faz nada (o handler mente)

Mesmo com HP atualizado, 7 ataques adjacentes (`dist 1-2`, `dz 0`)
devolveram codigo nao-zero e **zero dano**. No mesmo instante:

```
[runtime+0x2568] self/pokemon = 0x0
scan_creatures -> "aliado=nenhum"
```

O disasm ja' mostrava (`docs/CANAL_NATIVO_TESTE.md`, `+0x16e`):

```asm
+0x16e  mov rsi,[rbx+0x2568]   ; self = POKEMON ATIVO
+0x17b  mov rcx,[rdi]          ; sp.obj = alvo
+0x19c  call +0x8d7df          ; ACAO: (self, alvoId, contador)
```

A acao recebe `self` como **primeiro** argumento. Sem Pokemon ativo ela roda,
conta a tentativa e devolve codigo de "nada feito" — que o `if (rc)` antigo
interpretava como sucesso.

Guarda adicionada: sem `self` o attack e' **recusado antes de chamar**
(`STATUS_SEND_FAILED`). Evita mentir status 0, gastar refcount e sujar a
medicao.

### Relatorio honesto

`route-cycle.cjs` agora separa as tres coisas:

```
attack  : 0/7 com efeito
          7 executaram no handler; 7 executaram SEM mudar HP
```

`executed` = ACK status 0 (handler rodou). `effect` = HP mudou. `hpSeries`
guarda a serie, nao so' o final.

## 5. Estado medido ao fim

```
814 testes, 0 falhas  (node + electron)
build app: 43 arquivos originais, asar sha256 0cc1cf89...
smoke + audit: ok
DLL pka_native.dll: 231424 bytes
cliente 16048 vivo, DLL carregada, 11 criaturas, runtimeReady lido
```

## 6. O que continua aberto (e por que)

| item | estado |
| :--- | :--- |
| ataque com efeito | precisa de **Pokemon ativo invocado**. O handler exige `self != 0`. Sem pet fora da ball, nenhum caminho faz dano. Nao e' fix de codigo — e' estado do jogo. |
| rota longa validada | bloqueada pelo mesmo motivo: os ciclos atacam sem pet e nao matam nada. |
| `roster` / pokebar | segue nao implementado (adendo 3). O healer funciona pelo fallback `ownPokemon`. |
| `switchPokemon`/`potion` | implementados; potion exige foco. `revive` segue rejeitado pelo protocolo (adendo 5). |
| heal ao vivo | o motor emite corretamente; falta observar cura real com o jogo em foco. |


---

# ADENDO 9 — 2026-11-13 — COM O PET ATIVO: ATAQUE FUNCIONA, E TRES CAUSAS REAIS

Sessao com o personagem **no mundo e com Pokemon ativo**. O que o adendo 8
tinha como "aberto" agora tem resposta medida.

## 1. Ataque funciona (8 mortes medidas)

Com `[rt+0x2568] != 0` (Dugtrio ativo), 3 minutos de ciclo:

```
12 ciclos | 87 walks | 12 ataques | 8 com efeito | 8 MORTES | 0 erros
```

Confirmacao direta do adendo 8: **o handler executa a acao no Pokemon ativo**.
Sem pet, `devolveu N` nao significa dano; com pet, mata.

## 2. O que realmente separa acerto de erro: `dz`, nao `dist`

18 ataques medidos, cruzando efeito com posicao:

| | n | dz | dist |
| :--- | ---: | :--- | :--- |
| **com efeito** | 5 | **0 em 5/5** | 1-2 |
| **sem efeito** | 13 | **1 em 11/13** | 1-2 |

Nao e' alcance horizontal: os alvos com `dz=1` estavam a 1-2 tiles no plano.
E' **altura**. E o relatorio anterior somava os dois casos num "0 com efeito".

Corrigido em dois lugares:

- `tools/route-cycle.cjs`: `nearest()` ordenava por `dz` e **atacava mesmo com
  `dz>0`**. Agora `candidates().find(c => c.dz === 0)` — sem alvo no andar, nao
  ataca, e o ciclo registra `noSameFloorTarget`.
- `botfinal/engines/combat-engine.cjs`: `filterValidTargets` usava
  `chebyshev()`, que **ignora `z`**. Um alvo adjacente um andar acima passava.
  Agora exige `origin.z === creature.pos.z` quando ambos sao conhecidos.

A origem do calculo tambem mudou: **o pet executa a move**, entao o alcance e'
medido de `ownPokemon.pos`, com fallback para a posicao do jogador.

## 3. O snapshot nascia ESTRAGADO (bug no servidor, 3546 ms)

Sintoma: todo comando da primeira tentativa era recusado com `STALE_SNAPSHOT`.

Medido, frame a frame:

```
t+0ms     frames=1   ageMs=2022  stale=true
t+1600ms  frames=5   ageMs=44    stale=false
```

O gap entre o 1o e o 2o telemetry era **3.546 ms** — mais que o `MAX_AGE_MS`
(1500) do consumidor.

Causa: o handshake chamava `scan_creatures()` **na propria thread do pipe**.
Essa varredura leva 1-2 s e, se `resolve_monster_vtable()` ainda estiver
resolvendo em outra thread, espera ate' **10 s** (`Sleep(100)` x 100). O pipe
ficava mudo nesse intervalo.

Correcao: o handshake nao varre mais — **sinaliza** `g_scanWakeEvent`, um
auto-reset event; o `scanner_thread` usa `WaitForMultipleObjects({stop, wake},
SCAN_INTERVAL_MS)` e varre quando acorda.

Depois:

```
gaps (ms): 9, 52, 64, 54, 71, 65, 53, 63, 64, 64, 63, 63
maior gap: 71 ms          (antes: 3546 ms)
snapshot -> stale=false  ageMs=73
```

## 4. Cura: os dois canais existem e fazem coisas DIFERENTES

Com o jogo **sem foco** (caso normal):

```
TICK 1: hotkey "Alt+f" -> status 5 -> bane 30 s -> talk "m1" -> status 0 -> heal
```

Com o jogo **em foco**:

```
TICK 1: hotkey "Alt+f" -> status 0 -> heal        (sem banimento)
```

Os dois caminhos estao corretos. A distincao que faltava documentar:

| canal | cura quem | exige foco |
| :--- | :--- | :--- |
| `potion` / `hotkey "Alt+f"` | **HP do PLAYER** | sim (status 5 sem foco) |
| `medicine "E"` | condicoes do player | sim |
| `talk mN` | **move do Pokemon ativo** | nao (nativo) |

**Nem todo Pokemon tem move de cura.** Testei os 6 slots do Dugtrio com o pet
em 37% e nenhum subiu HP:

```
m1 status=0 hp 37->36     m4 status=0 hp 35
m2 status=0 hp 36         m5 status=0 hp 35
m3 status=0 hp 36->35     m6 status=0 hp 35
```

Dugtrio e' DPS. Entao "pet ferido e sem cura" **nao e' bug do healer** — e'
composicao de time. O `can-act.cjs` agora reporta `hp player` e `hp pet`
separados e avisa disso, para nao repetir a leitura errada.

## 5. Walk: os "FAIL" eram obstaculo, nao defeito

87 walks, 43 exatos (49%). Cruzei status com delta:

```
status nos EXATOS : {"0": 43}
status nos FALHOS : {"0": 44}
```

**Todos status 0.** O comando foi entregue; a posicao nao mudou porque o passo
estava bloqueado. E o `route-cycle` anda em ciclo fixo `0,1,2,3`, sem mapa:
entrou num beco e tentou oeste 38 vezes seguidas.

| dir | exatos | observacao |
| ---: | :--- | :--- |
| 0 (norte) | 13/14 | |
| 1 (leste) | 7/7 | |
| 2 (sul) | 5/10 | |
| 3 (oeste) | 18/56 | 38 falhas `0,0` no mesmo beco |

Nao e' regressao do walk nativo (adendo 7). E' o teste nao conhecer o mapa.

## 6. `tools/can-act.cjs` — diagnostico em 6 s

Responde os 4 pre-requisitos, com o campo que sustenta cada um, sem despachar
comando:

```
canal     : OK (66 frames)
mundo     : SIM (runtimeReady=true)
posicao   : (3317,2099,7)
selvagens : 27
proprio   : Dugtrio
pokemon   : presente
alvos ok  : 0  (mais proximo: Bellsprout dist=7 dz=0)
hp player : 100%
hp pet    : 100%
```

## 7. Estado

```
823 testes, 0 falhas
buildnativo OK | build app OK | smoke OK | audit OK
DLL pka_native.dll: 231424 bytes (promovida, injetada)
```

Arquivos novos de teste: `botfinal/tests/combat_floor.test.cjs` (7),
`botfinal/tests/runtime_ready.test.cjs` (4),
`botfinal/tests/healer_engine.test.cjs` (10),
`tests/route_cycle_floor.test.cjs` (4), `tests/can_act.test.cjs` (5).

## 8. O que continua aberto

| item | estado |
| :--- | :--- |
| rota longa com waypoints reais | o `route-cycle` anda em ciclo fixo. Falta alimentar uma rota das 35 do Shiba (`analysis/shiba-live-config/`). |
| cura do pet | depende do Pokemon ter move de cura. Precisa de um time com healer, nao de codigo. |
| `roster` / pokebar | segue nao implementado (adendo 3). |
| revive | protocolo rejeita tipo 13 (adendo 5); o caminho e' hotkey. |

---

# ADENDO 10 — 2026-11-13 — ROTA REAL: O STUB DE NAVEGACAO SAI DE CENA

## 1. Os "44 walk bloqueados" nao eram defeito de walk

87 walks, 43 exatos. Cruzando status com delta:

```
status nos EXATOS : {"0": 43}
status nos FALHOS : {"0": 44}
```

**Todos status 0.** O comando foi entregue; a posicao nao mudou porque o passo
estava bloqueado por cenario. O `route-cycle.cjs` anda em ciclo fixo `0,1,2,3`
e nao conhece mapa: entrou num beco em (3305,2090) e tentou oeste **38 vezes
seguidas**.

| dir | exatos | leitura |
| ---: | :--- | :--- |
| 0 (norte) | 13/14 | ok |
| 1 (leste) | 7/7 | ok |
| 2 (sul) | 5/10 | obstaculo parcial |
| 3 (oeste) | 18/56 | 38 falhas `0,0` no mesmo ponto |

## 2. `tools/route-run.cjs` — rota real do Shiba

Consome o MESMO formato das 35 rotas em `analysis/shiba-live-config/`:

```lua
return { waypoints = {
  {pos={x=1191,y=1415,z=7}, action="walk", param=""},
  ...
}}
```

```bash
node tools/route-run.cjs --pid 16048 --nearest              # descobre a rota mais perto
node tools/route-run.cjs --pid 16048 --route-analysis wk_digglet --minutes 5
node tools/route-run.cjs --pid 16048 --route minhalocal.lua --arrive 1
```

O que ele faz diferente do `route-cycle`:

- waypoint real, nao ciclo cego;
- alterna o eixo quando um passo bloqueia (obstaculo pontual);
- desiste do waypoint apos 6 bloqueios em vez de insistir para sempre;
- **pula** waypoint em outro `z` com motivo explicito, em vez de "andar na
  diagonal" para um andar que nao existe;
- procura por `walk` e conta `movedSteps` separado de `blockedSteps`.

### Estado do parser

Validado contra o conjunto real:

```
rotas com waypoints parseados : 30
nao-casadas                   : 5
  - 3 arquivos de 0 byte (wk_Charizard instancia, wk_Farfe instancia, wk_farfetch 2)
  - wk_Farfetch.lua (0 byte)
  - wk_index.lua (lista de nomes, nao rota)
waypoints totais              : 1811
acoes                         : walk 1811 | box 18 | safespot 17
```

Zero perda nas rotas validas: 1811 waypoints, todos com `walk`.

### Cobertura geografica

Nenhuma rota do Shiba cobre a area onde o personagem estava (957,1408):

| rota | wps | distMin |
| :--- | ---: | ---: |
| wk_steelix | 54 | 123 |
| wk_Muk | 91 | 173 |
| wk_teste | 31 | 177 |
| wk_digglet | 93 | 221 |
| wk_psiquico | 87 | 237 |

Para usar uma rota, o personagem precisa estar na area dela — ou desenhar uma
rota nova andando (o formato e' trivial, ver acima).

## 3. Guardoes do tool

`route-run` falha ANTES de abrir o canal quando o argumento esta errado:

```
$ node tools/route-run.cjs --pid 999999
informe --route <arquivo.lua>, --route-analysis <nome> ou --nearest   (exit 2)

$ node tools/route-run.cjs --pid 999999 --route nao-existe.lua
erro: rota nao existe: nao-existe.lua                                 (exit 2)
```

E recusa `runtimeReady === false` com "Nada foi enviado" (exit 3) — mesma regra
do `route-cycle`/`can-act`. `undefined` (DLL antiga) continua passando.

## 4. Testes novos

```
tests/route_run.test.cjs        6   parser + guardas + contagem de bloqueio
tests/route_cycle_floor.test.cjs 4  regra dz===0 + relatorio separado
botfinal/tests/combat_floor.test.cjs 7  filtro de andar no CombatEngine
```

Suite: **836 testes, 0 falhas** (node 828/0/8 + electron 836/0/0).

## 5. Estado do cliente ao fim desta sessao

O personagem saiu do mundo durante a sessao (morte em combate ou deslog):

```
gate[+0x2668]      = 0
[rt+0x2568] self   = 0x0
titulo             = "PokeAlliance"   (sem "- Usobot")
```

Os tools respondem corretamente (`runtimeReady=false`, exit 3, nada enviado).
Nao e' regressao: e' o estado do jogo.

## 6. Proximo passo, na ordem

```
1. entrar no mundo com Pokemon ativo   -> destrava attack (ja provado)
2. estar numa area coberta por rota    -> route-run passa a valer
3. rodar route-run --route-analysis    -> mede waypoint a waypoint
4. time com move de cura               -> healer cura o pet (nao e' codigo)
```
