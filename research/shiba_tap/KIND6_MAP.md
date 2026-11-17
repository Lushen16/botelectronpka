# Kind 6 (automation) — mapa completo

Fonte: `captures/shiba-session-full-401mb.jsonl` (401,8 MB, sessão real com o
Shiba Bots v3.3.1 rodando no `PokeAlliance_dx.exe` PID 20112).

| métrica | valor |
| :--- | :--- |
| amostras kind 6 válidas | **28.830** |
| duração da sessão | 4.805,4 s (80 min) |
| taxa de publicação | **6,0 amostras/s** |
| campos no schema | 246 (52 escalares + arrays de tamanho variável) |
| campos escalares que variam | 28 de 52 |
| transições de `phase` | 5.653 |
| transições de `luring.phase` | 2.809 |
| módulos ativos no máximo | `["target","walker"]` |

Capturado no **cliente** (menu). O `--report` corrige a direção: o tap no menu
grava `ReadFile` como `c2s`, que na verdade é `s2c`.

## Direção real do canal

```
PokeAlliance_dx.exe  (servidor, DLL em msftedit.dll stomped)
  -> kind 1 challenge
  -> kind 3 welcome
  -> kind 4 state      48 B, ~6/s
  -> kind 5 telemetry  ~46 KB, 1/s
  -> kind 6 automation  ~748 B, 6/s     <-- este documento
  -> kind 7 ready      "ready"

menu Electron        (cliente)
  -> kind 2 authenticate
  -> kind 9 manual     ZERO na captura inteira
```

**`kind 9` = 0 em 72.429 linhas.** O menu nunca manda comando de combate. A
lógica roda dentro da DLL no jogo — coerente com o dispatcher nativo em
`0x12c40` encontrado no desmonte estático.

## Schema escalar (52 campos)

`=` constante na sessão · `~` varia

| campo | tipo | | valores observados |
| :--- | :--- | :--- | :--- |
| `ack` | number | ~ | 0..14 (contador de ack) |
| `authorized` | boolean | = | `true` |
| `boot` | string | = | `"b4ac9f76607132cc9cd49284fa77ae35"` (id da injeção) |
| `busy` | boolean | = | `false` |
| `client` | string | ~ | `""` ou hash de 32 hex (menu conectado) |
| `core.movementOwner` | null/string | ~ | `null`, `"target"` |
| `core.phase` | string | ~ | `"idle"`, `"combat"` |
| `error` | string | = | `""` |
| `events.length` | number | ~ | 0..23 |
| `foreground` | boolean | ~ | `true`/`false` (jogo em foco) |
| `foregroundPid` | number | ~ | pid em primeiro plano |
| `gmLearning.active` | boolean | = | `false` |
| `gmLearning.learned` | number | = | 0 |
| `gmLearning.profile` | string | = | `"default"` |
| `gmLearning.remainingSeconds` | number | = | 0 |
| `gmLearning.ruleIndex` | number | = | 0 |
| `guildDaily.choice` | string | ~ | `"primal:electric"` |
| `guildDaily.error` | boolean | ~ | true/false |
| `guildDaily.next` | number | ~ | tick da próxima consulta |
| `guildDaily.owner` | string | ~ | `"usobot"` |
| `guildDaily.queryAt` | number | ~ | 0 |
| `guildDaily.stage` | string | ~ | `"idle"` |
| `guildDaily.status` | string | ~ | `"Personagem sem guild."` |
| `hoennCounts` | null | = | `null` (modo Hoenn não usado) |
| `instanceEntry.info` | string | = | `"Parado"` |
| `instanceEntry.phase` | string | = | `""` |
| `instanceEntry.running` | boolean | = | `false` |
| `luring.actorId` | null/number | ~ | id do tank (ex. `1079413359`) |
| `luring.count` | number | ~ | 0..12 |
| `luring.holding` | boolean | ~ | true/false |
| `luring.minCount` | number | ~ | `0`, `8` |
| `luring.mode` | string | ~ | `"off"`, `"dynamic"` |
| `luring.phase` | string | ~ | 6 estados, ver enum abaixo |
| `luring.target` | object/null | ~ | `{x,y,z}` alvo da lure |
| `modules.length` | number | ~ | 0..2 |
| `monitor.enabled` | boolean | = | `false` |
| `monitor.pid` | number | = | 20112 |
| `pauseKeyDown` | number | = | 0 |
| `paused` | boolean | = | `false` |
| `pausedModules.length` | number | = | 0 |
| `phase` | string | ~ | texto da UI (3.817 transições) |
| `phases.target` | string | ~ | fase interna do Target |
| `phases.walker` | string | ~ | fase interna do Walker |
| `pid` | number | = | 20112 |
| `protocol` | number | = | **1** |
| `tick` | number | ~ | relógio do jogo (GetTickCount-like) |
| `walkerIndex` | number | ~ | 0..22 (waypoint atual de 23) |
| `walkerTimer.phase` | string | = | `"idle"` |
| `walkerTimer.remainingMs` | number | = | 0 |

## Enums completos

```
luring.mode     : "off" | "dynamic"

luring.phase    : "off" | "travel" | "arc" | "stationary" | "wait" | "observe"

core.phase      : "idle" | "combat"

core.movementOwner : null | "target"

modules         : [] | ["walker"] | ["target"] | ["target","walker"]

guildDaily.stage: "idle"
```

### `luring.phase` — a máquina de estados da lure

Seis estados. Ordem de primeira aparição na sessão de 80 min:

```
off (0) → travel (1) → arc (4) → stationary (27) → wait (196) → observe (2596)
```

Sequência real das primeiras 30 transições:

```
off → travel → off → travel → arc → travel → off → travel → off
    → travel → off → travel → off → travel → off → travel → arc
    → travel → off → arc → travel → arc → travel → arc → travel
    → off → travel → stationary → travel → arc
```

Contexto de `observe` (transição 2596), que só apareceu na sessão longa:

```
travel → stationary → travel → arc → [observe] → wait → travel → arc → travel
```

Leitura:

| fase | significado |
| :--- | :--- |
| `off` | luring desligado |
| `travel` | indo até o ponto de lure |
| `arc` | desenhando o arco (aproximação em curva) |
| `stationary` | parado, aguardando |
| `wait` | esperando condição (gate) |
| `observe` | observando depois de fechar o arco, antes de decidir |

`luring.count` chegou a 12; `luring.minCount = 8` quando o modo é `dynamic`.

## `events[]` — vocabulário de diagnóstico

Array de `{id, kind, message}`. Os `id` são sequenciais (1,2,3…) e reaparecem
em amostras consecutivas, então é um ring buffer.

`kind`: `"info"`, `"warning"`, `"error"`

Apenas **5 mensagens distintas** na sessão inteira — é um conjunto fechado de
condições, não texto livre:

```
"AutoCombo concluído: ultima skill (m5)."
"AutoCombo concluído: sem monstro visível (m5)."
"target: Pokémon ausente durante o combo; aguardando recuperação."
"PokeStop sem confirmação após quatro tentativas; seguindo o fluxo de segurança do Lua."
"Best Tile: limite de ajuste atingido; seguindo o fluxo de segurança do Lua."
```

Cada uma amarra com uma regra que já tínhamos do desmonte estático:
AutoCombo, PokeStop (4 tentativas), Best Tile (limite de ajuste).

## `phase` — texto da UI, não estado interno

`phase` é o que aparece no menu, incluindo contador de waypoint:

```
"Pausado"
"walker: iniciando"
"Walker · WP 1/23 · walk"   ...   "Walker · WP 22/23 · walk"
"target: iniciando"
"Target: procurando alvos"
"Target: aguardando Pokémon, preservando combo"
"Target: aguardando skills prontas"
"Best Tile: treinador abrindo caminho"
"Perfect lure: 5/10 monstros na área do combo"
"Dynamic: recuperando distância pelo corredor"
"Hoenn: HP do tank em risco; soltando o combo agora."
```

**Não usar `phase` para lógica** — é string de apresentação com números
embutidos. Para lógica use `core.phase` (idle/combat), `luring.mode`,
`luring.phase` e `modules`.

## O que isso habilita no nosso bot

| nosso campo | fonte real | observação |
| :--- | :--- | :--- |
| estado de combate | `core.phase` | 2 valores, discreto |
| dono do movimento | `core.movementOwner` | evita briga target×walker |
| estado da lure | `luring.mode` + `luring.phase` | 5 fases, máquina explícita |
| contagem de monstros | `luring.count` vs `luring.minCount` | gate do Perfect Lure |
| alvo da lure | `luring.target.{x,y,z}` | coordenada real |
| waypoint | `walkerIndex` | índice, não texto |
| saúde do runtime | `ack`, `busy`, `error`, `authorized` | detecção de falha |
| diagnóstico | `events[]` | 5 condições fechadas |

O `pid`, `protocol` e `boot` são constantes por sessão — servem de gate de
compatibilidade: se `protocol != 1`, o layout mudou.

## Como reproduzir

```cmd
node tools\kind6_map.cjs captures\shiba-session-2026-11-04.jsonl
```

Saídas em `captures/`:

```
kind6-schema.json       246 campos com tipo, cobertura, variação e valores
kind6-transitions.json  sequências de phase/core/luring/modules
```

## Limites

- Uma sessão, um personagem (`usobot`), uma build (v3.3.1). Enum pode ter
  valores não vistos (ex.: `wait` apareceu 1× em 1.855 transições).
- `hoennCounts` ficou `null` a sessão toda: o perfil não usava Hoenn. O formato
  desse objeto continua desconhecido.
- `instanceEntry` idem — nunca entrou em instância.
- `gmLearning` sempre inativo.
- Não sabemos se `kind 6` é **enviado** pelo servidor ou **consultado** pelo
  cliente. No log ele aparece como `s2c` (servidor→cliente), mas como o tap
  estava no cliente via `ReadFile`, isso só prova que o cliente **recebeu**.


