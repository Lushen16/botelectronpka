# Inventário do que temos — base para o bot completo

Levantamento de 2026-11-04, sobre os artefatos **existentes** no repositório.
Nada aqui é estimativa: cada linha aponta o arquivo ou a captura que a sustenta.

---

## 1. Capturas do canal oficial (tap)

| arquivo | tamanho | kind 4 state | kind 5 telemetry | kind 6 automation | kind 11 control | kind 12 lease |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| `native/pka_tap_10244.jsonl` | 401,8 MB | 76.723 | 166 | 28.830 | 0 | 0 |
| `native/pka_tap_12576.jsonl` | 757,1 MB | — | — | — | — | — |
| `native/pka_tap_16860.jsonl` | 760,0 MB | 89.837 | **5.625** | 32.533 | **2** | **8.872** |
| `native/pka_tap_12240.jsonl` | 12,1 MB | — | — | — | — | — |

Total: ~1,93 GB de tráfego real do cliente oficial.

### O que o kind 5 (telemetria) provou

Em `pka_tap_16860.jsonl`: **6.007 telemetrias, 4.749 com criaturas e 4.749 com
itens, zero falhas** no nosso `decodeTelemetry` após a correção de
`itemCounts: null`. Frame maior: 45.133 bytes.

Campos de topo observados (49 chaves):
`schema, tick, nativeVerified, guildDailyAvailable, automationVersion,
pulseVersion, shinyVersion, combatDispatchVersion, dynamicLureVersion,
performance, captureVersion, itemInspectorAvailable, inspection, itemCounts,
ownSummonId, clockMs, playerId, safeLogoutVersion, playerStates, clientPid,
playerName, guildDailyAutoVersion, guildName, guildDailyRenewVersion,
guildRenewals, guildDailies, instanceEntryVersion, instanceEntry, direction,
fightMode, chaseMode, position, activeSlot, nativeSequence, pokemonName,
comboPokemonName, conditionEvents, conditionsKnown, conditions, alertSignals,
alertEventRevision, alertEventsDropped, alertEvents, pinnedTexts, roster,
moves, creatures, items, tiles`

Criatura real (observada):
```json
{"id":268447124,"name":"Usobot","type":0,"healthPercent":85,"direction":1,
 "shinyIcon":0,"lookType":932,"normalLookType":0,"shinyLookType":0,
 "canAttack":true,"pos":{"x":958,"y":1405,"z":6}}
```

Item real (observado):
```json
{"id":5008,"stack":0,"instance":1,"container":false,"pos":{"x":949,"y":1397,"z":6}}
```

Roster real por slot, com UUID, nome, `identityAvailable`, HP e lista de moves
com `spellword`/`remainingMs`/`totalMs`. Diglett traz nomes de skill ("Dig",
"Earth Power", "Mud Shot", "Mud Slap", "Sand Attack", "Slash").

### O que o kind 6 (automation) provou

60 campos distintos, 1.655.097 eventos no log. Mapa completo:

| campo | valores observados |
| :--- | :--- |
| `ack` | 0..13 (contador monotônico) |
| `authorized` | true |
| `boot` | hash de 32 hex |
| `busy` | false |
| `client` | "" ou hash |
| `core.movementOwner` | null \| "target" |
| `core.phase` | "idle" \| "combat" |
| `error` | "" |
| `events[]` | `{id, kind, message}` |
| `foreground` / `foregroundPid` | bool / pid |
| `gmLearning` | `{active, learned, profile, remainingSeconds, ruleIndex}` |
| `guildDaily` | `{choice, error, next, owner, queryAt, stage, status}` |
| `hoennCounts` | null \| objeto |
| `instanceEntry` | `{info, phase, running}` |
| `luring` | `{actorId, count, holding, minCount, mode, phase, target{x,y,z}}` |
| `luring.mode` | "off" \| "dynamic" |
| `luring.phase` | "off" \| "travel" \| "arc" \| "stationary" \| "wait" \| "observe" |
| `modules` | array (0..3) |
| `monitor` | `{enabled, pid}` |
| `pauseKeyDown` / `paused` / `pausedModules` | |
| `phase` | "Pausado", "Walker · WP N/23 · walk", "target: iniciando", ... |
| `phases` | `{target, walker}` com texto de fase |
| `pid` / `protocol` / `tick` | |
| `walkerIndex` / `walkerTimer{phase, remainingMs}` | |

Mensagens de evento distintas (todas as 8):
```
528441  AutoCombo concluído: ultima skill (mN).
506168  PokeStop sem confirmação após quatro tentativas; seguindo o fluxo de segurança do Lua.
387923  target: Pokémon ausente durante o combo; aguardando recuperação.
220176  AutoCombo concluído: sem monstro visível (mN).
  9043  Best Tile: limite de ajuste atingido; seguindo o fluxo de segurança do Lua.
  2187  AutoCombo concluído: skills encerradas (mN).
   834  Perfect lure: HP do Pokémon em risco (N% <= N%); liberando o combo.
   325  Revive sem confirmação do Pokémon em N s; seguindo o combate.
```

### O que o kind 11 (automation_control) provou

`op:"start"` com a **configuração completa do perfil**, idêntica em estrutura ao
nosso `local-data/profiles/electron/settings.json`. Blocos: `scripts`, `target`
(com `monsters[]`, `combo`, `autoRevive`, `luring`, `lureSkill`, `healSkill`,
`combatStanceAuto`), `healer`, `walker` (com `waypoints[]`). Traz campos que o
nosso schema **não tem**: `timerEnabled`, `timerMinutes`, `guildDailyRenewEnabled`,
`guildDailyRenewLimit`.

### O que o kind 12 (automation_lease) provou

`{protocol, boot, client, counter}` — 8.872 amostras, `counter` monotônico.
É o lease de automação: o cliente confirma posse a cada ciclo.

### O que o kind 2 (authenticate) provou

32 bytes de HMAC-SHA256, exatamente o que o nosso `transport.cjs` calcula.
Handshake fechado dos dois lados.

### O que o kind 4 (state) provou

76.723 + 89.837 amostras. Layout definitivo:
`+0 version` (na verdade um contador: 148136953..150156390), `+4 isOnline`,
`+8 healthPercent`, `+12 hp f64`, `+20 mana f64`, `+28 cap f64`, `+36 targetId`,
`+40 attackSeqNum`, `+44 protoVersion = 854`.

### Limite descoberto na telemetria

Em `pka_tap_10244.jsonl` a telemetria **para aos 70,9 s** de uma sessão de
2.019 s, e nunca volta. As 166 amostras dessa sessão são frames vazios de
1.126 B (`creatures:[]`, `position:null`). Em `pka_tap_16860.jsonl` a telemetria
é rica e contínua por toda a sessão. Diferença: na primeira o personagem estava
parado/sem combate; na segunda o bot estava ativo.

---

## 2. Engenharia reversa do runtime nativo

| artefato | conteúdo |
| :--- | :--- |
| `dumps/msftedit_text_32336.bin` | .text stomped, 2,53 MB |
| `native_dump_evidence.json` | 14 métodos `Runtime::` + `TravelLure::plan` |
| `native_rule_xrefs.json` | xrefs por chave de config |
| `native_remaining_rules_evidence.json` | âncoras byte-exatas de 4 regras |
| `PROTECAO_DINAMICA_POKEMON.md` | análise de 22,5 KB da proteção |
| `native_capture_static.json` | 259 KB de disassembly estático |

Métodos com RVA conhecido no dump: dispatcher `0x12c40` (follow/attack), init
`0x15590` (`PKA-INIT-NATIVE`), validação `0x8a756`, binding do worker
`0x8461a → 0xc6360 → 0xcfe40`.

**Importante:** esses RVAs são do build dumpado em 23/10. Não foram
reconferidos no `82eadedc` que roda hoje.

---

## 3. O que já está implementado e testado

| módulo | linhas | testes |
| :--- | ---: | ---: |
| `engines/target-engine.cjs` | 20.984 B | 13 + 34 (engines) |
| `engines/walker-engine.cjs` | 6.002 B | (engines) |
| `engines/healer-engine.cjs` | 7.687 B | (engines) |
| `engines/capture-engine.cjs` | 8.090 B | 12 |
| `engines/lure-engine.cjs` | 5.319 B | (spec) |
| `engines/alerts-engine.cjs` | 9.654 B | 11 |
| `rpm-combat-runtime.cjs` | 39 KB | **55** |
| `walker-input-runtime.cjs` | — | 22 |
| `telemetry.cjs` | — | 7 + 5 |
| `protocol.cjs` | — | 4 |
| `transport.cjs` | — | 9 + 1 live |
| `settings.cjs` | — | 7 |
| `otmm.cjs` (mapa) | — | 14 |

**66 arquivos de teste, 611 testes, 603 passando, 8 skipped, 0 falhas.**

Matriz de decisão: **13 implemented, 17 partial, 0 unsupported** de 30 regras.

### As 17 regras parciais (o que falta de verdade)

| regra | motivo |
| :--- | :--- |
| BestTileScore | fórmula existe, offsets de tile não reconferidos no build atual |
| HoennMinimum / NextTeam | depende de roster nativo do Hoenn |
| PathEstimate / PathCost | planejamento de rota sem custo calibrado |
| ComboAck / ComboBuffDone | sem confirmação nativa do ACK de skill |
| AlertMatches / AlertSuppressed / AlertNearby | filtros de GM não mapeados |
| CaptureEligible / CaptureBall / CaptureRank / CaptureApproach | `item_identity.py` preso ao build antigo |
| LureLeadScore | score de lead do lure |
| HealerTimeout / HealerDeployReady | timeouts nativos do healer |

---

## 4. O que é dado bruto não processado

| item | estado |
| :--- | :--- |
| `alert_vectors.json` (2,7 MB) | vetores de alerta, sem matriz de decisão final |
| `telemetry_vectors.json` (22 MB) | 1.993 casos sintéticos |
| `telemetry_edges.json` (2,3 MB) | 119 limites |
| `protocol_vectors.json` (654 KB) | 3.470 vetores |
| `native_runtime_evidence.json` (3,4 MB) | evidência bruta |
| `rea_evidence_20261022.json` (7,7 MB) | análise REA |
| `hunt_session_40min.jsonl` | sessão de caça de 40 min |
| `pka_tap_12576.jsonl` (757 MB) | **não analisado** |

---

## 5. O que NÃO temos

1. **Execução nativa de `attack`/`talk`/`combo`.** Só `walk` e `hotkey` funcionam
   (PostMessageW). O resto responde `status 3`. Falta o RVA do dispatcher no
   build atual.
2. **RVA do dispatcher no `82eadedc`.** O `0x12c40` é do dump de 23/10.
3. **Captura de item.** `item_identity.py` usa RVAs de vtable do build antigo.
4. **Mapa de tiles em memória.** O `OtmmReader` lê arquivo, não a memória do jogo.
5. **Semântica de `combatStanceAuto`** (fight 1..3).
6. **`finishRemainingCount` / `usePokeStop`** nativos.
7. **Filtros de alerta de GM** (self/mode).
8. **`creatures[]` dentro da DLL nativa** — sai da memória via Python, não do C.
9. **Confirmação de efeito.** `effectVerified` é `false` em tudo.

---

## 6. Resposta direta: dá para terminar "igual ao Shiba"?

**Sim para o comportamento. Não para o binário idêntico. Sem inventar nada, com
uma condição.**

### O que dá para fazer sem inventar um único valor

| capacidade | base |
| :--- | :--- |
| Ler estado completo do jogo | `kind 5` real, 6.007 amostras decodificadas, 0 falhas |
| Ler posição/HP/online | `kind 4` real, layout confirmado em 166.560 amostras |
| Ler criaturas com tipo/nome/HP/look/shiny | captura real com exemplo concreto |
| Ler itens com id/stack/instance/pos | 277 itens reais capturados |
| Ler roster com UUID e cooldowns por skill | roster real de 3 slots |
| Saber o estado da automação a cada 200 ms | `kind 6`, 60 campos mapeados |
| Saber o lease | `kind 12`, 8.872 amostras |
| Receber a config exata do perfil | `kind 11`, estrutura completa |
| Handshake HMAC | validado nos dois sentidos, 2 testes diferenciais |
| Servir o canal | `pka_native.dll` provada no jogo real |
| Andar e usar hotkey | `status 0`, teclas contadas na janela do alvo |
| Todas as 30 regras de decisão | 13 implementadas + 17 documentadas com contrato |

### O que NÃO dá para fazer sem inventar

**Executar `attack`, `talk`, `combo` nativamente.** Não existe RVA confirmado no
build atual. Qualquer número que eu colocar ali seria chute — exatamente o tipo
de coisa que você proibiu.

Duas saídas honestas:

**(a) Executar por teclado.** O jogo aceita F1..F12 (mapeado no `config.otml`).
`attack` vira: clique no corpo do monstro (projetado com `tileSize` calibrado) +
hotkey da skill. Isso funciona hoje, é o que o `rpm-combat-runtime` já faz, e
cada número vem de calibração medida — não de suposição.

**(b) Descobrir o dispatcher.** Preciso de um dump do `.text` do build
`82eadedc` em execução. Já temos o procedimento (`dump_stomped_module.py`,
`find_module_xrefs.py`) e o precedente: no build de 23/10 o dispatcher foi
achado por RTTI + xref. Com o dump novo, o RVA sai de evidência.

### A condição

"Zero ou null" só vale onde o dado é genuinamente ausente. Já é o que fazemos:

- `hp: -1` quando o cliente não leu (sentinela real do protocolo)
- `itemCounts: null` quando não há contagem (real)
- `creatures: []` quando não há criatura na tela (real)
- `status 3` quando a função nativa não existe no nosso lado (código do próprio protocolo)
- `effectVerified: false` sempre

O que **não** vou fazer é preencher `attack` com um RVA chutado, ou fingir que
`combo` executou. Isso quebraria a regra que você deu.

### Veredito

| meta | viável | base |
| :--- | :--- | :--- |
| Ler tudo que o Shiba lê | **sim** | capturas reais, 0 invenção |
| Decidir igual ao Shiba | **sim, 13/30 provado; 17 com contrato** | matriz de decisão |
| Falar o protocolo | **sim** | handshake + 8 kinds mapeados |
| Executar movimento e hotkey | **sim, provado no jogo** | status 0 + teclas contadas |
| Executar attack/combo nativo | **não sem dump novo** | RVA não confirmado no build atual |
| Ser binário idêntico | **não** | e não é necessário |

O caminho mais curto para "igual ao Shiba" é: manter leitura 100% baseada em
captura (já está), execução por teclado para combate (já funciona), e atacar o
dump do `.text` novo só para `attack`/`combo` nativos. Nenhuma etapa exige
inventar valor.
