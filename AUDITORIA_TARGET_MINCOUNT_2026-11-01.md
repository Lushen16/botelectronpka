# Target, Perfect Lure e Min Count — auditoria de 2026-11-01

## Escopo

Discrepância entre o Shiba Bot original (PKA Tools 3.1.9) e a reconstrução:
o bot atacava antes de juntar os monstros exigidos por `minCount`/Perfect Lure.
Fontes: `schema_fields.json` e `readable/shared/schema.js` (limites e dicas),
`readable/renderer/target.js` (dicas de `range`, `minCount`,
`perfectingLureHpPercent`, `finishRemainingCount`), `STATUS.md`,
`reconstruction/spec/decision-rules-v1.json`, `standalone/TargetEngine.js`
(reconstrução de referência do fluxo) e o perfil salvo em
`PKA_Tools_Reconstrucao_2026-10-22/RE_PKA/local-data/profiles/electron/settings.json`.
A rotina nativa original só existe em bytecode; nada aqui foi validado no jogo.

Perfil observado: `monsters:[{name:'*', range:17, minCount:8, movement:'stand'}]`,
`combo.perfectingLureEnabled:true`, `perfectingLureRange:3`,
`hoenn.perfectLure:true`, `minWildsToEngage:8`, `perfectLureMinHp:60`,
`perfectLureTimeoutMs:10000`, `luring.enabled:false`,
`autoRevive.enabled:true` com `hotkey:""`.

## Causas encontradas

1. **Ataque antes do gate do Perfect Lure** (`target-engine.cjs`, antigo bloco
   de `send('attack')` imediatamente após a cura). O motor atacava a cada
   `ATTACK_RETRY_MS` enquanto a box ainda não tinha os monstros, matando o
   agrupamento que o gate esperava. Passava também pelo teste
   "combo perfect lure holds combo..." que registrava o ataque durante
   `waiting-perfect-lure`.
2. **`minCount` contado no alcance errado**. A contagem usava `max(range)` de
   todas as regras, a partir do treinador. Uma regra com `range:2` contava
   monstros a 17 tiles; e a contagem não era por linha. A dica do campo diz
   "pelo menos esta quantidade deste monstro perto do seu Pokémon", e a matriz
   anterior já registrava que a posição do Pokémon precisava ser distinguida.
3. **`minWildsToEngage` amarrado ao Perfect Lure**. O gate Hoenn só valia com
   `perfectLure` ligado; desligar o Perfect Lure desligava também a parada da
   rota por selvagens na tela.
4. **HP de emergência do Perfect Lure errado**. O gate usava
   `combo.perfectingLureHpPercent` (30 no perfil) em vez de
   `hoenn.perfectLureMinHp` (60), então o robô esperava a box com o Pokémon já
   abaixo do HP que o Hoenn manda atacar.
5. **Timeout aplicado em waypoint de box**. O original só libera por tempo no
   lure comum; em waypoint `box` ele espera a box fechar. O adaptador não
   conhecia o modo da box.

## Correções aplicadas

- `reconstruction/engines/target-engine.cjs`
  - `referencePoint`/`chebyshev` (l.46-63): contagem a partir do Pokémon
    (`ownPokemon.pos`) quando conhecido, com fallback para o treinador.
  - `matchingRules` (l.65) e `ruleRange`: cada regra conta no seu próprio
    `range`; aceita tanto a forma do schema quanto `['*']`.
  - `checkMinCountMet` (l.81): conta por regra; sem `minCount` explícito o gate
    por linha não substitui `minWildsToEngage`.
  - `step` (l.213-247): pool por regra+alcance; `detected` é a tela inteira no
    Perfect Lure (parada da rota) e o pool com alcance quando desligado;
    `minWilds` deixou de depender de `perfectLure`.
  - Ataque movido para depois do gate do Perfect Lure (l.275-321): em
    `waiting-perfect-lure` não há mais `attack`; o ataque sai no mesmo tick em
    que a box fecha, antes do combo.
  - Gate usa `hoenn.perfectLureMinHp` com fallback para
    `combo.perfectingLureHpPercent` (l.290-297).
  - Timeout respeita `context.boxMode` (l.299). `targetSince` agora é `null`
    até existir alvo, para funcionar com relógio começando em zero.
- `reconstruction/automation.cjs` (l.67): o modo Hunt zera
  `minWildsToEngage`, já que ele desliga `perfectLure` de propósito e não deve
  herdar a parada da rota.
- `reconstruction/walker-input-runtime.cjs` (l.90-97): `state.walkerAction`
  expõe a ação do waypoint atual.
- `reconstruction/rpm-combat-runtime.cjs` (l.573): repassa
  `boxMode: walkerAction === 'box'` ao motor.
- `tests/engines.test.cjs`: o teste do Perfect Lure agora exige zero eventos
  durante a espera; três testes novos cobrem contagem por regra/posição do
  Pokémon, `hoenn.perfectLureMinHp` e timeout em modo box.

## Pendências conhecidas

- O `RpmCombatRuntime` não executa o `lure-engine` (dynamic/front lure): ele só
  repassa `luring.enabled` para o buff de lure. O lure dinâmico com `chase`/
  `order` e os holds de movimento existem apenas em `automation.cjs`. No perfil
  atual `luring.enabled` é `false`, então isso não altera o comportamento dele.
- `monsters[].movement`/`kiteRange`/`randomMoves` continuam sem implementação
  no Target. Com `movement:'stand'` o walker já para durante o combate; para
  `chase`/`kite` o RPM continua andando a rota durante o combate.
- O `EngineRuntime` (adapter nativo) não informa `boxMode`; nele o timeout do
  Perfect Lure ainda libera em waypoint de box.
- `autoRevive.enabled:true` com hotkey vazia é ignorado em silêncio no RPM. O
  diagnóstico original exigia a hotkey para iniciar o Target; o RPM não a exige.
  Recomenda-se avisar na UI quando `autoRevive.enabled` e a hotkey estiver vazia.
- `finishRemainingCount` usa `inspect()` (candidatos dentro do alcance das
  regras), enquanto a dica fala em "monstros vivos na tela". Com `range:17` a
  diferença é pequena, mas não é equivalência provada.
- Nenhuma verificação no cliente real nesta rodada.

## Validação

`node --test` sobre `tests/*.test.cjs`: 602 testes, 594 aprovados, 8 ignorados,
0 falhas.
