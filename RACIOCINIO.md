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