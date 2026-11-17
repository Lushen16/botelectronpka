# RACIOCÍNIO.md — caderno de raciocínio do projeto

Este arquivo é para **pensar**, não para executar. Nada aqui é tarefa aprovada.

O objetivo é ter um lugar onde o agente argumente, levante hipótese, discorde e
deixe o raciocínio registrado — sem que isso vire código por engano.

## Como usar

**Modo raciocínio (somente leitura):**

```
codex exec --sandbox read-only \
  "Leia RACIOCINHO.md e o código relevante. NÃO edite nada. \
   Responda com sua análise e as hipóteses, apontando o que é medição e o que é palpite."
```

**Modo execução (uma tarefa, escreve):**

```
codex exec --sandbox workspace-write "T1 do COMBATE_SHIBA_MAQUINA.md"
```

A diferença é o sandbox. `read-only` não escreve nada — é seguro para raciocinar.

## Regras deste documento

1. **Toda afirmação carrega a fonte.** Medição, código lido, ou palpite. Sem
   fonte, é palpite e deve dizer isso.
2. **Discordar é resultado válido.** Se o diagnóstico de uma tarefa estiver
   errado, dizer isso vale mais que implementar o erro.
3. **Nada vira código sem sair deste arquivo.** Uma ideia aqui é hipótese até
   virar brief numerado.
4. **Não apagar raciocínio antigo.** Se mudou de opinião, adicionar a revisão
   com a data. O histórico importa.
5. **Não colar captura nem dump.** Referenciar por caminho e linha.

## Fronteira de evidência (herdada do AGENTS.md)

Sustentado por medição — pode ser usado como premissa:

- combo pelo interpretador `exe+0x67fbf0`, literal `"!autocombo"` (10 bytes)
- `attack` recusa em `[rt+0x2548]` com `rc == 4`; só HP caindo conta
- `potion` é número; `revive` é rejeitado pelo protocolo
- `hotkey`/`potion` funcionam sem foco; `walk` exige foco
- lure: `perfectingLureRange` 3, HP emergência 30%, timeout 10000
- ordem das fases: Best Tile → PokeStop → Perfect lure → AutoCombo
- durações: Perfect lure 2,4 s · AutoCombo 1,3 s · Best Tile 750 ms
- PokeStop: 4 tentativas, depois segue
- `finishRemainingCount` 2; `pokeReadyTimeoutMs` 3000
- cadência de passo 406 ms/tile

**Não** sustentado — tratar como palpite:

- distância que o Shiba mantém entre Pokémon e monstro
- box medida em tiles
- movimento do Pokémon durante a lure
- fluidez de caminhada e pathfinding
- parada física na lure

Motivo: a captura de 351,8 MB tem **zero frames com selvagem**.

---

## Aberto — hipóteses em avaliação

### H1. O `lure-engine` mistura dois modos incompatíveis

`reconstruction/engines/lure-engine.cjs` modela três modos num só motor:

| modo | origem na config | intenção |
| :--- | :--- | :--- |
| `distance` | `luring.enabled` | treinador PARA e espera o Pokémon |
| `dynamic` | `luring.frontEnabled` | Pokémon vai à frente |
| `random` | `luring.randomEnabled` | alterna andar/esperar |

Os três devolvem `allowMovement`, e `automation.cjs:226` usa um único booleano
para decidir se o walker roda. Mas "segurar o Pokémon" e "segurar o treinador"
são coisas diferentes.

**RESOLVIDO — vale a leitura (b), e o diagnóstico do `holdMovement` estava
errado.** A política de segurar está certa; o defeito era a retomada. Segurar o
walker sem avisar deixava o passo pendente vivo, e o primeiro tick após o hold
devolvia `hold: await-position-sample` por até 2,5 s — a mesma classe de bug que
`notifySkipped()` já resolvia no caminho do combate.

Correção (`reconstruction/automation.cjs:228`), nenhum campo novo:

```js
else {
  walker.notifySkipped();
  walk = { action: 'held', emitted: [], reason: 'lure-hold' };
}
```

**Prova:** `tests/engines.test.cjs` — *"automation resumes walking on the first
tick after a distance lure hold"*. Com a chamada removida o teste falha
(`expected: 'move'`, `actual: 'hold'`, reason `await-position-sample`); com ela
volta a passar. Reproduzido em simulação; **não** verificado no jogo.

**Ressalva:** `huntStep()` não consulta o lure, então o caminho `hunt` nunca teve
a trava e continua sendo a referência de comportamento. E o `holdMovement`
descrito no brief antigo não existe como campo — se alguém procurar por ele, não
achará.


### H2. Best Tile está aproximado, não fiel

`target-engine.cjs` usa `chebyshev(boxCenter, creature.pos) <= bestTileRange`
como "alvo está na melhor tile". A fórmula de score do Shiba está marcada como
`blockedBy` em `reconstruction/spec/remaining-rules-v1.json` (constante 4000 em
`0x933b2`, ainda sem ranking).

**Consequência:** um alvo dentro do range passa, mesmo que o centro não seja o
melhor tile. É conservador (não trava), mas não é equivalente.

**A testar:** se `0x933b2` for alcançável, vale extrair o score. Se não, registrar
a limitação e seguir.

### H2b. `movement` do treinador — 3 dos 4 modos não existem no motor

O schema do fornecedor (`Extracted_Source/shared/schema.js`) promete quatro
valores para `target.monsters[].movement`, com texto literal:

| valor | promessa |
| :--- | :--- |
| `chase` | "Chase · segue o monstro" |
| `stand` | "Stand · fica parado" |
| `kite` | "Kite · mantém distância" (`kiteRange`, 1..30) |
| `random_move` | "Random · alterna os de baixo" |

**Medido em 2026-11-16:** `grep kiteRange` em `reconstruction/` e `botfinal/`
não acha consumo fora de UI e schema. Nenhum dos quatro é implementado no motor
de combate.

`stand` coincide por acidente: o combate devolve `pauseWalker: true`, então o
treinador fica parado enquanto luta — exatamente o que `stand` promete. A config
real do usuário usa `movement: "stand"` + `kiteRange: 2`, então hoje o
comportamento está certo por sorte.

**Correção aplicada:** `reconstruction/combat-readiness.js` passou a **avisar**
quando `movement` é diferente de `stand` (e o combo está desligado, porque o
schema diz "Só com o combo Desligado"). Não inventamos a implementação de
`kite`/`chase`/`random_move` — avisar é melhor que fingir.

**O que ficaria para implementar de verdade:** `kite` é o único com semântica
clara e barata — manter `kiteRange` tiles do alvo, andando para longe quando
mais perto. Mas exige que o motor de combate emita `walk`, e hoje:

- `rpm-combat-runtime.cjs:676` rejeita qualquer comando fora de
  `['hotkey','talk','combo']` — um `walk` vindo do combate lança erro;
- `engine-runtime.cjs` pausa o walker quando o status é `combat`.

Ou seja: implementar `kite` no clone exige mexer no contrato de despacho dos
dois runtimes, não só no motor. É projeto, não tarefa.

### H3. O `kind5` do Shiba não publica monstros — **CONFIRMADO (a)**

Medido em 351,8 MB (2026-11-15): 1.705 amostras de `kind5`, tipos `{0, 3}`,
zero `type 1`.

**Repetido em 2026-11-16 com o Shiba caçando de verdade.** Armadilha do
experimento: desta vez ele estava funcional — `kind6` mostrava
`lure.mode: dynamic`, `count: 6/8`, `phase: "Walker · WP 5/21 · walk"`.
Ou seja, havia 6 monstros na área do combo enquanto capturávamos.

Mesmo assim, no arquivo inteiro (`native/pka_tap_23324.jsonl`, 44,3 MB):

```
kind5: 554 amostras
MAX criaturas num frame: 2   → Banedenovootario(t0), Dugtrio(t3)
types vistos: {"0": 554, "3": 554}
frames com type 1: 0
frames com type 4: 0
```

**Leitura (a) confirmada:** ele esconde as criaturas de propósito. Não é falha
de buffer — o mesmo `kind5` publica `tiles` (203) e `items` (271) normalmente,
então o payload está completo; ele simplesmente **não inclui `type 1`**.

### Consequência para a geometria do combate

Nenhuma captura passiva dará distância, box ou movimento do Pokémon. O dado não
sai do processo dele. As saídas possíveis, em ordem de esforço:

1. **Vídeo sincronizado** — o `RELATORIO-VALIDACAO.md` já registra a ausência.
   Renderia geometria aproximada e exigiria um pipeline de visão.
2. **Leitura de memória no processo do Shiba** — a lista de monstros existe no
   runtime dele (o `kind6.count` prova). Achar a estrutura é o mesmo tipo de
   trabalho que já fizemos com `LocalPlayer`/`Monster` no nosso cliente.
3. **Definir a política por conta própria** — o nosso cliente já publica
   `creatures` com posição. Não copia o Shiba, mas destrava o combate.

**Não** vale tentar mais capturas passivas. A hipótese (a) está fechada.

### Detalhe útil descoberto no caminho

O `kind5` do Shiba **tem** `items[]` com `pos` (249 itens observados) e
`tiles[]` com `walkable` (186-203 por frame). Então há geometria de cenário no
payload — só não há de criatura. Isso é o oposto do que o nosso cliente faz. 

### H4. Dois agentes editando os mesmos arquivos

Hoje `reconstruction/rpm-combat-runtime.cjs` mudou 22 s antes de eu olhar, por
outro agente. `target-engine.cjs` e `playtform` também são disputados.

**Risco:** colisão silenciosa — um sobrescreve o outro e a suíte fica verde
mentindo.

**Mitigação em uso:** verificar `mtime` antes de editar e confirmar que o ponto
de inserção ainda existe (grep da linha exata) em vez de confiar em número de
linha do brief.

---

## Registro

### 2026-11-16 — abertura

Criado para separar raciocínio de execução. Contexto: o agente anterior estourou
65.828 de 65.536 tokens lendo 8 fontes completas antes de escrever código.

Decisão: raciocínio vai aqui; brief numerado vai para a missão. O brief carrega
o mínimo e aponta para a evidência por caminho, nunca por cópia.

### 2026-11-16 — G02: contexto de lure para o Target (B.4 fechado)

**Defeito:** `automation.cjs` passava `luring: config.target.luring.enabled === true`
ao Target. Com a config real (`enabled: false`, `frontEnabled: true`) o
`lure-engine` roda em `dynamic`, mas o Target recebia `luring: false` → o
`lureSkill` (buff ao lurar) nunca era emitido pelo caminho nativo.

**Semântica escolhida: MODO CONFIGURADO, não fase do tick.** Três evidências:

1. `lureSkill` vem do helper `m()` no schema do fornecedor
   (`../Extracted_Source/shared/schema.js`), rotulado literalmente
   **"Buff ao lurar"** — acompanha o modo ativo, não uma fase.
2. `normalizeLuring()` (`lure-engine.cjs:28`) é a fonte única do modo e é
   **pura**: não emite, não consome cooldown, não toca `state`.
3. A ordem do tick torna a fase inacessível sem antecipar efeitos:
   `target.step` roda antes de `lure.step`, então a fase do tick corrente
   ainda não existe no ponto onde o Target precisa dela.

**Correção:** reutilizar `normalizeLuring` no `automation` e passar
`luring: mode !== 'off'`. Preserva a precedência `random > dynamic > distance`
sem duplicar a regra, e não chama `lure.step` duas vezes.

**Limite:** o contexto responde "existe lure ativo?", não "em que fase". Se um
dia o `lureSkill` precisar ser específico por fase (ex.: só em `holding`), o
`automation` terá que repassar `lureResult.state` do tick ANTERIOR — e isso
introduz um tick de defasagem que precisa ser medido antes de aceito.

**Prova:** 7 testes novos em `tests/engines.test.cjs` exercitam o ponto de
entrada `createAutomation().tick` (não a função de normalização isolada).
Mutação: restaurar a expressão antiga faz 4 deles falharem (dynamic, random,
precedência e hp/cooldown). `walker.notifySkipped()` e a retomada após hold
seguem cobertos pelo teste que já existia.


---

## G04 — Capacidades explícitas e recusa antecipada (2026-11-17)

**Defeito:** `native-adapter.cjs` publicava `supportedCommands =
Object.keys(COMMANDS)`. Isso é o vocabulário do **encoder**, não o que o
servidor conectado executa. Como os três gates (`engine-runtime.cjs:190,261`,
`native-adapter.cjs:59`) comparavam contra essa lista, nenhum comando era
barrado antes do envio. Pior: os dois simuladores aceitavam tudo —
`RuntimeServer` com auto-ACK `status 0` genérico e `local-runtime.cjs:144`
tratando o resto como no-op e devolvendo `true`. Resultado: `chase` nunca
falhava em teste e sempre falhava no jogo (`status 4` da DLL → `fault()` →
sessão encerrada). B.2 sobreviveu a ~880 testes verdes por causa disso.

**Contrato:** extensão nossa, explicitamente versionada e **não** recuperada do
fornecedor — `{"contract":"pka-capabilities","version":1,"server":"pka_native",
"commands":[...]}` dentro do `kind 6`, campo `capabilities`. O envelope já
existia e já trazia `modules`/`paused`/`monitor`; o transporte **ignorava** o
frame (caía em `emit('frame')` sem listener). Não usamos `welcome` porque
`transport.cjs:105` exige exatamente 36 bytes.

**Lista declarada:** `walk, attack, stop, talk, combo, switchPokemon, potion,
hotkey` — os únicos 8 tipos com handler em `execute_command`
(3171/3308/3292/3607/3627/3709/3748/3240). Fora de propósito: `revive` (o
encoder rejeita), `chase` e os 12 sem handler. Um teste lê `CAP_COMMANDS` do
`pka_native.c` e compara com `capabilities.cjs`, para os dois não divergirem.

**Estados da declaração:** `valid` (contrato+versão reconhecidos), `unknown`
(contrato diferente — não habilita NADA), `malformed` (sem versão/lista) e
`absent` (nada recebido — não habilita NADA). Não existe lista presumida.
A espera é limitada (`capabilityTimeoutMs`, 1,5 s no adapter real) e nunca
trava; o `kind 6` sai 500 ms após o handshake, então normalmente chega no mesmo
chunk do `welcome` — e `transport.connect()` despacha os frames antes de
resolver, por isso a declaração não se perde.

**Recusa antes do despacho:** `engine-runtime.resolveModules()` avalia os
requisitos dos módulos pedidos. Se nenhum é compatível, nada sobe (sem timer,
sem comando). Se parte é compatível, os compatíveis sobem e o motivo fica em
`state.error`. A config do usuário **não** é alterada e o modo **não** é
trocado. Requisito de `dynamic lure`: `chase`. Config sem `chase`
(`distance`, `random`, `off`) não é penalizada. Walker isolado com `walk`
(+`talk` se houver waypoint `say`) sobe sozinho.

**Defesa adicional:** o lote do tick é validado inteiro antes do primeiro
envio (`engine-runtime.cjs:307-310`). Isso evita envio parcial por
incompatibilidade detectável localmente — não promete atomicidade contra falha
posterior (ACK, timeout).

**ACK:** o código numérico é preservado em `error.statusCode`; a interpretação
vem do nosso contrato quando reconhecido (`statusMessage`). Para contrato
desconhecido, mensagem neutra com o código bruto. `protocol.cjs:STATUS` **não**
foi alterado: ele descreve o fornecedor, e ali `4` = "identidade do Pokémon
mudou" enquanto a DLL usa `4` = `UNSUPPORTED` (`pka_native.c:2304`).
Distinção confirmada no código: o retorno interno de `attack` (`rc == 4` =
recusado, `pka_native.c:3558`) **não** é o ACK — `pka_native.c:3587` devolve
`STATUS_OK` mesmo quando o handler recusou. `status 0` nunca significou acerto.

**Prova:** `tests/capabilities.test.cjs` (14 testes). Mutação: restaurar
`Object.keys(COMMANDS)` no adapter faz **5** falharem (declaração ausente,
reconexão, declaração tardia, contrato desconhecido, ACK). O teste da fixture
**estrita** (`RuntimeServer({strict:true,declaration})`) reproduz exatamente o
que o auto-ACK ocultava: `chase` → `status 4`, enquanto o comando declarado
continua `status 0`. A fixture permissiva segue existindo para
framing/autenticação, documentada como "não é prova de implementação".

**Limite:** contenção, não implementação. O regroup continua inexistente: com
`frontEnabled: true` a automação é **recusada** com motivo objetivo em vez de
derrubar a sessão no meio do tick. O lure **não** foi alterado (decisão da
coordenação) e `chaseState` não é mais avançado por uma ação descartada — a
política segue como estava e simplesmente não roda quando recusada.

**Pendente:** compilar `pka_native.dll` (artefato desta rodada foi gerado em
diretório temporário apenas para provar que o C compila; o binário em uso não
foi substituído); B.1 (chave do canal); validação real no jogo.

---

## G04-R1 — Fechar lacunas da revisao (2026-11-17)

**Cinco correcoes sobre o patch G04, todas vindas da revisao da coordenacao.**

### 1. `stop` entrou no contrato operacional

`pauseWalker()` sempre manda `stop`; sem ele o runtime nao consegue conter o
que iniciou — nem movimento nem combate. `INTERRUPT_COMMAND = 'stop'` agora e'
requisito de `target` e de `walker`. Requisito ausente = ativacao recusada:
um servidor que declara `walk` sem `stop` nunca comeca a andar.

`pause()` quando `stop` nao existe: encerra os despachos localmente e registra
`interruptState = 'unconfirmed-no-stop'`. **Nao declara parada confirmada.**

### 2. Partida conjunta nao vira execucao parcial

`resolveModules()` agora devolve `refused: true` e `modules: []` quando
qualquer modulo pedido e' incompativel. Antes eu filtrava os compativeis e
subia o resto — era exatamente a "execucao parcial automatica" que a revisao
proibiu. Walker isolado compativel continua subindo, porque a solicitacao e'
so' ele. A config do usuario nao e' tocada e o motivo fica em `state.error`.

### 3. Requisitos refletem o caminho efetivo

Reescritos contra os emissores reais:

| caminho | evidencia | requisito |
| :--- | :--- | :--- |
| ataque | `target-engine.cjs:407` | `attack` + `stop` |
| healSkill / lureSkill / PokeStop / combo enumerado | `:274-285`, `:426-432`, `:535`, `:585` | `talk` |
| combo nativo com hotkey | `:437-455` | `hotkey` |
| combo nativo sem hotkey | `:544-551` | `combo` |
| rotacao de skills | `:411-414` | `hotkey` |
| autoRevive | `automation.cjs:138` | `hotkey` (**nunca** `revive`) |
| potion / medicine | `healer-engine.cjs:52-63` | canal exato de `itemChannel()` |
| cura / reset | `:114-127` | `talk` |
| retorno ao Pokemon | `:137-148` | `switchPokemon` |
| captura | `engine-runtime` beforeActions | `useWith` |

**Canal de item sem fallback:** `hotkeyChannel()` usa a hotkey quando existe e
so' cai em `action` quando ela esta' vazia. O requisito `mode:'any'` foi
removido — aceitar "qualquer um dos dois" permitiria `action` num servidor que
so' tem `action`, e o motor com hotkey configurada falharia em tempo de
execucao. Agora o requisito e' o canal que o motor realmente vai usar.

**`normalizeLuring` reutilizado.** A copia local (com `maxDistance` 1..30,
enquanto o lure-engine usa 1..16) foi apagada. `capabilities.cjs` importa a
funcao do lure-engine. Ha teste comparando o modo com config fora do limite.

**Captura exige `useWith`, que a nossa DLL nao implementa** — entao
`captureEnabled: true` e' recusado na partida em vez de falhar no meio.

### 4. Capacidade retirada durante a sessao

`tick()` revalida **antes** de chamar `automation.tick`. Se `stop` sumiu ou
qualquer requisito caiu: nenhum motor avanca `comboIndex`, nenhum cooldown e'
consumido, nenhum comando sai. `interruptState` registra
`blocked-by-capability` ou `unconfirmed-no-stop`. `togglePause()` recusa
retomar ("reative o modulo para revalidar") — nao ha retomada automatica
quando a capacidade reaparece.

### 5. Sem validade implicita para `supportedCommands`

`engine-runtime.declaration()` so' le `adapter.capabilities()`. Um adaptador
que expose apenas `supportedCommands` e' tratado como **sem declaracao**, que
nao habilita nada. Fixtures foram atualizadas para declarar
`{contract, version, server, commands}` explicitamente, inclusive
`tests/capture_runtime.test.cjs`, cuja fixture declara `useWith` com comentario
dizendo que e' escolha do fixture e que a DLL nao o implementa.

### 6. Declaracao e diagnostico

`parseDeclaration` separa tres coisas que antes se confundiam:

- `commands` — nomes que o **encoder** conhece (nao a lista da nossa DLL:
  um outro servidor pode legitimamente declarar `chase`);
- `unrecognised` — nomes que o encoder nao conhece; nao habilitam nada;
- `server`/`serverValid` — **informativos**. Nome ausente e' aceito e marcado;
  nome presente **nao** autentica o binario nem prova efeito no jogo.

`revive` e' conhecido pelo encoder mas rejeitado sempre
(`protocol.cjs:108`). Ele sai de `ENCODER_COMMANDS` e a prova e' um teste
contra `encodeCommand`, nao contra uma lista nossa.

`statusMessage` preserva o codigo bruto; `protocol.cjs:STATUS` continua
intacto.

### Prova

`tests/capabilities.test.cjs`: 29 testes. `tests/engine_runtime.test.cjs`: 34.
Total focalizado: **184 testes, 183 passam, 1 skip** (transporte live exige o
jogo).

Mutacao obrigatoria — `resolveModules` voltando a remover so' os modulos
incompativeis:

```
not ok 9  - dynamic lure is refused before any automation command is sent
not ok 12 - a batch with an incompatible command sends nothing at all
not ok 16 - a server declaring walk but not stop cannot start movement
not ok 17 - a joint request with one incompatible module starts nothing
not ok 18 - the walker requested alone still starts after the joint refusal
not ok 25 - an adapter exposing only supportedCommands gets no implicit validity
```

O teste 17 e' a protecao contra partida parcial pedida explicitamente.

### Limites

- Regroup **nao** implementado (fora de escopo, por decisao da coordenacao).
- Validacao no jogo: nenhuma. Tudo e' fixture e simulacao.
- `native/pka_native.dll` **nao foi substituida**: o artefato desta rodada
  (`pka_native_g04r1.dll`) foi compilado em diretorio temporario apenas para
  provar que a fonte compila. A DLL em uso continua a de 14/11, que **nao
  declara capacidades** — ate o deploy, o adapter ve `absent` e recusa tudo.
- B.1 (chave do canal) continua pendente: sem ela o caminho nativo nem e'
  selecionado.

---

## G04-R2 — Interromper acoes apos retirada de capacidade (2026-11-17)

**Defeito conferido.** O ramo `capability-lost` de `EngineRuntime.tick()` marcava
`paused = true`, encerrava o timer e impedia o motor de avancar — mas **nao
enviava `stop`**. Uma acao ja entregue (`attack`, `walk`) continuava no jogo.
Alem disso, chamar `pause()` em seguida pulava a parada por
`wasActive = !this.paused === false`.

### Correcao

**`requestStop(reason)` — single-flight.** `tick` (retirada), `pause`, o catch
do `runTick` e `close` compartilham a mesma promessa. Uma unica tentativa por
episodio; depois dela, `stopOutcome` so' e' relido. Sem duas paradas
concorrentes.

**Uma tentativa com prazo limitado**, via `bounded()` (`timeoutMs`, 1500 ms por
padrao). Nunca lanca: o resultado vai para o registro.

**`handleCapabilityLoss(missing)`** centraliza a retirada: marca o bloqueio,
faz `epoch++` (o laco de despacho para na proxima verificacao), encerra o
timer, fixa o **motivo original** em `last`, e so' entao tenta a parada. O
resultado do `stop` entra em `last.interruption` — **nunca substitui** o motivo.

**`pause()`** passou a considerar `pending = this.moving || this.engaged`, alem
de `wasActive`. Era o furo do `wasActive`: se algo ja tinha marcado `paused`,
a acao entregue ficava sem interrupcao.

**`close()`** tenta uma parada pelo mesmo caminho antes de fechar o canal —
sem duplicar a de `pause`.

### Registro separado, como pedido

`interruption` distingue quatro coisas que nao sao a mesma:

| campo | significado |
| :--- | :--- |
| `localPaused` | os despachos locais pararam |
| `stop: 'acked'` | o `stop` foi **entregue** (ACK positivo) |
| `stop: 'no-stop'` / `'absent-before-send'` | nao havia `stop` para enviar |
| `stop: 'rejected'` / `'timeout'` | tentamos e falhou, com `stopError` |

`physicalProof` e' **sempre `false`** e esta documentado: ACK do `stop` diz
"comando entregue ao executor", nunca "parou no jogo". Nao ha medicao de
posicao aqui.

`interruptState` acompanha: `confirmed`, `unconfirmed-no-stop`,
`unconfirmed-error`.

### Retomada

`togglePause()` recusa retomar enquanto `capabilityBlock` existir. A capacidade
reaparecer **nao** retoma nada: o runtime continua pausado ate' uma nova
solicitacao explicita de modulos, que revalida tudo. `setModules` com sucesso e'
o unico caminho que zera o episodio.

### Prova

8 testes novos em `tests/engine_runtime.test.cjs` (34 -> 42). Os seis exigidos:

| exigencia | teste |
| :--- | :--- |
| ataque entregue + `attack` retirado + `stop` disponivel | "an attack already dispatched is interrupted once when attack is withdrawn" |
| movimento entregue | "movement already dispatched is interrupted once..." |
| `stop` ausente | "without stop nothing impossible is sent and the stop stays unconfirmed" |
| `stop` rejeitado / timeout | "a rejected stop keeps both causes..." / "a stop timeout also preserves both causes" |
| capacidade restaurada permanece pausado | "a restored capability leaves the runtime paused" |
| chamadas concorrentes nao duplicam | "concurrent pause and capability loss do not duplicate the stop" / "close after a capability loss does not send a second stop" |

Mutacao obrigatoria — retirar o despacho de `stop` do ramo de retirada:

```
not ok 35 - an attack already dispatched is interrupted once when attack is withdrawn
not ok 36 - movement already dispatched is interrupted once when a required capability is withdrawn
not ok 37 - without stop nothing impossible is sent and the stop stays unconfirmed
not ok 38 - a rejected stop keeps both causes: capability loss and stop failure
not ok 39 - a stop timeout also preserves both causes
not ok 42 - close after a capability loss does not send a second stop
# tests 42 / pass 36 / fail 6
```

Restaurado: 42/42.

### Limites

- **Nenhum efeito fisico foi medido.** `physicalProof: false` em todos os
  caminhos; nao ha leitura de posicao para confirmar que o personagem parou.
- **Uma tentativa, nao retentativa.** Se o `stop` falhar, o registro guarda a
  causa e a execucao fica encerrada — nao ha segunda tentativa no mesmo
  episodio, por decisao explicita.
- Politica do lure, protocolo e DLL intocados.

---

## G04-R3 — Renovar o episodio de parada apos retomada explicita (2026-11-17)

**Bug conferido.** `togglePause()` nao renovava o episodio de parada. Sequencia
real: pausar -> retomar -> novas acoes -> pausar de novo. A segunda pausa
encontrava `stopOutcome` do episodio ANTERIOR em `requestStop()` e devolvia o
ACK antigo **sem enviar `stop`**. O movimento novo ficava sem interrupcao.

**Correcao — episodio como cidadao de primeira classe.**

`beginStopEpisode()` incrementa `stopEpoch`, zera `stopOutcome`, `interruption`
e `interruptState`. E' chamado nos dois unicos pontos que autorizam automacao:

- `setModules()` com sucesso (ja era o caso);
- `togglePause()` aceito (**novo** — era o buraco).

**Guardas adicionadas em `togglePause()`:**

1. **Revalida capacidades antes de retomar.** Se a config ou o servidor mudaram
   enquanto estava pausado, a retomada falha, grava `capabilityBlock` e nao
   mexe em nada.
2. **Nao retoma com parada pendente** (`stopPromiseEpoch === stopEpoch`). Sem
   isso a acao que o `stop` ia interromper poderia terminar depois da retomada.

**Promessa antiga nao sobrescreve episodio novo.** `performStop(reason, epoch)`
recebe a epoca e so' escreve `stopOutcome`/`interruption`/`interruptState` se
`epoch === this.stopEpoch`. Uma promessa em voo de um episodio encerrado termina
normalmente para quem a espera, mas nao contamina o registro atual.

**Deduplicacao preservada no mesmo episodio.** `requestStop()` so' reaproveita
`stopPromise` quando a epoca bate; `stopOutcome` continua impedindo a segunda
tentativa dentro do episodio. `pause`/`close`/`erro` continuam compartilhando
uma unica parada.

**Bloqueio apos capability-lost preservado.** `capabilityBlock` continua
barrando `togglePause`; reaparecimento de capacidade nao autoriza retomada.

**ACK != parada fisica.** `physicalProof: false` em todos os caminhos,
inalterado.

**Testes (4 novos, 42 -> 46):**

| exigencia | teste |
| :--- | :--- |
| um stop por pausa, dois no total | "each explicit resume starts a new stop episode (one stop per pause)" |
| retomada com stop pendente | "resume is refused while a stop is still pending" |
| retomada com capacidade incompativel | "resume revalidates capabilities before restarting" |
| promessa antiga nao sobrescreve | "a stale stop promise does not overwrite the new episode record" |

O teste principal cobre os 5 passos pedidos: despacha movimento, pausa (1 stop),
retoma e despacha de novo, pausa (2 stops), fecha ainda pausado (continua 2).

**Mutacao obrigatoria** — remover `beginStopEpisode()` do `togglePause`:

```
not ok 43 - each explicit resume starts a new stop episode (one stop per pause)
  error: 'segunda pausa precisa enviar stop novo'
         1 !== 2
# tests 46 / pass 45 / fail 1
```

Falha pelo motivo exato do bug: a segunda pausa devolveu o ACK antigo sem
enviar `stop`. Restaurado: 46/46.

**Dois defeitos de teste corrigidos no caminho** (nao eram de producao): o teste
principal reusava telemetria estatica sem avancar `tick`/relogio, e o do
episodio obsoleto tentava renovar via `setModules`, que pausa antes e travava
esperando a promessa pendente. O segundo agora exercita `performStop` com epoca
explicita, que e' o mecanismo real da guarda.

### Limites

- Nenhum efeito fisico medido; `physicalProof` continua `false`.
- Uma tentativa por episodio, sem retentativa.
- Testes vizinhos: 193 passando (capabilities, local_runtime, capture_runtime,
  healer, transport, engines, combat_fields, hunt, hunt_daemon).