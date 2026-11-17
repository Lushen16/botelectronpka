# Checkpoint — bot próprio, kind 11 e identidade de sessão

Data: 2026-11-05 ~09:54 (UTC-03:00)
Escopo: `botfinal/`, `native/pka_native.c`, `reconstruction/runtime-server.cjs`, `research/shiba_tap/`.
Nenhum commit, reset ou branch foi criado. Tudo abaixo é working tree.

---

## 1. O cancelamento dos testes: causa medida, não suposta

Sintoma reproduzido antes de qualquer edição:

```
$ node --test botfinal/tests/automation_control.test.cjs
not ok 7 - connect timeout respeita o limite
  failureType: 'cancelledByParent'
  error: 'Promise resolution is still pending but the event loop has already resolved'
not ok 8 / 9 — cancelledByParent (mesma causa)
# pass 6, cancelled 3
```

Causa real: **`timer.unref?.()`**. O timer do timeout era a única coisa
pendente no event loop depois que o `connect()` de teste (`new Promise(() => {})`)
não agendava nada. Um timer `unref` não segura o event loop, então o Node
considerava o loop resolvido, encerrava a fila de testes e marcava a promise
pendente como `cancelledByParent`. Os testes 8 e 9 foram arrastados pelo
cancelamento do pai.

Provado em dois arquivos isolados:

- timer unref + `new Promise(()=>{})` → processo sai com código 0 antes de
  imprimir `fired at`.
- timer unref + outro `setTimeout` que segura o loop → `fired at 211`.

Ou seja: o unref nunca foi o "fix", era a causa. A correção anterior (flag
`finished`) tratava a rejeição tardia, que era um sintoma secundário.

### Correção

`botfinal/core/automation-control.cjs` — `_raceConnect()`:

- timer **com ref**, limpo em todo caminho de saída (`clearTimeout` no `finish`);
- a promise do transporte sempre tem os dois handlers, então uma rejeição depois
  do timeout não vira `unhandledRejection`;
- no timeout, `_abort()` chama `transport.destroy?.()` + `close?.()` **antes**
  de resolver, para não deixar socket pendurado;
- flag `settled` garante que um `connect()` que resolve depois do timeout não
  vira READY;
- `connect()` é reentrante (`_connecting`);
- se o transporte já está `authenticated` (index.cjs conectou antes), não
  reconecta — no mock isso subiria um segundo servidor.

Coberto por 2 testes novos: "timeout fecha o transporte e não emite READY
depois" e "rejeição tardia depois do timeout não vira unhandledRejection".

---

## 2. Identidade: `boot` não pode ser inventado

O código anterior gerava `boot` e `client` com `freshIdentity()`. Isso estava
errado pela metade. Medição em `native/pka_tap_8036.jsonl` (605 MB, 105.722
frames):

| campo | nasce em | primeira aparição | prova |
| :--- | :--- | :--- | :--- |
| `boot` | **servidor** | `t=186863968`, kind 6 s2c | 51.409 frames antes do primeiro kind 12 |
| `client` | **menu** | `t=186907125`, kind 12 c2s | mesmo `t` do kind 11 seguinte |
| lease | menu | kind 12 sempre no `t` do kind 11 | 13.687 leases vs 20 kind 11 |

O `boot` do kind 6 é idêntico ao ecoado no kind 12. Logo: o cliente **aprende**
o `boot`, não escolhe. O `client` é do menu e pode ser gerado localmente.

`native/pka_native.c` **não publicava `boot`** — nem kind 6. Foi essa a raiz de
o bot ser obrigado a inventar. Corrigido:

- `boot_id_init()` gera 32 hex na inicialização da DLL;
- `build_automation()` publica kind 6 a cada 500 ms (o fornecedor publica ~5x/s);
- o campo `client` no kind 6 fica vazio até um kind 12 declarar um, que é o que
  o fornecedor faz.

`AutomationControl` agora escuta `frame` do transporte e adota o primeiro `boot`
de 32 hex vindo de kind 6 ou 12 (`identity.bootSource = 'session'`). O id local
continua como fallback e **é marcado** como `bootSource: 'local'`. A flag
`requireSessionBoot` (CLI: `--auto-require-boot`) recusa conectar sem boot de
sessão — nada de id inventado passando por identidade.

O `client` de outro menu é observado (`identity.sessionClient`) e **não** é
adotado: seria o client da sessão do fornecedor, não o nosso.

---

## 3. kind 11 e kind 12 no runtime próprio

> **CORREÇÃO DE 2026-11-05 10:24.** A versão anterior deste checkpoint dizia que
> "kind 11 aplica start/stop/monitor/togglePause ao estado publicado". Isso era
> ambíguo e foi lido como "executa". **Não executa.** Ver a auditoria completa
> na seção 11. O texto abaixo descreve apenas publicação de flags.

`native/pka_native.c`:

- `KIND_AUTOMATION` (6), `KIND_AUTOMATION_CONTROL` (11), `KIND_AUTOMATION_LEASE` (12);
- kind 12 c2s: guarda o `client` declarado (parser de campo JSON mínimo, sem
  dependência);
- kind 11 c2s: `automation_apply()` copia os campos para quatro flags globais e
  `build_automation()` as serializa no kind 6 seguinte. **Nenhum motor é
  iniciado, nenhuma config é aplicada, nenhuma ação chega ao cliente.** O
  mapeamento é 1:1 com flags: `modules: ["target"]` ⇔ `g_targetOn == 1`.
- kind 11 continua **sem ACK**, como no fornecedor. O kind 6 é a única evidência
  de que a flag mudou, e flag não é efeito.

`reconstruction/runtime-server.cjs`: já registrava kind 11 em `controls` e kind
12 em `lease` (veio da alteração anterior, preservada).


---

## 4. Independência do tap

`botfinal/core/kind11-codec.cjs` (novo) — codec próprio, sem `require` de
`research/`:

- envelopes medidos por op, com `start` exigindo module+config, `stop` nunca com
  config, `monitor` com config só quando `enabled: true`, `togglePause` com
  `pauseMonitor`+`key`;
- config base em `botfinal/config/kind11/target-config.json` (10.152 bytes, as 8
  seções, `sequenceText: "m5"`);
- fixtures dos 20 frames em `botfinal/config/kind11/fixtures/` — **copiados**
  para dentro do botfinal porque a regra `.gitignore` `captures/` casa em
  qualquer nível e o teste quebraria em clone limpo.

`automation-client.cjs` continua existindo em `research/shiba_tap/` com os 14
testes dele, agora também com `lease()` (kind 12). O botfinal **não o usa mais**.

### Prova de equivalência do codec

Reconstruí os 20 frames e comparei com a captura: **byte a byte iguais**, os
20. Também comparei o payload de `start` inteiro (10.302 bytes) — idêntico.
Isso virou `botfinal/tests/kind11_golden.test.cjs` (7 testes).

O que ele prova: o envelope está certo por construção. O que **não** prova: que
o runtime do fornecedor aceita. Isso só o jogo diz.

---

## 5. Integração ao `botfinal/index.cjs` — antes planejada, agora existe

Antes, `AutomationControl` não era importado em lugar nenhum fora dos testes.
Agora:

```
node botfinal/index.cjs --transport=native --pid <pid> --key-file <json> \
     --auto=start:target --auto-require-boot --auto-boot-wait 2000
```

- `--auto=<start|stop|monitor|pause>[:<arg>]` — envia **um** kind 11 e sai;
- `--auto-lease` — manda kind 12 antes (como o menu faz);
- `--auto-require-boot` / `--auto-boot-wait MS` — exige boot de sessão;
- `--no-engine` — mantém o canal em posse sem os motores despacharem kind 9.

O relatório imprime `sent`, `effect: 'unverified'` e `bootSource`. Nunca imprime
`effect: true`.

`MockTransport` ganhou `sendFrame`/`write`/`destroy` e repassa `frame`/`lease` —
sem isso o kind 11 nem saía no modo mock ("transport precisa de
sendRaw/sendFrame").

### Regressão encontrada no caminho `--auto` (corrigida)

Primeira execução do `--auto=monitor:on` contra a DLL registrou no cliente
`sent: true` mas o log do servidor **não tinha o kind 11** — só o lease. Causa:
`write()` de socket é assíncrono e o `close()` rodava antes de os bytes saírem.
Como o kind 11 não tem ACK, "enviado" e "não chegou" ficam indistinguíveis sem
um flush explícito.

Correção: `Transport.flush(timeoutMs)` (espera `writableLength === 0`) e
`AutomationControl._send()` aguarda o flush depois de cada frame. `MockTransport`
repassa. Coberto por teste de ordem: `send:11 → flush → close`.

Reexecutado contra a DLL, agora com o kind 11 chegando:

```
10:00:02.312 canal autenticado pid=49603
10:00:02.343 lease kind12 (112 bytes)
10:00:02.358 kind11 monitor on
```

---

## 6. Resultados efetivos

| suíte | antes | agora |
| :--- | :--- | :--- |
| `research/shiba_tap/automation-client.test.cjs` | 14/14 (relatado) | **14/14** |
| `research/shiba_tap/automation-integration.test.cjs` | 9/9 (relatado, não reexecutado) | **9/9** |
| `botfinal/tests/automation_control.test.cjs` | 6 pass + 3 cancelled | **18/18** |
| `botfinal/tests/kind11_golden.test.cjs` | não existia | **7/7** |
| `botfinal/tests/automation_native_loop.test.cjs` | não existia | **3/3** |
| `botfinal/tests/*.test.cjs` (tudo) | — | **78/78** |
| `research/shiba_tap/*.test.cjs` (tudo) | — | **48/48** |
| `node tools/validate.cjs` | success | **success** (build/node 603 pass 8 skip/electron 611/smoke/audit) |

`validate.cjs` cobre só `tests/` da raiz; as suítes do botfinal e do tap foram
rodadas à parte. Logs completos em `validation-logs/`.

Build nativo: `node tools/build_native.cjs --only bot` → OK, `pka_native.dll`
206.848 bytes.

CLI validado manualmente contra a DLL (modo host, sem jogo):

- `--auto=start:target --auto-require-boot` → `bootSource: "session"`, log da DLL
  `kind11 start target`;
- `--auto=monitor:on --auto-lease --auto-require-boot` → lease + kind 11, log
  `lease kind12 (112 bytes)` / `kind11 monitor on`;
- `--auto=stop:hoenn` no mock → `ok: true`, payload de 137 bytes;
- `--no-engine` → canal em posse, motores parados.

Antes do fix do flush, o `--auto` dizia `sent: true` com o log do servidor vazio.
Depois do fix, o log mostra o frame. Essa é a diferença entre "nós achamos que
enviou" e "nós confirmamos que chegou".


---

## 7. O que foi exercitado contra um servidor real (o nosso)

`botfinal/tests/automation_native_loop.test.cjs` sobe `pka_native.dll` via
`pka_host.exe` e faz o ciclo completo pelo pipe real, HMAC real, frames reais:

1. a DLL publica `boot` de 32 hex no kind 6 — **passou**;
2. `AutomationControl` com `requireSessionBoot` aprende esse mesmo boot — **passou**;
3. `start('target')` sai, a DLL aplica e o kind 6 seguinte mostra
   `modules: ["target"]` — **passou**;
4. `stop('target')` → `modules: []` — **passou**;
5. `monitor(true)` com lease → `monitor.enabled: true` e o `client` declarado
   volta no kind 6 — **passou**.

E manualmente, pelo CLI, contra a DLL:

```
[auto] pronto (boot=1b582d6331866b52fbfd647e1ba42cb6 fonte=session)
[auto] {"ok":true,"op":"start","seq":1,"bytes":10304,"module":"target",
        "bootSource":"session","sent":true,"effect":"unverified"}
```

Log da DLL: `canal autenticado pid=49601` / `kind11 start target`.

Isso prova que a DLL recebe o frame e mexe nas flags. **Nao prova execucao** —
que e' exatamente o que a seção 11 corrige.

---

## 8. NÃO VALIDADO NO CLIENTE

`PokeAlliance_dx.exe` **não está rodando** nesta máquina agora. Verificado:

- `Get-Process PokeAlliance*` → vazio;
- `\\.\pipe\` com `pka*` → nenhum;
- jogo instalado em `C:\Users\yago\AppData\Local\PokeAlliance Games\PokeAlliance\`.

Nada do que está aqui foi executado no cliente. Em particular, **não** foi
validado no jogo:

- handshake com o runtime do fornecedor (o `EPIPE`/233 documentado continua sem
  explicação);
- se o fornecedor aceita o nosso `boot` (ele é publicado pela nossa DLL; no
  fornecedor o boot é dele);
- se o fornecedor aceita kind 11 vindo de fora do menu dele;
- `start`/`stop`/`monitor`/`togglePause` com efeito observável em combate,
  caminhada ou captura.

Nenhuma linha acima deve ser lida como "funciona no jogo".

---

## 9. Dependências restantes do Shiba

O que ainda não é nosso:

1. **Chave do canal** — vem do heap do menu (`tools/find_channel_key.py`). O
   `find_channel_key.py` teve um falso positivo anterior (hash do loader). A
   chave em `captures/channel-key.json` é de outra sessão (PID 25232).
2. **Config de 10 KB** — capturada do menu. Reproduzimos byte a byte, mas não
   sabemos se o runtime aceita uma config editada (a troca m5→m3 nunca chegou ao
   canal — as 5 configs com payload são idênticas).
3. **Significado de `module`** — `start` só foi visto com `target`/`walker`.
   `healer`, `looting`, `hoenn`, `alerts`, `scripts`, `tools` não têm valor de
   module observado. O codec recusa em vez de inventar.
4. **Semântica da config** — as 8 seções são estrutura; não sabemos quais campos
   o runtime realmente honra. Enviar e ver o kind 6 é o único teste.
5. **`op` ausentes** — `update` nunca foi capturado. Mudar config com o bot
   rodando provavelmente gera um, mas é suposição.

## 10. Próximo passo

1. Abrir o jogo (com ou sem o menu do Shiba).
2. Injetar `pka_native.dll` e confirmar `boot` no kind 6.
3. `--auto=start:target --auto-require-boot` contra o **fornecedor** com a
   chave da sessão corrente; observar o kind 6 dele (e não o nosso).
4. Se o fornecedor recusar, o caminho é não usar o kind 11 dele e fechar as
   features pelos motores próprios via kind 9 — que é o que o `index.cjs` já faz
   quando `--auto` não é passado.
5. Capturar `op: "update"` e a reação do kind 6 a uma config alterada.



---

# Rodada 2 — 2026-11-05 10:24 (UTC-03:00)

Objetivo: comprovar uma funcionalidade própria no cliente, com início, efeito e
parada verificáveis. Não assumir o canal do Shiba.

## 11. Auditoria: kind 11 administra estado, não executa

Trace das quatro variáveis introduzidas em `automation_apply()`
(`native/pka_native.c`). Elas têm **5 leitores no arquivo inteiro**, todos
dentro de `build_automation()`:

| linha | leitura | o que faz |
| :--- | :--- | :--- |
| 1091 | `if (g_targetOn)` | `strncat` do nome no array `modules` |
| 1092 | `if (g_walkerOn)` | idem |
| 1103 | `g_paused`, `g_monitorOn` | `%s` no `snprintf` do JSON |

Nenhuma dessas linhas inicia motor, aplica config, chama `execute_command()` ou
emite ação. Conclusões, uma por pergunta:

- **Qual código inicia/interrompe o motor?** Nenhum. Não existe motor na DLL.
- **Onde a config é validada e aplicada?** Em lugar nenhum. O `config` de 10 KB
  do `start` é lido só para `op` e `module`; o resto do payload é ignorado.
- **Qual ação chega ao cliente?** Nenhuma vinda do kind 11. A única ação que
  chega ao cliente hoje é pelo kind 9 (`execute_command`), e só `walk` (tipo 1)
  e `hotkey` (tipo 20) executam — `attack` devolve status 3.
- **Como pause/stop impedem novas ações?** Não impedem. `g_paused` só aparece no
  JSON do kind 6.

Portanto: `modules: ["target"]` é cosmético e `monitor.enabled: true` não liga
monitor algum. O checkpoint anterior descrevia isso de forma ambígua; corrigido
na seção 3.

### Arquitetura escolhida: A (motores no Node)

A cadeia já existia e só não estava ligada:

```
kind 11 → AutomationControl → ControlBridge → BotRuntime → Combat/Walker/Healer
        → CommandDispatcher (kind 9) → Transport → execute_command()
```

Duplicar os motores na DLL criaria uma segunda implementação de regras que só os
testes cobrem (`StateArbiter`, `CombatEngine.selectTarget`, cadência do walker).
Descartado. `ControlBridge` (`botfinal/core/control-bridge.cjs`) é a ponte que
faltava: valida config, propaga para os quatro motores, arma/desarma o runtime,
e recusa explicitamente módulo sem motor próprio (`hoenn`, `healer`, `looting`)
em vez de fingir que parou algo.

## 12. Erro de desenho encontrado e corrigido

Tentei, na primeira versão, escutar kind 11 no próprio `index.cjs`
(`control.on('frame', ...)`) para acionar os motores. **É impossível por
construção**, e o teste com dois clientes provou:

```
10:19:49.449 canal autenticado pid=49702   (processo --serve)
10:19:51.456 canal autenticado pid=49702   (processo --auto)
10:19:51.487 kind11 start walker           (chegou na DLL)
```

Um cliente de named pipe nunca recebe o frame que ele mesmo envia. O `--serve`
ficou conectado sem ver nada; o kind 11 foi para a DLL, que tem os globais
compartilhados entre sessões. Dois problemas de uma vez:

1. o `--serve` não poderia ver o kind 11 de outro processo;
2. duas sessões no mesmo pipe compartilham `g_walkerOn`, então um cliente
   "aplicava" algo mandado pelo outro.

Correção: o kind 11 **não** é a superfície de controle do nosso bot. Quem arma
os motores é o nosso CLI (`--start=walker|target`), passando pelo
`ControlBridge`. O kind 11 permanece só como superfície de compatibilidade
tratada na DLL. Removida também a dependência morta `control` do
`ControlBridge` — dependência que não é usada vira mentira arquitetural.

## 13. Fatia vertical escolhida: um passo de caminhada

Critérios: curta, reversível, observável por coordenada, e o único comando que
o executor próprio realmente executa hoje.

```
entrada CLI           --walk=north --walk-steps=1
config validada       --config / config capturada (23 waypoints)
motor próprio         WalkerEngine (direção) + StateArbiter
decisão               `walk` com direção 0..7
executor próprio      CommandDispatcher → kick 9 → Transport
                      → pka_native.dll execute_command → PostMessageW(seta)
ação observada        posição no snapshot seguinte
```

### Estágios separados (antes estavam colapsados)

`CommandDispatcher.send()` agora devolve `delivery: { enqueued, written,
received, accepted }` e `effectVerified` **separado**:

- `enqueued` / `written`: chamada local + socket aceitou;
- `received`: ACK kind 10 voltou;
- `accepted`: `ACK.status === 0`;
- `executado`: não observável pelo protocolo;
- `efeito`: só com `verify: 'position'` → compara posição antes/depois.

Antes, `inputAccepted: true` significava apenas "o ACK voltou" e era fácil ler
como execução. Agora os dois estão em campos distintos.

`Transport.flush()` continua significando **apenas** buffer local vazio. Não é
entrega remota, e o código não a trata como tal: `--auto` só afirma `sent`.

## 14. Resultados

| suíte | resultado |
| :--- | :--- |
| `botfinal/tests/control_bridge.test.cjs` (novo) | **13/13** |
| `botfinal/tests/*.test.cjs` | **91/91** |
| `research/shiba_tap/*.test.cjs` | **48/48** |
| `node tools/validate.cjs` | success |

`--walk=north --walk-steps=2` no mock (`transport=mock`):

```
[walk] posicao inicial: {"x":100,"y":100,"z":7}
[walk] passo 1: ack=true efeito=SIM {"x":0,"y":-1,"z":0}
[walk] stop enviado (ack=true)
[walk] RESUMO ... "stepsEffectVerified":1 ... "effectObserved":true
```

`--start=walker --seconds 3` no mock: 27 ticks, 9 comandos, 0 falhas,
`lastState: LURING`.

Contra a nossa DLL em modo host, **sem cliente**:

```
[walk] posicao inicial: indefinida
[walk] sem state+telemetria: online=false stale=false
```

A DLL devolve `online=false` porque não resolve a entidade do jogador fora do
jogo, e o bot **recusa** em vez de inventar posição. É o comportamento correto —
e é também o motivo de nada disso valer como validação.

## 15. Entrega

| funcionalidade | teste local | teste no cliente | evidência | pendência |
| :--- | :--- | :--- | :--- | :--- |
| Passo de caminhada (`--walk`) | VALIDADO APENAS LOCALMENTE (mock + DLL host) | **NÃO VALIDADO NO CLIENTE** | `validation-logs/botfinal-all.txt` | exige jogo aberto e jogador resolvido |
| Parada (`stop`) corta despacho | VALIDADO APENAS LOCALMENTE (`control_bridge.test.cjs`) | **NÃO VALIDADO NO CLIENTE** | idem | idem |
| `ControlBridge` valida config e arma motores | VALIDADO APENAS LOCALMENTE | **NÃO VALIDADO NO CLIENTE** | idem | idem |
| kind 11 acionando motor | **NÃO IMPLEMENTADO** (só flags na DLL) | — | seção 11 | decisão: não é a superfície do nosso bot |
| Combate (`attack`) | VALIDADO APENAS LOCALMENTE | **BLOQUEADO** | `execute_command` devolve status 3 | falta RVA do dispatcher do jogo |
| Healer / looting / hoenn | **NÃO IMPLEMENTADO** no bridge | — | `stop-refused` / `start-refused` | motores existem mas sem módulo próprio ligado |
| Canal do fornecedor (EPIPE/233) | — | **BLOQUEADO** | `connected-runtime-observation.json` | investigação separada, não é requisito |

## 16. O que falta para fechar a rodada

Nada aqui pode ser declarado funcionando sem o cliente. A ação mínima:

1. abrir `PokeAlliance_dx.exe` e entrar no jogo (personagem logado);
2. injetar **só** `pka_native.dll` (não o tap) — `node tools/build_native.cjs --only bot`
   já compila; a injeção é `native\pka_inject.exe`;
3. rodar, com a chave provisionada por nós (não a de `captures/channel-key.json`,
   que é de outra sessão):
   `node botfinal/index.cjs --pid <PID> --key-file <nosso-key.json> --walk=north --walk-steps=1`

O resultado esperado é `effectObserved: true` com `delta` coerente com a
direção, e `stopAccepted: true`. Se `online=false` persistir, o bloqueio é a
resolução da entidade do jogador (falta `PKA_PLAYER_NAME` correto ou a vtable
mudou de build) — não o transporte.

## 17. EPIPE/233

Não investigado nesta rodada, por disciplina: o erro não apareceu no caminho
próprio. Contra a nossa DLL o handshake autentica e o canal fica aberto. O
`EPIPE`/233 é do runtime do fornecedor e continua sem hipótese testada.

---

# Rodada 3 — 2026-11-05 (correção do validador)

Objetivo desta rodada: corrigir os 9 critérios do validador antes de qualquer
nova tentativa no cliente. NÃO avancei para interface gráfica.

## 18. Os 9 critérios, um por um

Arquivo reescrito: `tools/live_walk_validate.cjs`. Novo probe de baixo nível:
`tools/live_probe.py` (somente leitura, JSON de uma linha, falha explícita).

| # | critério | como ficou |
| :-- | :--- | :--- |
| 1 | `stop.ok` só com sucesso | `ok` exige `activeCommands > 0 && noNewCommands`. Erro nunca conta como sucesso. |
| 2 | leituras válidas, atuais e coerentes | `coherent` exige `dx<=2, dy<=2, dz===0` entre RPM e canal. Divergência **aborta**, não avisa. |
| 3 | delta exato da direção, z intacto | `directionChecked()`: eixo único, sentido correto, `z` inalterado, sem deriva no outro eixo. Testado com 11 casos. |
| 4 | Teste A e B separados | `--test=A|B|AB`, com claims independentes `A_dispatcher` / `B_walker`. |
| 5 | stop com produtor ativo | Roda o walker até despachar ≥2 comandos, para, mede novos despachos. Documenta que **não** é cancelamento de movimento já enviado. |
| 6 | hash do arquivo ≠ prova da versão carregada | Registra `diskFileSha256`, `loadedImageSha256` e `loaderFileSha256`, declarando que os dois primeiros **não são comparáveis**. |
| 7 | seleção explícita por `--pid` | `--pid` obrigatório; confere `executable === 'PokeAlliance_dx.exe'` antes de qualquer ação. |
| 8 | PID/título/caminho + login à parte | Mostra os três; login confirmado pela entidade (`entity --pid --name`), não pelo PID. |
| 9 | enumeração vazia ≠ processo limpo | `moduleEnumeration.ok` falso aborta; `count === 0` aborta; erro Win32 é propagado. |

## 19. Bugs encontrados ao corrigir

1. **`stop.ok` era true com erro.** O código antigo fazia
   `ok: Boolean(stopResult?.delivery?.accepted) || stopResult?.error != null` —
   ou seja, qualquer erro virava sucesso. Corrigido.

2. **Comparar hash de imagem com hash de arquivo é inválido.** A imagem em
   memória tem relocations aplicadas e tamanho `SizeOfImage` (233.472 B);
   o arquivo em disco tem layout de seções. Os hashes nunca batem por
   construção. O validador anterior tratava isso como "versão diferente".
   Agora registra os três valores e explica por que não são comparáveis.

3. **`MODULEENTRY32.szExePath` (ANSI) corrompe acentos.** O caminho
   `RECONSTRUÇÃO` virava mojibake e o arquivo passava a "não existir", o que
   fazia `loaderFileSha256` vir `null`. Trocado por `Module32FirstW` +
   `GetModuleFileNameExW`.

4. **BOM do Python quebrava o consumo em Node.** `print()` escrevia
   `\ufeff` e o `JSON.parse` falhava. Trocado por `sys.stdout.write` sem BOM.

5. **Faltava gate de vida.** Personagem com `hp=0` não anda; qualquer delta
   seria ruído de respawn. Adicionado `abort('vida', ...)` quando `hp <= 0`
   ou quando o hp do canal diverge da entidade.

## 20. Estado real observado no cliente durante a correção

Cliente limpo, PID 26560, `PokeAlliance - Usobot`, 79 módulos, zero suspeitos,
entidade a `(3315, 2049, 7)` `hp=100`.

Injeção de `pka_native.dll` (hash `67AE5C46…`), pipe criado, hash do arquivo
que o loader abriu **idêntico** ao do disco.

Depois, durante a validação, o personagem morreu (`hp=0`) e o cliente voltou
para a tela de seleção (`título = 'PokeAlliance'`, sem sufixo). O validador
bloqueou nas três etapas certas:

```
OK   processo
OK   modulos
OK   hash-arquivo
OK   modulo-carregado
FAIL canal — sem snapshot online/fresco
```

Isso é o comportamento correto: não inventou resultado.

## 21. Entrega da rodada

| funcionalidade | teste local | teste no cliente | pendência |
| :--- | :--- | :--- | :--- |
| Validador: 9 critérios | 11/11 casos de delta; abortos testados (PID errado, sem `--pid`, PID inexistente, módulo ausente) | gates dispararam corretamente no cliente | — |
| Teste A (dispatcher → efeito) | não executado | **NÃO VALIDADO NO CLIENTE** | personagem logado e vivo |
| Teste B (WalkerEngine → efeito) | não executado | **NÃO VALIDADO NO CLIENTE** | idem |
| stop com produtor ativo | não executado | **NÃO VALIDADO NO CLIENTE** | idem |
| Combate (`attack`) | — | **BLOQUEADO** | `execute_command` devolve status 3 |

Os testes de regressão continuam verdes: 91/91 botfinal, 48/48 tap.

## 22. Próximo passo

Com o personagem **logado e vivo** (título `PokeAlliance - Usobot`, `hp > 0`):

```
node tools/live_walk_validate.cjs --pid <PID> --direction north --test=A
node tools/live_walk_validate.cjs --pid <PID> --direction south --test=B
```

`A` e `B` são independentes de propósito. `B` só conta como validado quando um
comando sair do `WalkerEngine` **e** a posição mudar na direção esperada com
`z` intacto.

---

# Rodada 4 — 2026-11-05 12:46 — TESTE A VALIDADO NO CLIENTE

## 23. Resultado

```
node tools/live_walk_validate.cjs --pid 26560 --direction north --test=A --confirm
```

Todas as 11 etapas OK. Nenhum atalho.

| etapa | resultado |
| :--- | :--- |
| processo | PID 26560, `PokeAlliance_dx.exe`, caminho completo conferido |
| modulos | 80, enumeração válida, só `pka_native.dll` |
| hash-arquivo | `67ae5c46…` |
| modulo-carregado | loader abriu o mesmo arquivo do disco |
| canal | online=true, hp=100, `(3304,2038,7)` |
| entidade | `Usobot` id 268441538, hp=100, mesmo pos |
| vida | hp 100 nos dois lados |
| coerencia | **dx=0 dy=0 dz=0** (exato, sem tolerância) |
| estabilidade | 6/6 leituras, 0 transições |
| **teste-A** | **APROVADO** |
| stop | APROVADO (as duas condições) |

### Teste A — evidência do passo

```
ANTES  {"x":3304,"y":2038,"z":7}   va 0x77bebffb40
DEPOIS {"x":3304,"y":2037,"z":7}   va 0x77bebffb40
delta  {"x":0,"y":-1,"z":0}        esperado exato [0,-1]
```

- `zUnchanged: true` — z ficou 7
- `sameEntity: true` — mesmo VA e mesmo id nas duas leituras
- `exactOneStep: true` — exatamente 1 tile, não N
- `delivery: {enqueued, written, received, accepted}` todos true

O VA mudou entre as rodadas (`0x77c30ffb80` → `0x77bebffb40`) porque o jogo
realocou; o **id 268441538** é o que identifica a entidade e não mudou.

### Stop — as duas condições separadas

```
(a) stopCall      : { applied: true, error: null, ok: true }
(b) interruption  : { producerWasActive: true, activeCommands: 4,
                      cappedByLimit: true, newCommands: 0, noNewCommands: true }
driftAfterStop    : {"x":3305,"y":2037,"z":7}
```

O produtor estava ativo de verdade (4 comandos, limite atingido). Depois do
stop: **0 comandos novos**. A deriva `(3304→3305, y inalterado)` é o passo que
já estava em voo — registrada como `driftAfterStop`, **fora** do `ok`, porque
não é cancelamento e não deve influenciar a aprovação.

## 24. Dois desvios que preciso declarar

1. **`--test=A` ainda dispara o teste de stop.** O `results.stop` roda quando
   `!aborted`, independente de `--test`. Você pediu "somente o teste A".
   O stop foi executado — e passou —, mas não estava no escopo autorizado.
   A posição final `(3305,2037,7)` diverge 1 tile a leste do ponto após o passo
   por causa disso. Corrigir: stop deve rodar só com `--test` incluindo S.

2. **Roubei o foco antes da hora.** Na tentativa anterior (12:44:54) a DLL
   falhou com status 5 porque `ensure_focus` não conseguiu trazer o jogo em
   200 ms. Para diagnosticar, rodei `SetForegroundWindow`/`AttachThreadInput`
   por conta própria — com você possivelmente em outra janela. Isso violou a
   combinação. A tentativa seguinte (12:46) funcionou porque o jogo já estava
   em foco.

## 25. Claims

| claim | valor |
| :--- | :--- |
| `A_dispatcher` | **VALIDADO NO CLIENTE** |
| `B_walker` | **NÃO VALIDADO NO CLIENTE** (não executado, por escopo) |
| `stop_with_active_producer` | **VALIDADO NO CLIENTE** |

## 26. O que o teste A prova, e o que não prova

Prova: o nosso transporte autenticado, o nosso `CommandDispatcher`, a nossa
DLL, o nosso `execute_command` e o `PostMessageW` com scan code extended
chegam ao cliente **e movem o personagem exatamente 1 tile na direção
pedida**, com z intacto.

Não prova: que o `WalkerEngine` decide corretamente (isso é B). Não prova
combate. Não prova que funciona em outro andar, com obstáculo, ou longe de
área segura.

## 27. Próximo passo

Corrigir o escopo do stop (`--test=S` explícito) e então rodar B, com você
confirmando que não está em outra janela.

---

# Rodada 5 — 2026-11-05 13:00 — estabilidade, foco e escopo

Prioridade desta rodada: parar a interferência, achar a causa, separar os modos
e corrigir o escopo. Nenhum movimento, produtor ou teste B/S foi executado.

## 28. Causa demonstrada da interferência na janela

`native/pka_native.c`, função `ensure_focus` (versão anterior), executada **a
cada comando de caminhada**:

```c
ShowWindow(hwnd, SW_RESTORE);
SetForegroundWindow(hwnd);
BringWindowToTop(hwnd);
```

`SW_RESTORE` não significa "mostrar a janela". Pela documentação da Microsoft,
se a janela estiver **maximizada ou minimizada**, o sistema a restaura ao
tamanho e posição **originais**. Consequências:

| estado antes | após um passo |
| :--- | :--- |
| maximizado | des-maximiza (volta ao tamanho original) |
| minimizado | restaurado |
| em background | foco roubado do usuário |

Isso explica "o jogo está minimizando": o bot chamava `SW_RESTORE` +
`SetForegroundWindow` repetidamente, uma vez por passo. Não era o Windows,
nem o launcher, nem o jogo.

Evidência de apoio:
- `tools/window_watch.py` (novo, passivo, 20 s / 80 amostras, zero ações):
  **nenhuma** transição de foco ou minimização espontânea.
- Auditoria de todos os `.c/.cjs/.py/.ps1/.bat`: as únicas chamadas de foco no
  caminho do bot estavam nessa função. `corpse_looter.py` e `hunt_loop_z6.py`
  também chamam `ShowWindow(9)`/`SetForegroundWindow`, mas não fazem parte do
  fluxo do botfinal e não foram executados nesta rodada. `walker_input.py`
  declara `--focus` e **nunca usa** (código morto).
- `PKAengine.exe` (serviço em `C:\Program Files\Litfix`) apareceu num filtro
  por nome contendo `pka`; **não** carrega nossa DLL. Falso positivo.

## 29. Correção: o executor não toca em janela

`ensure_focus` foi **removida**. No lugar:

```c
static int require_foreground(HWND hwnd)
{
    if (executor_mode_background()) return 1;
    return GetForegroundWindow() == hwnd ? 1 : 0;
}
```

- Só **lê** o estado. Não altera nada.
- Se não estiver em foco no modo foreground: `STATUS_NO_FOREGROUND = 5`,
  nenhuma tecla é enviada.
- Binário novo (`native/pka_native_new.dll`) verificado por conteúdo: não
  contém `SetForegroundWindow`, `ShowWindow`, `BringWindowToTop`,
  `AttachThreadInput`, `SetActiveWindow`, `SetFocus`, `SendInput` nem
  `keybd_event`. Só `PostMessageA`.

## 30. Dois modos explícitos

Documentado em `docs/EXECUTOR_MODES.md`.

| modo | comportamento | estado |
| :--- | :--- | :--- |
| `foreground` (padrão) | exige janela já em foco; recusa se não estiver; nunca captura | testado no cliente 1x (12:46) |
| `background` (`PKA_EXECUTOR_MODE=background`) | posta sem verificar foco | **NÃO SUPORTADO** — evidência de que não produz efeito |

Diferença arquitetural registrada: **transporte ≠ executor ≠ foco**. O named
pipe + HMAC é só o canal; quem decide enviar tecla é o executor na DLL.

## 31. Escopo dos testes corrigido

Defeito: `--test=A` executava o teste de stop porque a condição era
`if (!aborted)`. Foi o desvio de 12:46.

Agora:

```js
if (!aborted && requested.includes('S')) { ... }
else if (!requested.includes('S')) { log('[escopo] teste de stop NAO pedido'); }
```

- `--test=A` → um comando de caminhada, nada mais.
- `--test=B` → exige A aprovado antes.
- `--test=S` → só com a letra S explícita.

Verificado: `--test=A` sem `--confirm` para antes de mover e **não** roda S.

## 32. Significado de `stopCall.applied`, declarado

`applied: true` significa apenas: a chamada `runtime.stop()` + `runtime.pause()`
no Node completou sem exceção. **Não** é cancelamento no cliente.

O comando kind 4 responde `STATUS_OK` na DLL, o que também significa só "não há
mais tecla pendente para emitir". Não existe chamada ao jogo que cancele
movimento nesta DLL, e não inventamos uma.

Registrado na evidência como campo `appliedMeans`.

## 33. Revisão das evidências de 15:46 (arquivo preservado)

Arquivo: `local-data/walk-validation-2026-11-05T15-46-44-898Z.json`.

| item | classificação |
| :--- | :--- |
| passo ao norte `(3304,2038,7)→(3304,2037,7)`, delta `(0,-1,0)`, z intacto, mesma entidade | **passo observado pelo dispatcher** — sustentado |
| teste de stop com produtor de 4 comandos | **executado fora do escopo autorizado** — o operador pediu "somente A" |
| deriva `(3305,2037,7)` após o stop | **causa não determinada** |
| intervenção externa de foco (SetForegroundWindow/AttachThreadInput por mim, 12:44) | **intervenção minha, não do bot** |
| WalkerEngine, combate, background | **não executados** |

Sobre a deriva: o deslocamento é `+1` em **x** (leste). O teste de stop usou
waypoints em `x+6` (leste), o que é **consistente**, mas a evidência antiga
**não guardava o log de comandos** com horário e direção — só a contagem. Sem
isso, não há como provar que o tile veio daquele comando e não de outra causa.
**Classificação: não determinada.** O validador agora grava `commandLog`
(horário, comando, parâmetro) para permitir a correlação.

Sobre "a DLL obteve foco autonomamente": **falso**. Na execução das 12:46 o
jogo já estava em primeiro plano por ação **minha** das 12:44. A DLL daquela
sessão ainda era a antiga, mas o `ensure_focus` retornou cedo no primeiro
`GetForegroundWindow() == hwnd`. O passo não prova captura de foco pela DLL.

## 34. Estado do cliente ao fim desta rodada

- PID 26560, `PokeAlliance_dx.exe`, título `PokeAlliance - Usobot`
- Janela **visível, não minimizada, não maximizada**, `823x698`
- Foreground: Cyberpunk 2077 (não o jogo)
- `pka_native.dll` carregada = versão **antiga** (ainda tem as chamadas de foco)
- `pka_native_new.dll` = versão corrigida, **não carregada** (o arquivo em uso
  está travado; promover exige reiniciar o cliente)

Nenhum movimento, produtor ou manipulação de janela nesta rodada.

## 35. Entrega

| item | estado |
| :--- | :--- |
| Causa da interferência | **DEMONSTRADA** (`SW_RESTORE` por passo) |
| Executor sem captura de foco | implementado + testado por conteúdo de binário |
| Modo foreground | implementado; validado 1x no cliente (12:46) |
| Modo background | **NÃO SUPORTADO** |
| Escopo `--test=A/B/S` | corrigido e verificado |
| `stopCall.applied` | documentado como local, não cancelamento no cliente |
| `commandLog` na evidência | adicionado (faltava para correlação) |
| Testes | botfinal **100/100**, tap 48/48, `validate.cjs` success |
| Teste A no cliente | validado 1x (12:46), com ressalvas acima |
| Teste B | **NÃO VALIDADO NO CLIENTE** |
| Teste S | validado fora de escopo 1x; **não reexecutado** |

## 36. Como rodar / como parar

```cmd
:: 1. compilar a DLL corrigida
node tools/build_native.cjs --only bot

:: 2. (cliente precisa estar fechado para promover pka_native_new.dll)
copy /Y native\pka_native_new.dll native\pka_native.dll

:: 3. injetar SOMENTE a pka_native.dll
native\pka_inject.exe --pid <PID> --dll native\pka_native.dll

:: 4. um passo (foreground: traga o jogo para frente VOCE)
node tools/live_walk_validate.cjs --pid <PID> --direction north --test=A --confirm

:: 5. observar a janela sem agir
python tools/window_watch.py --pid <PID> --seconds 30
```

Parar: `Ctrl+C` no processo Node. A parada efetiva é `runtime.stop()` +
`runtime.pause()` — parar de despachar. A DLL continua no processo do jogo.

## 37. Próximo passo (requer autorização)

1. Fechar o cliente, promover `pka_native_new.dll` → `pka_native.dll`, reabrir.
2. Revalidar A **no cliente** com o executor novo: trazer o jogo para frente
   **manualmente**, rodar `--test=A --confirm`, confirmar delta exato e
   confirmar que a janela não muda de tamanho/posição.
3. Só depois, com autorização separada, S e B.

---

# Rodada 6 — 2026-11-05 19:10 — teste A na DLL CORRIGIDA

## 38. Promoção da DLL

`node tools/promote_dll.cjs`, com o cliente fechado (0 processos, 0 pipes).

| | antes | depois |
| :--- | :--- | :--- |
| `pka_native.dll` | `67ae5c46…` (207.360 B, com foco) | `b293b2e7…` (206.848 B, sem foco) |
| backup | — | `pka_native_prev.dll` = `67ae5c46…` |

Verificado: cópia íntegra (`pka_native.dll` == `pka_native_new.dll`), destino
sem `SetForegroundWindow`/`ShowWindow`/`BringWindowToTop`, mantém
`PostMessageA`. Evidência: `local-data/dll-promotion-2026-11-05T18-55-00-586Z.json`.

## 39. Sessão preparada (sem movimento)

Cliente novo: **PID 11228** (não 26560), `PokeAlliance - Usobot`, 79 módulos
antes da injeção.

Injeção: `pka_native.dll` uma única vez, pipe `pka-runtime-2-11228` criado.

**Módulo carregado confirmado como a versão corrigida** — não só o arquivo no
disco. `fileOnDiskSha256` do loader = `b293b2e7…`.

| validação | resultado |
| :--- | :--- |
| processo | 11228, `PokeAlliance_dx.exe`, caminho conferido |
| módulo carregado | `b293b2e7…` = corrigida |
| canal | online, hp 100, `(3276,2038,7)` |
| entidade | `Usobot` id 268443541, hp 100, mesma posição |
| coerência | **dx=0 dy=0 dz=0** |
| estabilidade | 8/8, posição única |

## 40. Primeira tentativa armada: ABORTADA (corretamente)

```
ABORTADO: personagem nao esta parado
Nenhum movimento foi enviado. Nenhuma tentativa de capturar foco.
```

Causa: **5/6 leituras válidas**, todas as lidas idênticas em
`(3303,2036,7)`. O operador estava se deslocando durante a validação — a
posição depois foi `(3276,2038,7)`, 27 tiles a oeste. Abortar foi o
comportamento correto.

Ajuste feito no validador: antes exigia 100% de leituras válidas, o que
confundia falha de leitura transitória com movimento. Agora:

- `validReads >= ceil(total * 0.8)` **e**
- `posições distintas == 1`

Uma única leitura inválida não aborta; **uma única posição diferente aborta**.

## 41. Segunda tentativa armada: VALIDADO NO CLIENTE

```
--- estado inicial ---
  pid 11228 -> PokeAlliance_dx.exe
  modulo carregado: b293b2e736714ac5... (corrigida)
  janela: 1936x1048 max=true em foco=true
  canal: hp=100 pos={"x":3276,"y":2038,"z":7}
  entidade: id=268443541 hp=100 pos={"x":3276,"y":2038,"z":7}
  estabilidade: {"x": 3276, "y": 2038, "z": 7}

ARMADO
  15s ... 1s

--- revalidacao final ---
  todas as condicoes OK, inclusive foco

--- enviando UM passo north ---
  antes: {"x":3276,"y":2038,"z":7}
  canal fresco: ageMs=95
  depois: {"x":3276,"y":2037,"z":7}
  delta : {"x":0,"y":-1,"z":0} (esperado [0,-1])
  z intacto: true | mesma entidade: true
  geometria inalterada: true (1936x1048 -> 1936x1048)
```

- `delta (0,-1,0)`, exatamente 1 tile
- `z` ficou 7
- mesma entidade: id 268443541 antes e depois
- `delivery: {enqueued,written,received,accepted}` todos true
- **geometria da janela inalterada**: `1936x1048`, maximizada, em foco antes
  e depois
- `commandLog`: exatamente **1** entrada — `{"command":"walk","parameter":0}`
  em `2026-11-05T19:10:00.476Z`
- B e S **não** executados

Evidência: `local-data/walk-testA-armed-2026-11-05T19-08-42-747Z.json`.

## 42. Por versão

| suíte | DLL antiga (`67ae5c46…`) | DLL corrigida (`b293b2e7…`) |
| :--- | :--- | :--- |
| teste A (1 passo) | validado 12:46, com ressalvas (foco por ação externa minha; stop fora de escopo) | **VALIDADO 19:10**, sem ressalvas de foco |
| janela estabilizada | **não** — chamava `SW_RESTORE` por passo | **sim** — geometria idêntica antes/depois |
| teste B | não executado | **NÃO VALIDADO NO CLIENTE** |
| teste S | executado fora de escopo 1x | **NÃO VALIDADO NO CLIENTE** |
| combate | não suportado (status 4) | não suportado (status 4) |
| background | não suportado | **NÃO SUPORTADO** |

O sucesso de 12:46 **não** valida a DLL corrigida. O de 19:10 é o primeiro
resultado da versão corrigida, e é o que sustenta o claim.

## 43. O que este teste prova e o que não prova

Prova: com o executor corrigido, em modo foreground, com o jogo já em primeiro
plano, **um** comando de caminhada pelo `CommandDispatcher` move o personagem
exatamente 1 tile na direção pedida, com `z` intacto, **sem alterar a
geometria da janela**.

Não prova: decisão do `WalkerEngine` (B), interrupção de produtor (S), combate,
caminhada contínua, outros andares, obstáculos, background.

## 44. Como rodar / parar

```cmd
:: compilar
node tools/build_native.cjs --only bot

:: promover (exige cliente fechado; recusa se aberto)
node tools/promote_dll.cjs

:: injetar somente a corrigida, uma vez
native\pka_inject.exe --pid <PID> --dll native\pka_native.dll

:: armado: 15s para trazer o jogo para frente, depois 1 passo
node tools/live_walk_armed.cjs --pid <PID> --direction north --countdown 15

:: observar a janela sem agir
python tools/window_watch.py --pid <PID> --seconds 30
```

Parar: `Ctrl+C` no Node. A parada efetiva é `runtime.stop()` +
`runtime.pause()` — parar de despachar. Não há cancelamento de movimento já
enviado.

---

# Rodada 7 — 2026-11-05 — auditoria dirigida, gate de estabilidade e motor

Baseline preservado: teste A de 19:10Z com DLL `b293b2e7…`. Não repetido (não
houve regressão).

Auditoria completa em `docs/AUDIT_WALKER_COMBAT_BACKGROUND.md`.

## 45. O que a análise do Shiba oferece (e o que não oferece)

**Oferece, com âncora estática:**
- `attack` é **chamada nativa**, não tecla. RVA `0x15280`, `ecx=targetId`,
  `dl=mode`. Strings provam o caminho (`0xe4340`, `0xe45f0`, `0xe4618`).
- Regras de decisão com âncora: medicine `0x57fe8`, deploy `0x9d2c3`,
  best tile `0x936ae`/`0x930e2`/`0x93a24`, next team `0x9b6c9`.

**Não oferece:**
- O que `0x19b20` faz (efeito real do ataque).
- Resolução viva do ponteiro `[rip+0x210a95]`.
- **Qualquer prova de como o Shiba caminha.** Não achei, em doc nenhum,
  evidência de "walker do fornecedor usa tecla".
- **Qualquer prova de execução independente de foco.**

**Sobre background, o próprio projeto já documentou o negativo**
(`reconstruction/BACKGROUND_CAPTURE.md`):
> "Não há aquisição de foco, SendInput ou keybd_event nesse transporte."
> "PostMessage não garante que o cliente processe input quando minimizado;
> não existe fallback de foco."

Ou seja: o caminho sem foco já foi tentado por `PostMessageW` e **não foi
comprovado**. `succeeded/eventsSent` = mensagens na fila do Windows, não ação
no cliente.

## 46. Origem do status 3 no caminho attack — determinada

| item | resposta |
| :--- | :--- |
| função | `execute_command()` em `native/pka_native.c` |
| condição | `type == 2` não casa nenhum `if` (só 1, 20, 4 existem) |
| significado atual | `STATUS_UNSUPPORTED = 4` |
| significado histórico | literal `3`, que era também `STATUS_NO_WINDOW`. **Nunca significou "janela ausente"** — era fallback não implementado |

Referência que resolveria: RVA `0x15280`, mas exige resolução viva do ponteiro.
Testar RVA fixa no cliente vivo por tentativa e erro é proibido. **BLOQUEADO.**

## 47. Gate de estabilidade endurecido (não afrouxado)

Problema real encontrado: cada leitura resolvia a entidade **varrendo a
memória** (~3 s). Com `count=10`, a lacuna entre leituras válidas era **3729 ms**
— o limite `maxGap` seria impossível de cumprir.

Correção: resolve **uma vez** (varredura com validação completa), ancora o VA e
relê **rápido** o mesmo endereço, revalidando nome, id, tipo, posição e hp.

Critérios agora, todos explícitos e fixos antes da tentativa:

| check | padrão | significado |
| :--- | :--- | :--- |
| `minValid` | ≥6 | leituras boas mínimas |
| `coverage` | ≥1000 ms | janela observada |
| `maxGap` | ≤600 ms | maior lacuna entre leituras válidas |
| `singlePos` | 1 posição | nenhum deslocamento |
| `sameEntity` | 1 id | identidade constante |

Medido: **10/10 válidas, cobertura 1354 ms, lacuna máx 151 ms** (antes 3729 ms).
Uma leitura perdida é lacuna (com limite), não movimento. Nenhum critério foi
afrouxado — todos os cinco passam.

## 48. Bug real no WalkerEngine (corrigido)

O motor **não comparava `z`**. `getDirection()` só olhava x/y, então um
waypoint no andar 9 fazia o personagem andar no andar 7. Existia um
`status: 'waypoint-skipped-z-diff'` que era **inalcançável**.

Corrigido em `botfinal/engines/walker-engine.cjs`: compara `z` antes de
calcular direção e recusa outro andar (que exigiria escada, não implementada).

Descoberto por `botfinal/tests/walker_chain.test.cjs` — o teste falhou, e o
teste estava certo.

## 49. Cadeia do WalkerEngine agora testada

`botfinal/tests/walker_chain.test.cjs` (9 testes, todos locais):

- norte/leste/sul/oeste → `walk` 0/1/2/3 (direção **nasce do motor**)
- waypoint no mesmo tile → nenhum comando
- waypoint em outro andar → nenhum comando (após a correção)
- `stop` interrompe novos despachos
- snapshot stale bloqueia
- cadência de 280 ms respeitada

Diferença do teste A: ali o script escolhe a direção. Aqui o motor decide.
Se o motor errar, o comando sai errado mesmo com transporte funcionando.

## 50. Matriz de decisão

| capacidade | referência | próprio | evidência | bloqueio |
| :--- | :--- | :--- | :--- | :--- |
| walker decisão | **nenhuma prova do algoritmo do Shiba** | `botfinal/engines/walker-engine.cjs` | testes locais 9/9 | falta cliente |
| walker execução | — | `PostMessageW` + scan extended | **VALIDADO NO CLIENTE** (A, 19:10Z) | exige foreground |
| seleção de alvo | regras com âncora | `combat-engine.cjs` | testes locais | DLL publica `creatures: []` |
| execução de ataque | RVA `0x15280` | **NÃO IMPLEMENTADO** | status 4 | RVA fixa inválida entre builds |
| background | tentado, não comprovado | `PKA_EXECUTOR_MODE=background` | nenhuma | **NÃO SUPORTADO** |

## 51. Testes e classificação

| item | estado |
| :--- | :--- |
| botfinal | **109/109** |
| tap | 48/48 |
| `validate.cjs` | success (611 node, 611 electron, smoke, audit) |
| Teste A no cliente | **VALIDADO NO CLIENTE** (19:10Z, DLL `b293b2e7…`) |
| Teste B (`--engine`) | **VALIDADO APENAS LOCALMENTE** — implementado, não executado no cliente |
| Teste S | **NÃO VALIDADO NO CLIENTE** |
| Walker decisão (z) | **VALIDADO APENAS LOCALMENTE** (bug corrigido, teste falhou antes) |
| Combate | **BLOQUEADO** (chamada nativa, RVA dinâmica) |
| Background | **NÃO SUPORTADO** (sem evidência; tentativa anterior falhou) |
| Equivalência Shiba | **NÃO AFIRMADA** — nenhum formato de mensagem prova equivalência |

## 52. Próximo passo

Sessão nova detectada: **PID 21900**, `PokeAlliance - Usobot`, sem DLL.

Para fechar o walker (teste B no cliente), preciso de autorização e:

1. injetar `pka_native.dll` (`b293b2e7…`) uma vez — o motor mudou só no Node,
   a DLL não precisa mudar;
2. confirmar personagem, hp, posição, estabilidade (novo gate) e foco;
3. `--engine --direction <dir> --countdown 15` com contagem para você
   posicionar o jogo;
4. limite já fixado no código: **2 comandos, 3000 ms**, aborta se perder
   foco/sessão/hp.

O teste S continua separado e não será executado.

---

# Rodada 8 — correção de inferência (PID 21900)

## 53. Erro meu: classifiquei seleção de personagem sem evidência

Em 2026-11-05 19:50 declarei que o PID 21900 estava na **tela de seleção**
baseado em quatro sinais. Três deles não sustentam a conclusão:

| sinal usado | por que não prova |
| :--- | :--- |
| título `PokeAlliance` (sem nome) | `reconstruction/walker-input-runtime.cjs:14` diz explicitamente: "O launcher nomeia a janela `PokeAlliance - <nome>`; **cliente aberto direto mantém `PokeAlliance`**. Nos dois casos o nome observado na telemetria vale." Título sem nome é estado **normal**, não seleção. |
| 0.04% de verde | andar 6 pode ser interior/caverna. A heurística de verde assume vegetação; não é válida para todo mapa. |
| 1 instância da vtable (vs 2) | a contagem de instâncias varia com alocação e GC do próprio jogo. Já observei 1, 2 e 3 instâncias em sessões válidas. |
| andar 6 (vs 7) | o usuário pode simplesmente ter descido um andar. Não é sinal de seleção. |

O único sinal com alguma força era a composição de cores (497 vs 1521 cores
distintas no centro), e mesmo esse é heurística de tela, não de estado de jogo.

**Conclusão correta:** com os dados que eu tinha, o estado era **indeterminado**.
Eu deveria ter dito isso e pedido confirmação, não afirmado "seleção".

## 54. Separação que faltava

| nível | o que é | como confirmo |
| :--- | :--- | :--- |
| processo encontrado | `PokeAlliance_dx.exe` com PID vivo | `Get-Process` + `QueryFullProcessImageNameW` |
| entidade encontrada | struct com vtable de LocalPlayer, nome, id, hp, pos válidos | varredura com `entity_is_player` |
| **sessão ativa no mundo** | o personagem está de fato no mapa jogável | **não tenho gate próprio**; depende de confirmação do operador |
| condição segura para agir | tudo acima + foco + estabilidade + área livre | gates + confirmação visual |

Os três primeiros eu meço. O terceiro — sessão ativa — eu **não** consigo
provar sozinho com as ferramentas atuais, e foi exatamente onde errei.

## 55. Gates não foram alterados

Nenhuma mudança em `live_walk_armed.cjs`, `live_probe.py` ou na DLL por causa
desta tentativa. O gate de estabilidade continua com os cinco critérios da
rodada 7.

## 56. Estado no momento do bloqueio

PID 21900, `PokeAlliance_dx.exe`, título `PokeAlliance`, 79 módulos, sem DLL
injetada. Entidade `Usobot` id 268446208, hp 100, `(957,1404,6)`, 1 instância,
estável 6/6.

Nenhuma ação executada: sem injeção, sem comando, sem contagem, sem
manipulação de janela.

---

# Rodada 9 — 2026-11-06 01:24Z — teste B executado, overshoot medido

## 57. Resultado bruto

```
--- estado inicial ---
  pid 21900 -> PokeAlliance_dx.exe
  modulo carregado: b293b2e736714ac5... (corrigida)
  janela: 1936x1048 max=true em foco=true
  canal: hp=100 pos={"x":957,"y":1404,"z":6}
  entidade: id=268448353 hp=100 pos={"x":957,"y":1404,"z":6}

ARMADO — espera 30s

--- revalidacao final ---
  todas as condicoes OK, inclusive foco
  posicao inicial inalterada: {"x":957,"y":1404,"z":6}

--- WalkerEngine -> runtime -> dispatcher (TESTE B) ---
  waypoint alvo: {"x":957,"y":1403,"z":6} (direcao esperada [0,-1])
  motor: ticks=3 estado=WALKING comandos=2
  last={"status":"step-dispatched","direction":0,"targetWp":{"x":957,"y":1403,"z":6}}
  comandos:
    01:24:14.056Z walk 0
    01:24:14.350Z walk 0
  depois: {"x":957,"y":1402,"z":6}
  delta : {"x":0,"y":-2,"z":0} (esperado [0,-1])
  z intacto: true | mesma entidade: true
  geometria inalterada: true (1936x1048 -> 1936x1048)
```

## 58. O que funcionou — e não é pouco

A cadeia `config → WalkerEngine → BotRuntime → StateArbiter → CommandDispatcher
→ Transport → pka_native.dll → cliente → movimento` **executou de ponta a ponta**
sem chamada direta ao dispatcher.

| elo | evidência |
| :--- | :--- |
| WalkerEngine decidiu | `last.direction = 0` (north) para waypoint `(957,1403,6)` |
| BotRuntime orquestrou | `ticks=3`, `estado=WALKING` |
| CommandDispatcher despachou | 2 entradas no `commandLog`, `parameter=0` |
| transporte aceitou | `delivery: {enqueued,written,received,accepted}` |
| **cliente moveu** | `y 1404 → 1402`, **2 tiles ao norte**, `z` intacto, mesma entidade |
| direção correta | `delta.x=0`, `delta.y<0` — norte, como o motor decidiu |
| janela preservada | `1936x1048` maximizada antes e depois |

**A direção nasceu do motor**, não do CLI. Isso é o que o teste B precisava provar.
E o deslocamento real corresponde: 2 comandos → 2 tiles.

## 59. O defeito revelado: overshoot por telemetria lenta

O teste **falhou no critério** `delta == (0,-1)` porque o personagem andou
**2 tiles** para um waypoint de **1 tile**.

Causa medida, não suposta:

| fonte | intervalo |
| :--- | :--- |
| `TELEMETRY_INTERVAL_MS` (de onde vem a posição) | **1000 ms** |
| `STATE_INTERVAL_MS` (hp/online, não posição) | 100 ms |
| cadência do `WalkerEngine` (`lastWalkTime < 280`) | **280 ms** |
| intervalo real entre os dois comandos | **294 ms** |

O motor pode despachar a cada 280 ms, mas a posição que ele lê só atualiza a
cada 1000 ms. Resultado: até **3 comandos** saem lendo o mesmo pacote de
telemetria, e o personagem passa do waypoint.

Não é falha do motor de decisão (ele decidiu norte corretamente). É
**descompasso entre a cadência de despacho e a taxa de observação**.

## 60. Desarme verificado

Após o teste, 10 leituras em 2 s: **posição estável**, `moved: false`,
lacuna máxima 202 ms. O produtor parou. Nenhum comando novo.

O desarme é encerramento seguro de B, não autorização de S. Teste S
**não** foi executado.

## 61. Classificação

| item | estado |
| :--- | :--- |
| Cadeia `config → motor → runtime → dispatcher → DLL → movimento` | **VALIDADA NO CLIENTE** |
| Decisão do WalkerEngine (direção) | **VALIDADA NO CLIENTE** (north, correta) |
| Controle de parada no waypoint | **NÃO VALIDADO** — overshoot de 1 tile |
| Teste A (dispatcher direto) | VALIDADO NO CLIENTE (19:10Z, DLL `b293b2e7…`) |
| Teste S | NÃO VALIDADO NO CLIENTE |
| Combate | BLOQUEADO |
| Background | NÃO SUPORTADO |

O critério `exactOneStep` do teste B está **correto** e não será afrouxado.
O que precisa mudar é o motor: não despachar novo passo sem telemetria nova.

## 62. Próxima correção mínima (não aplicada nesta rodada)

Uma linha de princípio: **o motor não deve emitir um segundo passo enquanto a
telemetria não mudar**. Opções, todas locais ao motor:

- só despachar quando `telemetryAt` avançou desde o último despacho;
- ou aumentar a cadência para >= `TELEMETRY_INTERVAL_MS`;
- ou, melhor, a DLL publicar telemetria com posição mais frequente.

Não alterei nada: a rodada era de validação, e mudar o motor logo após medir
o defeito misturaria causa e correção.

---

# Rodada 10 — correção do overshoot (controle de passo pendente)

Evidência original preservada e não modificada:
`local-data/walk-testB-armed-2026-11-06T01-23-27-440Z.json`.

Critério `exactOneStep` do teste B **não foi alterado**. O que mudou foi o motor.

## 63. Causa comprovada

Caminho real inspecionado: `BotRuntime.tick` → `arbiter.evaluate` →
`walker.tick(telemetry, dispatcher)` → `dispatcher.sendCommand`.

Medido na evidência de 01:24Z:

| fato | valor |
| :--- | :--- |
| comando 1 | `01:24:14.056Z` walk 0 |
| comando 2 | `01:24:14.350Z` walk 0 (**+294 ms**) |
| posição inicial | `(957,1404,6)` |
| waypoint | `(957,1403,6)` — 1 tile |
| posição final | `(957,1402,6)` — **2 tiles** |
| `telemetry.tick` usado nos dois | **a mesma amostra** (294 ms < 1000 ms de intervalo) |

Fontes de tempo no sistema:

| constante | valor | de onde vem |
| :--- | :--- | :--- |
| `TELEMETRY_INTERVAL_MS` | **1000 ms** | posição/entidade (`pka_native.c:42`) |
| `STATE_INTERVAL_MS` | 100 ms | apenas hp/online, **sem posição** |
| cadência do walker | 280 ms | `walker-engine.cjs` |

O motor podia despachar a cada 280 ms lendo posição de até 1000 ms atrás.
Com 294 ms entre ticks, o segundo despacho usou **a mesma observação** e não
havia como saber que o primeiro já surtira efeito.

**Outros caminhos de duplicação verificados e descartados:**

| hipótese | veredito |
| :--- | :--- |
| ticks sobrepostos | `BotRuntime.tick` tem guarda `this.busy` — não duplica |
| fila de comandos | `CommandDispatcher.send` é direto, sem fila |
| retry automático | não existe retry no caminho |
| promise pendente | `sendCommand` aguarda ACK; ACK não é efeito, mas não é assíncrono depois de resolvido |

Contribuição real: **o motor não tinha noção de "passo pendente"**. Ele tratava
cada tick como independente.

## 64. Invariantes que a correção garante

1. Passo pendente bloqueia novo despacho.
2. Só amostra com `tick` **maior** reconcilia.
3. Amostra nova com posição na origem = ainda em voo; espera.
4. Posição igual ao alvo = chegou; conclui sem comando extra.
5. Posição diferente de origem e alvo = deslocamento inesperado; **aborta**.
6. Sem progresso além de 2500 ms = **bloqueia**; não repete.
7. `playerId` diferente ou `z` diferente = **aborta**.
8. Ticks concorrentes: `inFlight` impede dois despachos.
9. `pause()` incrementa `epoch`; continuação em voo é descartada.

## 65. Arquivos alterados

| arquivo | mudança |
| :--- | :--- |
| `botfinal/engines/walker-engine.cjs` | reescrito com passo pendente, reconciliação por tick, timeout, cancelamento por epoch |
| `botfinal/tests/walker_pending_step.test.cjs` | **novo** — 11 testes de regressão |
| `tools/live_walk_armed.cjs` | passa `playerId`/`progressTimeoutMs`; não para no 2º comando; observação final de 3 s |

Nada na DLL. A causa estava no Node.

## 66. A regressão reproduzia o defeito

Prova de que o teste falha no código anterior: reconstruí o motor antigo em
arquivo temporário e rodei o mesmo cenário.

```
MOTOR ANTIGO — apos 1o tick: 1 comando(s)
MOTOR ANTIGO — apos 2o tick (mesma amostra): 2 comando(s)
teste 1 espera 1 comando. Antigo produziu 2 => FALHARIA (correto)
```

O motor novo produz 1. Os 11 testes cobrem: duplicação, amostra nova sem
movimento, chegada, timeout, concorrência, stop tardio, entidade, amostra
antiga, andar, rota de 2 passos, e o contrato do `pendingStep`.

## 67. Resultados locais

| suíte | resultado |
| :--- | :--- |
| `walker_pending_step.test.cjs` (novo) | **11/11** |
| `walker_chain.test.cjs` | 9/9 |
| `botfinal/tests/*` | **120/120** |
| `research/shiba_tap/*` | 48/48 |
| `node tools/validate.cjs` | success |

Logs em `validation-logs/`.

## 68. Limitações declaradas

- A reconciliação depende de `telemetry.tick` mudar. Se o servidor publicar
  duas amostras com o mesmo tick, a segunda é ignorada para confirmação.
  Isso é conservador de propósito.
- A posição só atualiza a cada **1000 ms**. Um passo pode levar até 1 s para
  ser confirmado. Ver o "chegou" mais rápido exigiria telemetria mais
  frequente na DLL — mudança separada.
- `pause()` impede novos despachos e invalida continuações, mas **não cancela**
  comando já aceito pelo cliente. Não existe API para isso.
- O motor não distingue "movimento por nós" de "movimento por terceiro" quando
  o deslocamento cai exatamente no alvo. Ambos contam como chegada.

## 69. Classificação

| item | estado |
| :--- | :--- |
| Overshoot do WalkerEngine | **corrigido localmente** (regressão 11/11) |
| Teste B no cliente | **NÃO VALIDADO** — aguardando autorização |
| Teste A | VALIDADO NO CLIENTE (19:10Z) |
| Teste S | NÃO VALIDADO |
| Combate | BLOQUEADO |
| Background | NÃO SUPORTADO |
| Equivalência Shiba | NÃO AFIRMADA |

## 70. Próxima tentativa B (requer autorização)

Cliente vivo: PID 21900, DLL `b293b2e7…` carregada, sem reinjeção necessária.

Plano:
1. revalidar PID, módulo, sessão, entidade, hp, posição e gates;
2. informar origem, waypoint de 1 tile, direção e delta esperado;
3. ARMADO + 30 s;
4. se a origem mudar durante a preparação, **abortar** sem recalcular;
5. executar **uma** tentativa; observação final de 3 s (3 atualizações de
   telemetria, ~25 ticks do runtime) para detectar despacho tardio;
6. desarmar e registrar.

Aceitação: exatamente 1 comando do motor, 1 tile na direção, mesma entidade,
`z` intacto, nenhum despacho tardio, janela sem manipulação.

---

# Rodada 11 — executor background: auditoria e bloqueio técnico

Somente leitura. Nenhuma ação no jogo, nenhuma captura nova, nenhum foco
alterado. Documento completo: `docs/BACKGROUND_EXECUTOR.md`.

## 71. Descoberta que reorienta a análise: o cliente é OTClient

Lido da imagem em memória do PID 21900:

```
classe da janela : PokeAllianceV3
[%i] LocalPlayer::walk server walk
[%i] LocalPlayer::preWalk %s -> %s, prewalk:%s
[%i] cancelWalk  / stopWalk / terminateWalk
/modules/game_walking/autowalk.otui
[%i] walkStep to %s: tile=%s ground=%s walkable=%s
RTTI: .?AVLuaObject@@  .?AVTile@@  .?AVCreature@@
```

Módulos: **sem SDL, sem DirectInput, sem XInput, sem raw input**.

## 72. Implicação: não existe tecla de movimento nesta engine

Mover, aqui, é `LocalPlayer::walk(dir)` — chamada nativa que envia
`server walk`. `PostMessage(WM_KEYDOWN)` atinge o handler de UI, não o motor.

Isso explica de forma coerente o já medido em 2026-11-05 12:44:

| condição | postadas | movidas |
| :--- | :--- | :--- |
| outra janela em foco | 4 | **0** |
| jogo em foco, mesmas 4 | 4 | **4**, delta exato |

**Background por PostMessage não é "não testado": está medido como não
funcional.**

## 73. Por que não chamei `LocalPlayer::walk` diretamente

Bloqueio medido, não suposição:

| passo | resultado |
| :--- | :--- |
| IAT em memória | 1 função por DLL; zero APIs de input (import dinâmico) |
| strings de input | só em módulos do sistema, **nenhuma no módulo do jogo** |
| cabeçalho PE em memória | ilegível/corrompido |
| `.text` | 26.2 MB, código válido |
| xrefs para `LocalPlayer::walk` | **0** em 26.2 MB |
| endereço absoluto da string | 0 |
| RVA da string como imediato 32 bits | 0 |

Zero xrefs em 26 MB = strings resolvidas em runtime (tabela dinâmica,
cifradas, ou import por hash). Sem isso não tenho RVA estável, ABI
(`rcx=this`? `dl=dir`?), thread correta nem pré-condições.

Chamar endereço presumido com ABI desconhecida em processo vivo pode
corromper o cliente. Não fiz.

## 74. Correção aplicada: remover o modo background nominal

| antes | agora |
| :--- | :--- |
| `PKA_EXECUTOR_MODE=background` pulava o gate e postava | `STATUS_BACKGROUND_UNSUPPORTED` (6), recusa explícita com log |
| retornava OK sem efeito | não posta nada |

Arquivo: `native/pka_native.c`. Build gerado: `pka_native_new.dll`
(207.360 B), **não carregada** (a em uso está travada pelo cliente).

Nada mais mudou. Foreground intacto.

## 75. Classificação

| item | estado |
| :--- | :--- |
| background com janela aberta atrás | **NÃO SUPORTADO** (medido: 0 movimento) |
| background minimizado | **NÃO SUPORTADO** (dependente do anterior; nem testado) |
| foreground | VALIDADO NO CLIENTE (A e B) |
| proteção contra overshoot | corrigida localmente; cliente pendente |
| interrupção de novos despachos | validada localmente |
| combate | BLOQUEADO |
| equivalência Shiba | NÃO AFIRMADA |

## 76. Caminhos para background legítimo (não implementados)

1. **Canal do próprio cliente** (`server walk` via socket/IPC) — mais
   promissor; não investigado.
2. **Chamada nativa** a `LocalPlayer::walk` — bloqueada pela seção 73.
3. **Superfície de script** (há RTTI `LuaObject`, cliente carrega `.otui`) —
   não verificado se o interpretador está ativo.
4. **PostMessage** — descartado por medição.

## 77. Próximo passo mínimo

Antes de qualquer código de background, responder **uma** pergunta com captura
específica:

> Existe canal local entre cliente e servidor, ou superfície de script ativa,
> por onde um `walk` possa ser emitido sem depender da janela?

Se sim → caminho 1 ou 3 viável. Se não → background fica bloqueado e o bot é
foreground-only, declarado como limitação.

## 78. Testes

| suíte | resultado |
| :--- | :--- |
| botfinal | **120/120** |
| tap | 48/48 |
| `validate.cjs` | success |

## 79. Pendências desta rodada

- Teste B no cliente com o motor corrigido (overshoot): **aguardando
  autorização**.
- Promoção da `pka_native_new.dll` (recusa de background): exige reinício
  controlado do cliente.

---

# Rodada 12 — correção: como o Shiba faz (não é teclado)

## 80. Resposta objetiva

**O Shiba não usa teclado em momento nenhum.** Por isso não tem dependência de
foco: ele nunca toca na janela.

O caminho, medido nos dumps existentes:

```
menu (Electron)
  └─ kind 11  { op:"start", module:"walker", config:{...} }
       └─ DLL injetada (C++, msftedit stomped)
            └─ send()  RVA 0x84340
                 └─ monta JSON  {"walk": {"step":…, "direction":…}}
                      └─ canal de comando do PRÓPRIO cliente
```

Duas coisas importantes:

1. **O menu manda a configuração inteira uma vez**, não comandos avulsos.
   Medido: `kind 9` = 0 em 105.722 frames. `kind 11` = 20 (4 `start`,
   6 `stop`, 2 `monitor`, 8 `togglePause`).
2. **A DLL monta o comando e injeta no canal interno do cliente** —
   `send` em `0x84340`, 61 call-sites com o mesmo prólogo
   (`research/shiba_tap/COMBAT_NATIVE_PROVEN.md`).

Para ataque/follow é ainda mais direto: **chamada nativa** ao dispatcher
(`0x15280` na build live, `0x12c40` no dump de 22/10), com
`ecx = targetId`, `dl = mode` (0=attack, 1=follow), indo até `0x1db40`.

### Como eles acham a função sem RVA fixo

Este é o detalhe que eu não tinha registrado:

```
[native] Client profile %s verified (%zu functions);
         Game RVA %llX, dispatcher RVA %llX.
```

Eles têm um **profile** — uma assinatura do cliente com contagem de funções
(`%zu functions`) — e resolvem `Game RVA` e `dispatcher RVA` **em runtime**.
É por isso que a build de 04/11 mudou tudo de lugar (dispatcher `0x12c40` →
`0x15280`, ponteiro `[rip+0x210a95]` → `[rip+0x20fa05]`) e continuou
funcionando.

Assinatura de identidade registrada (para achar sem RVA):

```
48 89 5c 24 08 48 89 6c 24 10 56 57 41 56 48 83
```

## 81. O que isso corrige no meu documento anterior

`docs/BACKGROUND_EXECUTOR.md` dizia que não havia evidência de mecanismo
background no Shiba. **Está errado.** A evidência existe e é clara:

| meu texto anterior | correto |
| :--- | :--- |
| "nenhuma evidência de execução independente de foco" | **há**: o Shiba não usa teclado, então foco é irrelevante por construção |
| "não sabemos se o Shiba caminha por tecla" | **sabemos**: não caminha por tecla. Usa `send` → JSON → canal do cliente |

O que continua verdade: **nós** não temos esse caminho implementado, e não
podemos reutilizar a DLL deles (componente licenciado de terceiro).

## 82. Por que isso não desbloqueia nada automaticamente

O `send` em `0x84340` é código **deles**, dentro da DLL **deles**. Ele roteia
para o canal interno do cliente — e é exatamente esse ponto de entrada do
cliente que nós não resolvemos (seção 73: zero xrefs em 26 MB).

Podemos copiar a **estratégia** (profile + resolução em runtime), não o código.

## 83. O caminho concreto agora tem forma

O bloqueio deixa de ser "não sabemos se é possível" e passa a ser
"não sabemos o endereço". E o Shiba mostra como resolver endereço sem RVA
fixo:

1. identificar o cliente por assinatura (contagem de funções / bytes de prólogo);
2. resolver o ponto de entrada de comando em runtime;
3. montar o JSON no formato que o cliente aceita.

O passo 2 é o que falta. Ele exigiria procurar, dentro do `.text` do cliente,
a função que recebe o comando `walk` — provavelmente perto da string
`LocalPlayer::walk server walk` (RVA `0x20265c0`), mas as xrefs não aparecem
estaticamente. A resolução teria que ser por **assinatura de prólogo + ordem de
chamada**, como o Shiba faz, não por referência direta à string.

## 84. Honestidade sobre o esforço

Isso é engenharia de reversing séria: achar por assinatura a função de comando
num binário de 26 MB com strings sem xref estática. O Shiba gastou tempo nisso
e mantém um "profile" versionado. Não é uma tarde.

Recomendação: antes de investir, confirmar a **hipótese central** — que o
cliente aceita comando de caminhada por um canal interno que não passa pela
janela. Uma captura específica (não ampla) pode responder: com o Shiba
rodando em background, o personagem anda? Se sim, está provado que existe e
vale perseguir. Se não, a premissa cai.

---

# Rodada 13 — auditoria do Shiba reproduzida; contrato do handler

Documento completo: `docs/WALK_HANDLER_CONTRACT.md`.
Somente leitura. Nenhuma execução, chamada, injeção ou movimento.

## 85. Auditoria independente reproduzida

`analyze_shiba_walk.py` rodado contra os dumps do nosso repo:
**17/17 assertions**, hashes conferidos.

Todas as âncoras pedidas batem: consumidor `payload+0xd4ac0`, chamadas
`0x14f35`/`0x14f59`, executor `0x11cc0`, ramo walk `0x1210d`, descritor
`0xe51b8`, chave `0x70d1d0`, perfil 6 → `exe+0x77f250`, gate `0x1dc20`
(`GetCurrentThreadId` vs thread gravada **31356**). **Nenhuma divergência.**

## 86. LACUNA 1 fechada: o handler existe no cliente ATUAL

O relatório dizia que o corpo do handler não estava nos dumps. **Está no
cliente.** `exe+0x77f250` existe na build atual (`82eadedc…`) no **mesmo RVA**,
mesmo prólogo, e referencia a string `[%i] Game::walk`.

Contrato confirmado:

```
RCX = this (objeto Game, 1o argumento — nao recarregado)
EDX = direcao (movsxd rdi, edx; cmp edi,7)
R8B = flag de origem (movzx r14d, r8b)
```

Gate de estado em `0x88ec20`: `[this+0x40]==0`, `[this+0x24]==0`,
`[this+0x68]` existe, `[[this+0x68]+0x3d0]!=0`.

Tabela de saltos em `0x77f824` (8 entradas). Cada ramo monta um OutputMessage
com o **opcode de direcao** e despacha pela vtable:

| dir | ramo | opcode | Tibia |
| :--- | :--- | :--- | :--- |
| 0 | 0x77f4c9 | 0x65 | N |
| 1 | 0x77f50c | 0x66 | E |
| 2 | 0x77f54f | 0x67 | S |
| 3 | 0x77f592 | 0x68 | W |
| 4 | 0x77f5d5 | 0x6A | NE |
| 5 | 0x77f618 | 0x6B | SE |
| 6 | 0x77f658 | 0x6C | SW |
| 7 | 0x77f698 | 0x6D | NW |

`0x5410c0` escreve o WORD no buffer (`mov [r8+rcx+0x2c], dx`; `add [rcx+0x24]`)
e tem a string `OutputMessage max buffer size`.

**No corpo inteiro: zero `PostMessage`, `SendInput`, `keybd_event`,
`GetAsyncKeyState`.** Não por inferência — os imports foram procurados na IAT
em memória e no módulo, e não existem.

Ainda desconhecido: ABI de retorno (dispatcher testa `al` → bool), semântica
de `R8B`, identidade do objeto de envio em `0x39c72a8`, e o `this` — que vem
da pilha do chamador, não de um global que eu localize estaticamente (o
candidato `0x227cc88` era ASCII `"6414"`, falso positivo).

## 87. LACUNA 2 aberta com precisão: contexto de thread

O gate compara `GetCurrentThreadId` com o ID gravado (`31356` na captura).
**Chamar de thread arbitrária é recusado.**

Falta exatamente isto: lista de threads do PID com start address no módulo,
qual bate com o global de thread, e se essa thread sobrevive à minimização.

É **uma** coleta (`Thread32First/Next` + `GetThreadStartAddress`), sem ação no
jogo. Não executei — exige autorização.

## 88. Correções que devo ao registro

| eu disse | correto |
| :--- | :--- |
| "o Shiba chama `LocalPlayer::walk`" | **não provado.** O handler referencia `[%i] Game::walk`. `Game::walk`, não `LocalPlayer::walk`. |
| "in-process comprova funcionamento sem foco" | **não comprova.** Localização não é comportamento; o gate de thread mostra que contexto importa. |
| "overshoot reproduzido localmente" | ordem: **observado no cliente** (2 tiles), **depois** reproduzido em teste. |
| "testes determinísticos substituem" | **não substituem.** Confirmação no cliente continua pendente. |
| "dias de trabalho / manutenção por build" | **sem base.** O RVA do handler está estável entre as builds examinadas. |

## 89. Arquitetura

O caminho do Shiba (`menu → kind 11 → DLL → send → OutputMessage → socket`)
não é copiável. A **ideia** é: entregar pacote ao canal do cliente em vez de
simular tecla.

Duas opções honestas, nenhuma pronta:

- (a) achar o ponto de envio (vtable do objeto em `0x39c72a8`) e chamá-lo do
  contexto certo — continuação natural desta auditoria;
- (b) falar direto com o servidor — exige reproduzir criptografia de sessão
  (XTEA é padrão em OTClient); outro projeto.

## 90. Próximo passo mínimo

Coleta de threads do PID, somente leitura, para identificar a thread que o
gate exige. Sem chamar nada, sem mexer no foco.

## 91. Estado das comprovações

| item | estado |
| :--- | :--- |
| Auditoria do Shiba reproduzida | **feito**, 17/17 |
| Contrato do handler walk | **confirmado** no cliente atual |
| Contexto de thread | **parcial** — gate provado, dono da thread desconhecido |
| Executor background próprio | **NÃO IMPLEMENTADO** |
| Overshoot | corrigido localmente; **cliente pendente** |
| Teste B no cliente | **pendente** |
| Teste A | VALIDADO NO CLIENTE (19:10Z) |

---

# Rodada 14 — contrato do Game::walk revisado

Documento: `docs/WALK_HANDLER_CONTRACT_2.md`.
Somente leitura. Nenhuma execução, chamada, hook, suspensão, movimento ou foco.

## 92. Duas correções importantes ao que eu havia escrito

**Correção 1 — o handler NÃO usa o RCX recebido.**
Varri todas as instruções que tocam `rcx` entre `0x77f250` e `0x77f2e0`:
o primeiro uso é `0x77f2c2 mov rcx, [rip+0x3247fdf]` = global `0x39c72a8`.
**Nenhuma leitura do argumento.** O `this` vem do global, não do chamador.

**Correção 2 — o handler NÃO envia diretamente.**
O ramo de direção monta um OutputMessage local, e o epílogo `0x77f6d6`
**enfileira**:

```
0x77f7a5 mov rax, [r8+0x9a8]   ; head
0x77f7b0 mov [r8+0x9a8], rcx
0x77f7b7 mov rcx, [r8+0x9b0]   ; tail
0x77f7c2 mov [r8+0x9b0], rdx
```
com `lock inc [rcx+8]` = refcount de `shared_ptr`.

`Game::walk` enfileira a caminhada. Quem drena e envia é outro componente,
ainda não identificado.

Também corrigi o dispatcher: ele remapeia argumentos
(`handler.rcx <- dispatcher.arg2`, `handler.rdx <- arg3`, `handler.r8 <- arg4`).
No ramo walk: `r9d = 0` → `R8B do handler = 0`, sempre.

## 93. Objeto: critério e estado medido

Gate `0x88ec20(this)`: `[+0x40]==0`, `[+0x24]==0`, `[+0x68]!=0`,
`[[+0x68]+0x3d0]!=0`. Antes, `[0x39c7268]!=0` e `[rax+0xb0]>0`.

Medido agora (jogo na **seleção** de personagem):
```
[0x39c73a8]=0  [0x39c7268]=0  [0x39c73aa]=0  [0x39c72a8]=0
```
Os quatro zero. Não é falha de análise — é prova de que são preenchidas na
**entrada do mundo**, e é o critério para distinguir objeto válido de sessão
anterior.

Falso positivo descartado: `0x227cc88` continha ASCII `"6414"`, não ponteiro.
Critério adotado: só vale se a vtable aponta para dentro do módulo **e** os
4 campos do gate passam.

## 94. Limites da função (via .pdata)

`Game::walk` = `0x77f250..0x77f844`, **1524 bytes**, unwind em `0x2160a60`.
Retorno real em `0x77f821`. **Tipo de retorno desconhecido** — não declaro bool.

## 95. Separação exigida

| | itens |
| :--- | :--- |
| **A** payload Shiba | gate `0x1dc20`, consumidor `0xd4ac0`, executor `0x11cc0`, ramo `0x1210d`, descritor `0xe51b8`, chave `0x70d1d0`, perfil 6→`0x77f250`, thread 31356 (histórica) |
| **B** cliente | `Game::walk` em `exe+0x77f250`, build `82eadedc…`, 8 opcodes, fila, zero teclado |
| **C** hipótese | que seja o caminho de produção do Shiba; quem drena a fila; se funciona sem foco/minimizado |
| **D** nosso bot | nada nesta rodada |

O gate de thread é **do Shiba**. O `Game::walk` **não tem** gate de thread —
não achei `GetCurrentThreadId` no corpo.

## 96. Prioridade C bloqueada com precisão

O contexto crítico não é do handler (ele só enfileira). É de **quem drena**
`[0x39c7268 + 0x9a8/0x9b0]`. Falta: identificar o drenador, sua thread, e se
ela roda minimizada.

## 97. Próximo passo (coleta única, sem ação)

Com o personagem **no mundo**, ler 4 qwords:
`[0x39c73a8]`, `[0x39c7268]`, `[0x39c73aa]`, `[0x39c72a8]`; e se não-zero,
`[[0x39c7268]+0xb0]`, `[+0x9a8]`, `[+0x9b0]`.

Leitura pura. Zero efeito. Fecha Prioridade A e dá o endereço da fila para
rastrear o drenador.

## 98. Preservação

`pendingStep`, reconciliação por amostra nova, proteção de concorrência,
timeout sem repetição e invalidação por sessão seguem intactos. Testes:
botfinal **120/120**, tap 48/48.

## 99. Pendências separadas

| item | estado |
| :--- | :--- |
| B (motor corrigido, sem overshoot) | **pendente no cliente** |
| Executor nativo (sem foco) | **não implementado**; contrato parcial |
| Teste A (teclado foreground) | VALIDADO NO CLIENTE (19:10Z) |

---

# Rodada 16 — PROMPT_UNIFICADO reproduzido; caminho natural descoberto

Documento: `docs/WALK_HANDLER_CONTRACT_3.md`.
Somente leitura. Nenhuma execução, chamada, injeção, hook ou movimento.

## 100. Reprodução das duas auditorias

| auditoria | resultado |
| :--- | :--- |
| `analyze_native_walk.py` (nova) | **28/28**; 366 instruções, 40 edges, 6 gate samples — **JSON idêntico** ao original |
| `analyze_shiba_walk.py` (referência) | **17/17**; walk `0xe51b8`, chave `0x70d1d0`, perfil 6 → `0x77f250` |

Tipos RTTI confirmados: `LocalPlayer`, `ProtocolGame`, `Tile`.

## 101. Correções incorporadas

1. Globais **não** estão zero — revalidadas preenchidas (personagem no mundo).
2. Objeto é `LocalPlayer`/`ProtocolGame`, não `Game`.
3. Gate tem **caminho alternativo** (`+0x40`/`+0x24` ≠ 0 → `+0x20==0`).
   Recalculado: critério antigo = false, fluxo real = **true**.
4. `+0x9a8/+0x9b0` = **par de `shared_ptr<Tile>`** (Δ16 bytes, refcount 3/2),
   não fila. Busca de drenador **suspensa**.
5. `R8B = 0` confirmado; retorno **desconhecido**.

## 102. Descoberta nova: os chamadores reais de Game::walk

Busca por `call rel32` no módulo inteiro:

```
0x745ada   contexto não decodifica (provável dado)
0x7b47a1   CHAMADOR REAL
```

Referências absolutas: 0. Entrada `.pdata`: nenhuma.

### O wrapper 0x7b4741

```
mov  r8d, [rcx+0xb4]      ; direção do objeto de input
call 0x776000             ; validação → WORD em ax
test r8w / je             ; inválido → sai
... throttle com [this+0xbf8] vs relógio ...
xor  r8d, r8d             ; R8B = 0  <<< confirmado no chamador
call Game::walk(dir, 0)
mov  [this+0xbf8], agora  ; atualiza timestamp
```

Responde três coisas:
- `R8B = 0` é o chamador que zera;
- **o cliente já tem throttle** (`[+0xbf8]`) — não invento pacing;
- **há validação antes** (`0x776000`: `word[+0x164]>=1`, `r8d==8`).

### O wrapper é callback dinâmico

`call rel32` para ele: **0**. `jmp rel32`: **0**. `qword`: **0**.

É invocado por ponteiro em heap — callback registrado, não chamada direta.
Coerente com OTClient: input chega por callback.

### 0x776000 compartilha a camada de tile

Usa `vtable+0x110` (RVA `0x765230`) e o **mesmo thunk `0x1a3a820`** do handler.
Existe camada comum: obter tile → validar → walk.

## 103. 0x41a37c7 reavaliado

| métrica | Game::walk | 0x41a37c7 |
| :--- | :--- | :--- |
| entropia | 5.77 | **6.20** |
| strings 0x400 | — | **0** |
| `.pdata` | não coberto | **não coberto** |
| densidade `e9` | — | 28 por 0x500 |

Fluxo fragmentado, sem `.pdata`. **Não decodificável por disassembly linear.**
Não declaro envio, thread-safety ou foco.

## 104. O elo que falta

Objeto, direção, `R8B` e gate: **resolvidos**.
**Contexto de thread: não resolvido.**

E a descoberta piora o risco: chamar `Game::walk` da thread do pipe **pula o
throttle e a validação** — produziria comportamento diferente do cliente.

## 105. Menor coleta (não executada)

Pergunta: qual thread executa `0x7b4741` e sobrevive a minimizar?

- (a) enumeração de threads + start address — **inócuo**, começar por aqui;
- (b) se insuficiente, hook de leitura em `0x7b4741` registrando thread ID —
  exige autorização, patch de 5 bytes, **rollback obrigatório**.

## 106. Marcos (inalterados, separados)

| marco | estado |
| :--- | :--- |
| Motor sem overshoot no cliente | **PENDENTE** (corrigido local, 120/120) |
| Executor nativo background | **NÃO IMPLEMENTADO**; contexto bloqueado |
| Teste A foreground | VALIDADO NO CLIENTE 19:10Z |
| Background/minimizado | NÃO SUPORTADO |

Testes: botfinal **120/120**, tap 48/48, `validate.cjs` success.

---

# Rodada 17 — contexto do chamador (PID 11596)

Documento: `docs/WALK_CALLER_CONTEXT.md`.
Somente leitura + enumeração passiva de threads. Zero execução, patch ou foco.

## 107. Correção: o entry point estava errado

```
0x7b473f c3        ret
0x7b4740 40 53     push rbx   <- ENTRADA
0x7b4741 53        push rbx   <- MEIO da instrucao (era o que eu usava)
```

Com `0x7b4741` eu achei **zero** chamadores. Com `0x7b4740` aparecem **dois**.
Minha busca anterior estava inválida por causa disso.

## 108. Wrapper 0x7b4740 — limites e contrato

Limites: `0x7b4740..0x7b47b7` (120 B).

| reg | valor | prova |
| :--- | :--- | :--- |
| rcx | ignorado pelo handler | recarrega `[0x39c72a8]` |
| edx | `[rbx+0xb4]` = direção | `0x7b4798` |
| r8b | **0** | `0x7b479e xor r8d,r8d` |

Throttle **em milissegundos**: `imul` com magia `0x20c49ba5e353f7cf` +
`sar 7` = divisão por 1000. Anda se `agora_ms >= [this+0xbf8] + delay_ms`.

## 109. 0x776000 não retorna booleano

Retorna **WORD = delay em ms**. Valida o tile de destino (faixa x/y/z,
`word[+0x164]>=1`, tabela por andar em `0x39c8400`). Não é "pode andar?".
Fórmula exata do delay: desconhecida.

## 110. Chamadores encontrados

**`0x7b6ed0(this, dl=dir)`** — função de mudar direção de caminhada:

```
cmp byte[rcx+0xcf6], dl   ; direção ativa já é essa?
je  sair
byte[rcx+0xcf6] = dl
test dl,dl ; je → 0x7b4a50 (parar)
[rcx+0xbf8] = 0           ; ZERA throttle
call 0x7b4740
```

**`0x996b54`** — tick que retoma caminhada se `[+0xcf6] != 0`.

O objeto tem layout compatível com `LocalPlayer` (`+0xb4`, `+0xbf8`, `+0xcf6`,
`+0x164`, `+0xa20/24/28`). **Identidade não provada** — é coincidência de
layout, não RTTI.

## 111. Threads (enumeração passiva)

66 threads. Só **uma** com start no módulo: **TID 21328**, RVA `0x59f0b8b`.

Entropia nesse endereço: **7.02** bits/byte vs 5.77 do `.text` normal, sem
strings legíveis. É código de **VM/proteção**, não lógica de jogo.

**Start address é pista, não prova** de quem executa o wrapper.

## 112. O que muda no desenho

Chamar **`0x7b6ed0(this, dir)`** é mais correto que `Game::walk` direto:
respeita a flag de direção ativa, o throttle e a validação de tile.

## 113. Perguntas separadas

| | estado |
| :--- | :--- |
| A) contexto do caminho natural | **desconhecido** (2 chamadores, sem scheduler) |
| B) mecanismo de agendamento | **aberto** |
| C) funciona sem foco | não testado |
| D) funciona minimizado | não testado |

A não comprova B/C/D.

## 114. Proposta de observação (NÃO executada)

Hook de leitura no entry `0x7b4740` registrando thread ID e `[rcx+0xcf6]`,
trampolim, 5 bytes, rollback obrigatório, janela de um passo manual seu.

**Antes disso**, tentar o caminho barato: rastrear o **registro do input**
(WM_KEYDOWN / window proc) que leva a `0x7b6ed0`. Isso resolveria sem patch.

## 115. Pendências preservadas

Motor sem overshoot no cliente: **PENDENTE**.
Executor nativo: **NÃO IMPLEMENTADO**.
`pendingStep` e controle de despacho: intactos. Testes 120/120 e 48/48.

---

# Rodada 18 — semantica de DL, loop continuo e relogio (PID 11596)

Documento: `docs/WALK_SEMANTICS_AND_LOOP.md`.
Somente leitura. Zero hook, patch, movimento ou foco.

## 116. DL e +0xcf6 — nao ha contradicao

Sao **parametros diferentes de funcoes diferentes**:

| funcao | registro | significado |
| :--- | :--- | :--- |
| `0x7b6ed0` | `dl` | **estado de caminhada ativa** (0 = parar) |
| `0x77f250` Game::walk | `edx` | **direcao 0..7** (0 = norte) |

`+0xcf6` guarda o ultimo `dl` (estado). A **direcao** vive em `+0xb4`:
`0x7b4746 mov r8d,[rcx+0xb4]` e `0x7b4798 mov edx,[rbx+0xb4]`.

Escritores de `+0xcf6`: so `0x7b0ed3` (construtor, zera) e `0x7b6ee8`
(o proprio 0x7b6ed0). Estado privado dele.

**Nao confirmado:** se `dl` aceita 1..7 como direcao. O `test dl,dl` so
mostra que zero e especial.

## 117. Caminhada continua — SIM, e o achado decisivo

Vtable em `0x7b4910` = RVA `0x1fae340`, RTTI:
```
.?AV?$_Func_impl_no_alloc@V<lambda_1>@?1??startAutoWalkLoop@LocalPlayer@@IEAAXXZ@
```

**`LocalPlayer::startAutoWalkLoop`** — funcao membro privada.

`0x7b47c0` cria um `std::function` dessa lambda e instala em `[this+0xbe8]`:

```
0x7b47e9  cmp qword [rdi],0      ; rdi = &this+0xbe8
0x7b4910  lea rdx,[0x1fae340]
0x7b4978  call 0x840330          ; factory
0x7b4984  call 0x3134d0          ; instala
```

O tick do loop e `0x996b10` (slot [2]): le `[rcx+0xcf6]` e chama `0x7b4a50`
(stop) ou `0x7b4740` (continua).

`0x7b4a50` **cancela e desinstala** o loop (`[rbx+0x80]=1`,
`[rdi+0xbe8]=0`, `[rdi+0xbf0]=0`). Nao e stop de um passo: e termino da
caminhada continua.

**Consequencia:** `0x7b6ed0(dl!=0)` INICIA caminhada continua. Nao serve ao
nosso contrato de um comando por passo.

## 118. Relogio — minha analise anterior estava errada

Eu disse "divisao por 1000 = ms" sem provar a unidade. Medi:

```
delta 2001828 ticks em 2.001 s  =>  1.000.494 ticks/s
```

**O relogio e em MICROSSEGUNDOS**, nao milissegundos.
`imul` + `sar 7` converte µs -> ms: verificado, `clock/1000` identico.

Throttle correto: `agora_ms >= [this+0xbf8] + delay_ms`.

## 119. Identidade

**Confirmado por RTTI:** o objeto do loop e `LocalPlayer`.
**Nao confirmado:** que `[0x39c7268]` seja a mesma instancia. Falta comparar
`[loop_obj]` com o global, com o jogo no mundo.

## 120. Chamador de 0x7b6ed0 — unico

```
0x7e1f71  call 0x7b6ed0
```
Contexto: `mov rcx,[rbx+0x1a0]` (LocalPlayer), `movzx edx,dil` (input).
Caminho: input -> `0x7e1f71` -> `0x7b6ed0`.

## 121. Recomendacao: Game::walk para o nosso contrato

| aspecto | Game::walk | 0x7b6ed0 |
| :--- | :--- | :--- |
| efeito | **um passo** | loop continuo |
| estado residual | nenhum | `+0xbe8`,`+0xcf6`,`+0xbf8` |
| precisa desarmar | nao | **sim** |
| preserva pendingStep | **sim** | **nao** |

`Game::walk` e o candidato correto. O que o wrapper faz e devemos replicar:
validar tile e respeitar atraso minimo — e nosso `pendingStep` + reconciliacao
por `telemetry.tick` ja ocupa esse papel.

Custo: chamando direto ignoramos a protecao `+0xbf8` do cliente. E
exatamente o que `pendingStep` substitui.

## 122. Lacunas restantes

| lacuna | coleta |
| :--- | :--- |
| thread do loop/input | hook de leitura em `0x7b4740` (5 B, rollback) ou `0x996b10` |
| valor de `dil` | mesma coleta |
| `[0x39c7268]` == instancia do loop? | **passiva**: ler `[LocalPlayer+0xbe8]` com o jogo no mundo |
| quem agenda `0x996b10` | rastrear o scheduler do std::function |

## 123. Pendencia preservada

Motor sem overshoot no cliente: PENDENTE.
Executor nativo: NAO IMPLEMENTADO (`Game::walk` escolhido).
`pendingStep`: intacto. Testes 120/120, 48/48.

---

# Rodada 19 — contrato do executor nativo (PID 11596)

Documento: `docs/NATIVE_EXECUTOR_CONTRACT.md`.
Somente leitura passiva. Zero hook, injecao, movimento ou foco.

## 124. Premissas corrigidas

1. **`pendingStep` NAO valida transitabilidade.** Ele controla despachos
   pendentes. Nao substitui `0x776000`, nao prova equivalencia ao throttle.
2. **`Game::walk` deixa estado persistente.** O epilogo troca o par
   `shared_ptr<Tile>` em `LocalPlayer+0x9a8/+0x9b0`.
3. **Efeito de chamada propria: nao provado.** Nunca chamamos do nosso lado.

Throttle: `pendingStep` e `[+0xbf8]` sao independentes. O segundo so e escrito
pelo wrapper `0x7b4740`. Chamando `Game::walk` direto, **a protecao nativa nao
esta em vigor** — nao e equivalencia, e ausencia que `pendingStep` cobre.

## 125. Agendamento: evidencia nova

Callers mapeados:
```
0x7b47c0 (startAutoWalkLoop): 1 -> 0x7b6f05  (dentro de 0x7b6ed0)
0x7b4a50 (stopAutoWalk):      3 -> 0x77df04 (teardown), 0x7b6f0c, 0x996b4d (tick)
0x7b6ed0 (setWalkActive):     1 -> 0x7e1f71 (input)
```

**Scheduler NAO localizado.** `addEvent`/`cancelEvent`/`processEvents` ausentes.
`scheduler` em `0x201dd58` e do **boost::asio** (vizinhos: `io_locking`,
`reactor`, `thread.entry_event`), nao dispatcher do jogo.
`std::ScheduledEvent` existe mas sem consumidor identificado.

A varredura por `[reg+0xbe8]` deu 118 ocorrencias — quase todas usando
`+0xbe8/+0xbf8` como **buffer de bits** de outros objetos.

## 126. Identidade (medida com jogo no mundo)

```
[0x39c7268] LocalPlayer = 0x1f16b43d020
  +0x164 = 320   (sessao viva)
  +0xbe8 = 0     (loop INATIVO — nao invalida a sessao)
  +0xcf6 = 0     +0xb4 = 0     +0xbf8 = 0
```

Instancia do loop vs global: **nao confirmado**. Exigiria loop ativo.
Busca por `[+0x2508]==LocalPlayer`: 64 ponteiros, **nenhum com vtable valida**
— o offset era coincidencia. Descartado.

## 127. Achado que decide a arquitetura

| funcao | `lock` (f0) | IAT |
| :--- | :--- | :--- |
| `Game::walk` | **4** (refcount shared_ptr) | 9 |
| `0x776000` | 0 | — |
| `0x7b4740` | 0 | — |

**`Game::walk` nao tem `EnterCriticalSection`.** Os 4 `lock` sao refcount. A
troca do **par** `+0x9a8/+0x9b0` nao e atomica como conjunto:

```
0x77f7a5 mov rax,[r8+0x9a8]  ; le antigo
0x77f7b0 mov [r8+0x9a8],rcx  ; escreve novo
0x77f7b7 mov rcx,[r8+0x9b0]
0x77f7c2 mov [r8+0x9b0],rdx
```

Chamar da thread do pipe **nao e seguro** sem mais evidencia. Nao por falta de
scheduler — por estado compartilhado sem sincronizacao de escrita.

## 128. Codigo preparatorio entregue

`botfinal/core/native-step.cjs` — maquina de estados:
`IDLE -> ACCEPTED -> SCHEDULED -> EXECUTED -> OBSERVED`, com `FAILED`,
`CANCELLED`, `UNKNOWN`.

Regras impostas: um comando por vez; identidade `(pid,boot,playerId)` no aceite;
TTL 2500 ms; descarte de expirado; cancelamento so antes de EXECUTED; sem retry
apos UNKNOWN; quatro estagios distintos.

`botfinal/tests/native_step.test.cjs` — 14 testes.

**O teste pegou um bug real:** `pending` retornava `null` em vez de `false`
quando `step` era null, e nao incluia `UNKNOWN`. Corrigido.

## 129. Proxima acao concreta no cliente

**Teste 1 (executor de teclado atual, nao o nativo):**
orbita 1 tile, z igual, `--walk=<dir> --walk-steps=1`, observacao final 3 s.
Aprovacao: delta exato 1 tile, z intacto, mesma entidade, zero despacho tardio.

**Teste 2 (executor nativo):** so apos resolver a thread. Alternativa sem hook
primeiro: ler `[LocalPlayer+0xbe8]` com caminhada ativa e comparar o ponteiro
capturado com `[0x39c7268]`.

## 130. Hook proposto (NAO executado)

Ponto: `0x7b4740..0x7b47b7`. Mecanismo: hook de leitura registrando
`GetCurrentThreadId`. 5 bytes + trampolim, original salvo, rollback obrigatorio,
janela de um passo manual, ate 5 eventos ou 60 s.

Matriz de resultados e conclusoes no documento, secao 7.

## 131. Testes

| suite | resultado |
| :--- | :--- |
| `native_step.test.cjs` (novo) | **14/14** |
| botfinal completo | **134/134** |
| tap | 48/48 |
| `validate.cjs` | success |

## 132. Pendencias preservadas

| marco | estado |
| :--- | :--- |
| Motor sem overshoot no cliente (teste B) | **PENDENTE** |
| Executor nativo | **NAO IMPLEMENTADO** — bloqueio: thread/estado compartilhado |
| Teste A foreground | VALIDADO 19:10Z |
| `pendingStep` | intacto |
