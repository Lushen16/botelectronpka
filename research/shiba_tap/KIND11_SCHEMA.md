# Kind 11 — `automation_control` (o canal de comando real)

O projeto procurou por semanas um `kind 9` de ataque. **Ele não existe.** O menu
nunca manda comando de combate avulso: ele manda a **configuração inteira**, uma
vez, e a DLL em C++ executa com a árvore dela em memória.

Medido: **`kind 9` = 0** em 105.722 frames do menu e 1.549 do jogo.
**`kind 11` = 2** — ambos `op: "start"`, e é isso que liga o bot.

## Os 4 ops — medidos na captura limpa (PID 8036)

Fonte: `native/pka_tap_8036.jsonl`, 20 pacotes `kind 11`, todos `c2s`.
Extraídos em `captures/kind11-clean/`.

### `start` — 4 pacotes

```json
{"protocol":1,"boot":"f9eb201d…","client":"2792676a…","seq":18,
 "op":"start","module":"target","config":{…10152 B…}}
```

Sempre com `module` **e** `config`. Módulos vistos: `walker`, `target`.

### `stop` — 6 pacotes

```json
{"protocol":1,"boot":"f9eb201d…","client":"2792676a…","seq":3,
 "op":"stop","module":"hoenn"}
```

Sempre com `module`, **nunca** com config. Módulos vistos: `hoenn`, `walker`, `target`.

### `monitor` — 2 pacotes

```json
{"…","seq":7,"op":"monitor","enabled":true,"config":{…10152 B…}}
{"…","seq":8,"op":"monitor","enabled":false}
```

**Sem `module`.** `enabled:true` leva config; `enabled:false` vai seco.

### `togglePause` — 8 pacotes

```json
{"…","seq":1,"op":"togglePause","pauseMonitor":false,"key":0}
```

**Sem `module`, sem config.** `pauseMonitor` é boolean; `key` é 0 no capturado.

## Resumo por op

| op | module | config | campos |
| :--- | :--- | :--- | :--- |
| `start` | obrigatório | sempre | protocol, boot, client, seq, op, module, config |
| `stop` | obrigatório | nunca | protocol, boot, client, seq, op, module |
| `monitor` | — | se `enabled:true` | protocol, boot, client, seq, op, enabled, config |
| `togglePause` | — | nunca | protocol, boot, client, seq, op, pauseMonitor, key |

## Sequência real de uma sessão

```
seq=1  togglePause   pauseMonitor=false
seq=2  togglePause   pauseMonitor=false
seq=3  stop          hoenn
seq=4  stop          walker
seq=5  stop          hoenn
seq=6  stop          walker
seq=7  monitor       enabled=true  + config
seq=8  monitor       enabled=false
seq=9  start         walker + config
seq=10 stop          walker
seq=11 togglePause
...
seq=17 start         walker + config
seq=18 start         target + config
seq=19 stop          target
seq=20 start         target + config
```

`seq` é **monotônico na sessão** e compartilhado por todos os ops.

## Uma correção sobre a alteração de config

O teste com `m5 → m3` **não** chegou ao canal: as 5 configs com payload são
byte a byte idênticas, todas com `sequenceText: "m5"`. Nenhum pacote contém
`m3`. A alteração não foi salva antes do envio, ou o menu guardou em memória
sem despachar.

Isso não invalida a captura: os 4 ops e seus formatos estão medidos. Só falta
provar que o `config` carrega alteração em tempo real.

## Envelope

```json
{
  "protocol": 1,
  "boot":   "916091abf20faa9b8bb86c070527c955",
  "client": "1e81a41b9365176e5d0fdfdef940df63",
  "seq":    1,
  "op":     "start",
  "module": "target",
  "config": { ... }
}
```

| campo | tipo | observação |
| :--- | :--- | :--- |
| `protocol` | number | sempre `1` |
| `boot` | string | id da injeção, **muda por sessão**. Igual ao do `kind 6`/`kind 12` |
| `client` | string | id do menu, **muda por sessão**. Igual ao do `kind 12` |
| `seq` | number | incrementa a cada envio (`1`, `2`, …) |
| `op` | string | **4 medidos**: `start`, `stop`, `monitor`, `togglePause` |
| `module` | string | `"target"`, `"walker"` observados. Ver nota abaixo |
| `config` | object | **sempre as 8 seções**, ~10 KB |

### O `module` não filtra a config

Comparação byte a byte dos dois frames capturados:

```
DIFF seq:    1 vs 2
DIFF module: "target" vs "walker"
```

Nada mais. **O payload é idêntico.** O `module` é o alvo do `op: start` (qual
módulo ligar), não um seletor de seção — a config inteira vai sempre.

## Tamanho e ritmo

```
tamanho do payload : 10.304 bytes
seções             : 8
caminhos no schema : 200
```

## As 8 seções

| seção | campos | bytes |
| :--- | ---: | ---: |
| `scripts` | 1 | 14 |
| `target` | 11 (+47 em subobjetos) | 1.213 |
| `healer` | 5 | 108 |
| `walker` | 15 (+6 em arrays) | 2.408 |
| `looting` | 6 (+4 em arrays) | 197 |
| `alerts` | 5 (+29 em rules[0]) | 4.248 |
| `hoenn` | 37 (+14 em roster[0]) | 1.586 |
| `tools` | 6 (+12 em consumables) | 300 |

---

## `scripts`

```json
{ "entries": [] }
```

Array de `{ name, interval, code }`. Vazio neste perfil.

---

## `target` — 57 caminhos

### Raiz

| campo | tipo | padrão |
| :--- | :--- | :--- |
| `ignoredCreaturesText` | string | `""` |
| `shinyPriorityEnabled` | boolean | `false` |
| `instanceModeEnabled` | boolean | `false` |
| `lowHpComboPercent` | number | `0` |

### `monsters[]` — 1 item neste perfil

```json
{
  "name": "*",
  "spell": "",
  "hp": 100,
  "range": 20,
  "priority": 1,
  "minCount": 8,
  "creatureType": 1,
  "movement": "stand",
  "kiteRange": 2,
  "randomMoves": { "stand": true, "chase": true, "kite": true }
}
```

`name: "*"` = qualquer criatura. `minCount: 8` casa com o `luring.minCount`
observado no `kind 6`.

### `combo` — 22 campos

| campo | tipo | padrão |
| :--- | :--- | :--- |
| `enabled` | boolean | `true` |
| `sequenceText` | string | `"m5"` |
| `stepDelay` | number | `250` |
| `lureDelay` | number | `200` |
| `finishRemainingCount` | number | `0` |
| `finishIgnoreShiny` | boolean | `false` |
| `useNativeSequence` | boolean | `true` |
| `usePokeStop` | boolean | `true` |
| `useMedicine` | boolean | `false` |
| `useMedicineBeforeCombo` | boolean | `false` |
| `medicineHotkey` | string | `"e"` |
| `medicineDelayMs` | number | `50` |
| `perfectingLureEnabled` | boolean | `true` |
| `perfectingLureHpPercent` | number | `30` |
| `medicineActionBar` | number | `0` |
| `perfectingLureRange` | number | `3` |
| `perfectingSkillMaskEnabled` | boolean | `false` |
| `perfectingSkillMask` | array | `[]` |
| `perfectingReboxEnabled` | boolean | `false` |
| `bestTileEnabled` | boolean | `true` |
| `targetCreaturesEnabled` | boolean | `true` |

**`useNativeSequence: true`** é o campo decisivo: pede que a DLL rode a sequência
nativa (`m5`) em vez de o menu mandar cada skill.

### `autoRevive`

```json
{ "enabled": true, "hotkey": "f", "interval": 1500, "waitForPokemon": false }
```

### `luring`

```json
{
  "enabled": false, "maxDistance": 2, "frontEnabled": true,
  "frontRegroupMargin": 4, "frontRegroupSteps": 3,
  "randomEnabled": false, "randomMinSeconds": 45, "randomMaxSeconds": 100
}
```

### `lureSkill` / `healSkill`

```json
{ "enabled": false, "move": "m9", "hpPercent": 90 }
{ "enabled": false, "move": "m1", "hpPercent": 50 }
```

### `combatStanceAuto`

```json
{ "enabled": true }
```

---

## `healer` — 5 campos

```json
{
  "healHpPercent": 0,
  "healPokemonName": "Charmander",
  "healMoveSlot": 1,
  "healResetSlot": 1,
  "returnPokemonName": ""
}
```

---

## `walker` — 21 caminhos

| campo | tipo | padrão |
| :--- | :--- | :--- |
| `smartWalking` | boolean | `false` |
| `startNearestWaypoint` | boolean | `true` |
| `recordStepDistance` | number | `3` |
| `loop` | boolean | `true` |
| `mapPath` | string | `""` |
| `luaProfile` | string | `"wk_magnemite.lua"` |
| `luaRevision` | string | `"3071e10ac5…"` (sha256) |
| `timerEnabled` | boolean | `false` |
| `timerMinutes` | number | `60` |
| `guildDailyTier` | string | `"primal"` |
| `guildDailyElement` | string | `"electric"` |
| `guildDailyAutoEnabled` | boolean | `true` |
| `guildDailyRenewEnabled` | boolean | `true` |
| `guildDailyRenewLimit` | number | `100` |

### `waypoints[]` — 23 itens

Cada um:

```json
{
  "action": "walk",
  "pos": { "x": 964, "y": 1411, "z": 7 },
  "param": "",
  "stairCheckMonsters": false
}
```

`action`: `walk` | `safespot` | `box` | `stairs` | `wait` | `say`.
As 23 posições casam com o `WP x/23` que aparece no `kind 6`.

---

## `looting` — 10 caminhos

```json
{
  "maxCaptureDist": 10,
  "captureEnabled": true,
  "captureAfterCombat": false,
  "captureRandomMode": false,
  "captureDelay": 300,
  "captureEntries": [
    { "name": "", "corpseId": 35659, "ballId": 15650, "fallbackBallId": 0 }
  ]
}
```

---

## `alerts` — 34 caminhos

### Raiz

```json
{
  "pauseWithHotkey": true,
  "rules": [ ... 7 regras ... ],
  "gmMessageActiveProfile": "default",
  "gmMessageProfilesJson": "",
  "gmMessageRevision": 0
}
```

### `rules[]` — 7 itens, 29 campos cada

Primeira regra (a única com dados não-default neste perfil):

```json
{
  "name": "VIDA", "enabled": true, "type": "hp",
  "hpThreshold": 30, "hpOnce": true,
  "chatMode": "private", "creatureName": "*",
  "creatureRange": 7, "playerRange": 5, "huntPokemonNames": "",
  "teleportIntervalMs": 500,
  "soundMode": "voice", "soundKind": "default",
  "soundEnabled": true, "soundRepeatEnabled": false, "soundRepeatSeconds": 10,
  "frontEnabled": false, "logoutEnabled": false,
  "talkEnabled": false, "talkMsg": "", "talkCooldownSec": 10,
  "pauseWk": false, "pauseTarget": false, "pauseLooting": false,
  "gmArrowMode": "stop", "gmArrowMsg": "", "gmArrowMsgDelaySec": 2,
  "gmArrowSpinEnabled": false, "gmArrowSpinSeconds": 4
}
```

`type`: `hp` | `disconnected` | `chat` | `creature` | `player` | `gm_arrow` |
`gm_message` | `hunt_pokemon` | `teleport` | `camera_viewers` | `pokemon_capture`

---

## `hoenn` — 51 caminhos

### Raiz (37 campos)

| campo | tipo | padrão |
| :--- | :--- | :--- |
| `formation` | string | `"2x3"` |
| `minWildsToEngage` | number | `8` |
| `ignoredCreaturesText` | string | `""` |
| `targetShinyEnabled` | boolean | `true` |
| `forceBox` | boolean | `true` |
| `perfectLure` | boolean | `true` |
| `perfectLureTimeoutMs` | number | `10000` |
| `perfectLureMinHp` | number | `30` |
| `bestTile` | boolean | `true` |
| `bestTileRange` | number | `4` |
| `bestTileMaxWaitMs` | number | `2500` |
| `bestTileRetryMs` | number | `700` |
| `deployToPokestopMs` | number | `200` |
| `pokestopToComboMs` | number | `400` |
| `pokeReadyTimeoutMs` | number | `3000` |
| `comboFallbackMs` | number | `3000` |
| `potionHotkey` | string | `"Alt+f"` |
| `potionActionBar` | number | `3` |
| `potionHpPercent` | number | `60` |
| `potionCooldownMs` | number | `1500` |
| `useMedicine` | boolean | `true` |
| `medicineHotkey` | string | `"E"` |
| `positionAround` | boolean | `true` |
| `positionTiles` | number | `2` |
| `medicineActionBar` | number | `0` |
| `useSafeSpot` | boolean | `true` |
| `forceSafeSpotRecovery` | boolean | `true` |
| `safeSpotTimeoutMs` | number | `15000` |
| `shinyRetreatDelayMs` | number | `0` |
| `useReadyGate` | boolean | `true` |
| `gateReadyPct` | number | `80` |
| `gateMinHp` | number | `90` |
| `gateDpsMinHp` | number | `90` |
| `gateMaxWaitMs` | number | `60000` |
| `cycleAtSafeSpot` | boolean | `true` |
| `autoStance` | boolean | `true` |

### `roster[]` — 3 itens

```json
{
  "key": "f09e657e-5ab5-4de4-b265-197b33f49024",
  "uuid": "f09e657e-5ab5-4de4-b265-197b33f49024",
  "name": "Squirtle",
  "role": "tank",
  "dwellMs": 500,
  "usePokestop": true,
  "toPoke": true,
  "readyPct": 50,
  "buffOn": false,
  "buffMove": 1,
  "buffHp": 60,
  "healOn": false,
  "healMove": 1,
  "healHp": 50
}
```

`role`: `tank` | `dps`. Os UUIDs casam com o `roster[]` da telemetria
(`kind 5`), que é como se amarra a identidade do Pokémon.

---

## `tools` — 14 caminhos

```json
{
  "menuHotkey": "Insert",
  "pauseHotkey": "=",
  "consumable1": { "enabled": false, "hotkey": "", "intervalMinutes": 60 },
  "consumable2": { "enabled": false, "hotkey": "", "intervalMinutes": 60 },
  "consumable3": { "enabled": false, "hotkey": "", "intervalMinutes": 60 },
  "consumable4": { "enabled": false, "hotkey": "", "intervalMinutes": 1 }
}
```

---

## Como despachar

O `kind 11` vai no quadro `manual` (kind 9) **não** — ele é o próprio payload do
`kind 11`, enviado como frame `[u32 len][u32 kind=11][json]`.

```json
{"protocol":1,"boot":"<boot da sessao>","client":"<client do menu>",
 "seq":<n>,"op":"start","module":"target","config":{...8 secoes...}}
```

`boot` e `client` vêm do `kind 12` (lease) da sessão corrente. `seq` incrementa.

## O que NÃO está na captura

Não vou inventar o que não medi:

- **`op: "stop"`** — nunca observado. O valor deve existir (o bot foi pausado e
  retomado), mas nenhum frame foi capturado com ele.
- **`op: "update"`** — idem. Quando o usuário muda config com o bot rodando,
  provavelmente sai um update — mas não temos o frame.
- **`module` para `healer`, `looting`, `hoenn`, `alerts`, `scripts`, `tools`** —
  só `target` e `walker` foram vistos como valor de `module`. As seções existem
  na config, mas o valor de `module` para ligá-las é desconhecido.
- **Se o `config` muda entre `start` de módulos diferentes** — aqui foi idêntico,
  mas é um caso só.

Para capturar `stop`/`update`: com o tap ligado, pausar e retomar o bot, e mudar
uma config com ele rodando. Cada ação deve gerar um `kind 11` novo.

## Arquivos

```
captures/kind11/target-start.json    payload cru (10.304 bytes)
captures/kind11/walker-start.json    payload cru do segundo frame
captures/kind11/schema.json          200 caminhos com tipo e valor
captures/kind11/template-start.json  template pronto para uso
tools/kind11_schema.cjs              regenera tudo a partir da captura
tools/kind11_pattern.cjs             analisa padrao do kind 11 numa sessao
```

## Por que isso resolve o problema do projeto

| antes | agora |
| :--- | :--- |
| procurar `kind 9` de ataque | `kind 9` = 0; o comando é `kind 11` |
| chamar `0x15280(id)` por criatura | a DLL resolve tudo; só ligar o módulo |
| manter a árvore de entidades | a DLL mantém a árvore dela |
| brigar com o `movementOwner` | a DLL arbitra (`core.movementOwner` no kind 6) |

Mandando `kind 11` com `op: "start"` e a config, o runtime do fornecedor faz
exatamente o que faz com o menu deles — porque é o mesmo caminho.
