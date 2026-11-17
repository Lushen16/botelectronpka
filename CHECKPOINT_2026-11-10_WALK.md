# CHECKPOINT — 2026-11-10 — WALK NATIVO VALIDADO

Retomada do plano de cinco tarefas. Tarefa prioritária (movimento) fechada no
cliente real, com outras janelas em primeiro plano.

---

## 1. Resultado

```
10/10 walks consecutivos: delta exato, mesmo z, 1 comando,
0 passos extras, refcount do Tile estavel (3 -> 3)
```

Foreground durante a bateria: Brave (YouTube) e depois LeagueClientUx —
**o jogo nunca esteve em primeiro plano**. Nenhuma linha `tentando teclado`
desde o build corrigido.

Total desde o build corrigido (22:10 em diante): **17 execucoes nativas,
0 quedas para teclado, 0 INDETERMINATE**.

Estado do personagem ao final: `Usobot (3318,2084,7) hp=100`.

---

## 2. Dois bugs reais, ambos medidos

### 2.1 `WM_NULL` nao chega ao hook

`SendMessageTimeoutW(hwnd, WM_NULL, ...)` retorna sucesso, mas a callback
`WH_CALLWNDPROC` nao roda. Medido: **1 de 4 envios** disparava o hook.

A mensagem agora e' privada:

```c
g_wakeMsg = RegisterWindowMessageA("PKA_WAKE_GAME_THREAD");   /* 0xc2a2 nesta sessao */
```

`RegisterWindowMessage` devolve id em `0xC000..0xFFFF`, que atravessa o
despacho como mensagem de aplicacao normal.

### 2.2 Hook morre com a thread que o instalou

`WH_CALLWNDPROC` e' mantida **por thread**. A sessao do pipe cria uma thread
por conexao. Quando ela termina, a entrada sai da cadeia — mas `g_hook`
continua nao-NULL, entao `if (g_hook) return 1` mentia: o handle existia, a
callback nao estava mais instalada.

Sintoma exato: 1 movimento por sessao; depois disso
`envios=7 ok=7 falha=0` (a janela consumia a mensagem) e **nenhuma entrada na
callback**.

Correcao: `thread_alive(g_hookOwnerTid)` + `UnhookWindowsHookEx` +
reinstalacao a partir da thread chamadora. O log mostra o ciclo:

```
hook orfao (thread 7480 morta) removido; reinstalando
hook instalado na thread 7488 (janela 0x11079A), dono=7360
```

### 2.3 Crash ao descarregar a DLL

`FreeLibrary` com o hook instalado **derrubou o cliente**, sem entrada no log.
Mecanismo: `DLL_PROCESS_DETACH` liberava a imagem enquanto a cadeia de hooks
ainda apontava para `game_call_hook` — a proxima mensagem despachada chamava
endereco que nao e' mais codigo (`0xC0000005`).

Correcao em `shutdown_clean()`: `UnhookWindowsHookEx` antes de liberar.
`UnhookWindowsHookEx` nao faz I/O nem aloca memoria de usuario, entao e'
seguro sob loader lock.

---

## 3. Instrumentos adicionados (permanentes)

Nenhum dos tres existia, e cada um separa diagnosticos que antes colidiam:

| instrumento | o que separa |
| :--- | :--- |
| `entradas=` (contador da callback) | "hook nao esta na cadeia" vs "hook rodou e ignorou" |
| `envios/ok/falha/ultimoErro` | "nao despachou" vs "despachou, janela nao consumiu" |
| `dono=` no log de instalacao | qual thread mantem a cadeia; base do `thread_alive` |

`hook rodou na thread 7488 (alvo 7488)` prova que a callback executa **na
thread alvo**, nao na thread da sessao — antes era suposicao.

---

## 4. Arquivos alterados

```
native/pka_native.c            g_wakeMsg, g_hookEntries, g_hookOwnerTid,
                               thread_alive(), reinstalacao, Unhook no detach,
                               log instrumentado
native/pka_native.dll          rebuild verificado (223232 bytes)
```

Nao tocados: `botfinal/`, `reconstruction/`, `research/shiba_tap/`,
`tools/tap_*`. `pendingStep` intacto.

---

## 5. Pendente

| marco | estado |
| :--- | :--- |
| Walk nativo 1 tile, sem foco | **VALIDADO** 10/10 |
| Reinstalacao de hook por sessao | validada (14 ciclos no log) |
| Unload sem crash | **corrigido, NAO retestado** |
| Ataque controlado com alvo identificavel | pendente (tarefa 5.3 do plano) |
| Autocombo com efeito observavel | pendente (candidato offline `0x67fbf0`, nao chamar) |
| Rota curta com pausa para combate | pendente (tarefa 5.5) |
| Teste B (motor sem overshoot) | pendente |

Veredito de funcionamento do bot inteiro continua **nao emitido**. O que esta
provado e' o primitivo de movimento.

---

# ADENDO — 2026-11-10 22:40 — SEGUNDO PLANO MEDIDO

Pergunta do operador: "os testes precisam usar a DLL como o outro chat fazia,
para rodar com o jogo em segundo plano". Auditoria completa abaixo. Resultado:
**metade do que o doc antigo afirmava estava obsoleto.**

## 1. O doc antigo (`docs/BACKGROUND_EXECUTOR.md`, 2026-11-06)

Conclusao da epoca: "background NAO SUPORTADO", baseada em um experimento de
2026-11-05 onde 4 `PostMessage` sem foco produziram **0 movimento**.

Isso estava correto para o que existia entao: **todo** caminho de acao era
tecla postada. E o cliente ignora `WM_KEYDOWN` postado sem foco. Medicao
solida — mas a conclusao caducou quando o caminho nativo apareceu.

## 2. O que mudou: tres caminhos, tres politicas

| tipo | caminho | thread | foco | segundo plano |
| :--- | :--- | :--- | :--- | :--- |
| 1 walk | `Game::walk` via hook | thread do jogo | **nao exige** | **FUNCIONA** |
| 2 attack | handler `exe+0x784be0` | thread da sessao do pipe | **nao exige** | **FUNCIONA** |
| 6/7 talk/combo | `WM_CHAR` no chat | tecla postada | **exige** | recusa |

Nenhuma mudanca de codigo causou isso: `run_in_game_thread` sempre pulou o gate
de foco (nao ha tecla), e o attack nunca teve gate de foco (chama funcao, nao
posta tecla). O doc antigo so' descrevia o mundo antes do caminho nativo.

## 3. Evidencia medida nesta rodada (foreground pelo League of Legends)

Instrumentacao nova em `execute_command`: registra `GetForegroundWindow()` NO
INSTANTE de cada comando. Sem isso, "funcionou em segundo plano" seria
afirmacao sem prova — o ACK nao carrega estado de janela.

```
22:39:23.418 cmd id=1 tipo=1: fg=3560 (jogo=20556) SEGUNDO PLANO
22:39:23.421 walk nativo: dir=2 na thread do jogo          <- moveu

22:39:30.362 cmd id=1 tipo=2: fg=3560 (jogo=20556) SEGUNDO PLANO
22:39:30.367 attack: handler devolveu 5                    <- executou
             hp do alvo: 100 -> 77                          <- efeito real
```

`fg=3560` = League of Legends. `jogo=20556` = PokeAlliance. O jogo nunca
esteve em primeiro plano em nenhuma das duas acoes.

Bateria anterior (ainda com o build sem instrumentacao): **10/10 walks** com
Brave (YouTube) e LeagueClientUx em primeiro plano; **HP 100 -> 29 -> morto**
em dois ataques. Total no log desde o build corrigido: **17 execucoes
nativas, 0 quedas para teclado**.

## 4. Fix do unload validado

Ficou pendente na rodada anterior. Testado agora:

```
antes: vivo=True
FreeLibrary(0x7fffeb590000) -> exit=1 (descarregou)
DEPOIS: processo SOBREVIVEU
```

O `UnhookWindowsHookEx` em `shutdown_clean()` resolveu o `0xC0000005`
silencioso.

## 5. O que ainda exige foco (declarado, nao escondido)

- **talk / combo (tipos 6/7)**: `send_chat_text` abre o console com Enter
  postado. Sem foco o cliente ignora. Recusa com `STATUS_NO_FOREGROUND`.
- **hotkey (tipo 20)**: mesma natureza de tecla postada.

Para esses, o caminho background seria o handler nativo de `!autocombo` em
`exe+0x67fbf0` (candidato offline do Silas, `docs/COMBO_CAMINHO_DE_ENVIO_OFFLINE.md`)
— **nao provado, nao chamar**.

## 6. Correcao do doc antigo

`docs/BACKGROUND_EXECUTOR.md` secao 5 diz "background com janela aberta atras
de outra = NAO SUPORTADO (medido: 0 movimento)". Verdadeiro **apenas para o
caminho de teclado**. Para walk e attack nativos esta' errado desde que o
caminho nativo existe. O doc precisa de nota; nao reescrevi a medicao
historica, que continua valida para o que mediu.

---

# ADENDO 2 — 2026-11-10 23:30 — TEXTO NATIVO + UNLOAD CORRIGIDO

O operador estava certo: **o Shiba executa o bot inteiro em segundo plano.**
Auditoria estatica e ao vivo abaixo, com a implementacao que fecha a lacuna.

## 1. Prova de que o Shiba nao usa foco (estatica)

`dumps/payload_reconstructed.dll` tem DUAS camadas de import (normal e
delay-load). Varredura de `call [rip+disp32]` em **27.504.652 bytes** de
`.text` da imagem viva do PID 20556:

```
PostMessageW/SendMessageW/SendInput/keybd_event   -> 0 xrefs no codigo
SetForegroundWindow/GetForegroundWindow/SetFocus  -> 0 xrefs no codigo
```

Os nomes existem SO' nas tabelas de import herdadas do `msftedit.dll`
stomped. O codigo do payload nunca os chama. O caminho dele e' chamada de
funcao dentro do processo, exatamente como o walk e o attack que ja' temos.

## 2. A cadeia de texto do jogo (reancorada ao vivo)

```
0x67fbf0  handler "!autocombo"   cmp len,0xa + strncmp  (2 callers: 0x4439b4, 0x5f2e30)
0x785050  consumidor de texto    5 callers reais
0x812240  corpo ofuscado         call 0x4304e8a fora da .text mapeada
```

Assinaturas de 32 bytes conferidas byte a byte na memoria do PID 20556:
`0x785050` e `0x812240` batem 100% com `docs/COMBO_CAMINHO_DE_ENVIO_OFFLINE.md`.

Assinatura de chamada de `0x785050`, medida:
`rcx=objeto (recarregado de [0x39cb998])`, `edx=1`, `r8d=0`, `r9=&std::string`.

Gates (todos checados no corpo, todos abertos no teste):
`[0x39cba98]!=0` (era 1), `[0x39cb958]!=NULL`, `[LP+0xb0]>0` (HP 100),
`[0x39cba9a]==0`, `[0x39cb998]!=NULL`, `0x891600()!=0`.

## 3. Implementado em `native/pka_native.c`

- `resolve_text_path()`: valida prologo de 20 bytes + os 6 gates antes de
  qualquer chamada. Build diferente -> recusa, nao chama.
- `run_text_in_game_thread()`: publica o texto em `g_gameCall.textBuf` e usa o
  MESMO executor com maquina de estados do walk.
- hook `game_call_hook`: monta `std::string` (layout MSVC x64, 32 bytes:
  `+0x00 buf/ptr`, `+0x10 size`, `+0x18 cap`) **na pilha da thread do jogo** e
  chama. O consumidor destroi a string no epilogo; nao retemos ponteiro.
- talk/combo tentam o caminho nativo PRIMEIRO. Fallback de teclado so' se o
  nativo nem chegou a executar.

## 4. Medido no cliente (PID 30968, foreground = Brave/YouTube)

```
23:25:44.808 cmd id=1 tipo=6: fg=22128 (jogo=30968) SEGUNDO PLANO
23:25:44.814 talk nativo: "!autocombo" despachado na thread do jogo

23:25:46.035 cmd id=2 tipo=7: fg=22128 (jogo=30968) SEGUNDO PLANO
23:25:46.038 combo nativo: "!autocombo" despachado na thread do jogo
```

`fg=22128` = Brave. O jogo nunca esteve em primeiro plano.
Bateria de walk no mesmo processo: **7/8** (a falha foi obstaculo no tile,
confirmada por repeticao bem-sucedida).

## 5. LIMITE HONESTO: texto com mais de 15 bytes

`std::string` do MSVC usa SSO ate 15 bytes. Acima disso o buffer vive no heap
e o destrutor do jogo (`0x785166 -> 0xa15260 -> jmp 0xa158e0 -> jmp 0xa14c60
-> jmp 0x41ca711`) chama o `free()` DELE. Nossa DLL e' zig/mingw: CRT
diferente. Alocar com `malloc()` nosso e deixar o jogo liberar corromperia o
heap do cliente.

Por isso `!autocombo m5, m6` (17 bytes) e' **recusado antes de tocar no
heap**, com motivo no log — nao com a mensagem falsa "hook nao pegou".
O operator new/delete do jogo existe (`0x306490` / `0xa15260`), mas ambos
entram em codigo virtualizado; a ABI nao esta' provada. Habilitar exige
chamar `0x306490` dentro da thread do jogo e provar o contrato.

## 6. Unload: a correcao anterior estava INCOMPLETA

O fix anterior (UnhookWindowsHookEx no detach) **nao bastou**: o cliente
morreu de novo em `FreeLibrary` (PID 20556, exit `0xC0000005`). Causa real:

`FreeLibrary` dispara `DLL_PROCESS_DETACH` com o loader lock tomado. Ali so'
da' para sinalizar — nao da' para esperar as threads. Quando o loader libera a
imagem, `session_thread`/`scanner_thread` ainda rodando executam codigo
inexistente. O hook era so' uma das causas.

Correcao real, em duas partes:

```
native/pka_native.c    export PkaShutdown: sinaliza, acorda o pipe
                       (CancelSynchronousIo), espera cada thread (3 s),
                       remove o hook. Retorna threads presas.
native/pka_uninject.c  chama PkaShutdown ANTES do FreeLibrary, e ABORTA o
                       unload se alguma thread nao saiu.
```

Validado:

```
shutdown ordenado ok (0 threads presas)
FreeLibrary(0x7fff84310000) -> exit=1 (1 = descarregou)
DEPOIS: processo VIVO
```

## 7. Estado

| capacidade | segundo plano | evidencia |
| :--- | :--- | :--- |
| walk (tipo 1) | **SIM** | 10/10 + 7/8, delega na thread do jogo |
| attack (tipo 2) | **SIM** | HP 100->29->morto com fg=BRAVE |
| talk `!autocombo` | **SIM** | `talk nativo: despachado na thread do jogo` |
| combo `!autocombo` | **SIM** | idem, 10 bytes (SSO) |
| texto > 15 bytes | **RECUSADO** | SSO/acessor nao provado |
| hotkey (tipo 20) | nao (tecla) | `WM_CHAR`/`PostMessage` exige foco |
| unload sem crash | **SIM** | `PkaShutdown` + abort se thread presa |

Suite: 617 testes, 0 falhas.

---

# ADENDO 3 — 2026-11-10 23:45 — SSO RESOLVIDO + 3 BUGS REAIS

## 1. Texto longo (> 15 bytes): RESOLVIDO, sem heap

Meu diagnostico anterior estava ERRADO. Eu afirmei que o epilogo de `0x785050`
destruia a string do CHAMADOR, e que por isso seria preciso usar o alocador do
jogo. O disasm ao vivo desmente:

```
0x7850e5  inicializa string VAZIA em [rsp+0x40], cap=15
0x78510d  [rsp+0x20] = rdi      <- a string do CHAMADOR vira 5o argumento
0x785112  lea r9,[rsp+0x40]     <- r9 e' a string LOCAL dele
0x785159  destructor so' se [rsp+0x58] > 0xf
```

O destrutor do epilogo trata a string **local dele** (a vazia), nunca a do
chamador. E o chamador de referencia (`0x67fbf0`) libera a propria string
DEPOIS do retorno — o que prova, por construcao, que `0x812240` nao retem o
ponteiro.

Consequencia: **nao preciso de heap**. A `std::string` aponta para buffer
estatico desta DLL (`g_textHeap[208]`, mapeado no processo do jogo, vive tanto
quanto a DLL). Zero malloc, zero free, zero divergencia de CRT entre zig/mingw
e o exe.

Tambem corrigi um bug na struct: faltava `union { char buf[16]; char* ptr; }`.
Sem ela, escrever `size`/`cap` grandes fazia o jogo ler os 8 primeiros bytes
do TEXTO como endereco.

Medido (PID 30968, foreground = Brave):

```
combo "!autocombo m5, m6"                      (17b) -> status=0 nativo
combo "!autocombo m1, m2, m3"                  (21b) -> status=0 nativo
combo "!autocombo m1, m2, m3, m4, m5, m6"      (33b) -> status=0 nativo
```

Estabilidade: 10 combos longos seguidos, 10/10 ok, memoria privada
1748.2MB -> 1748.2MB (identica). Sem vazamento, sem corrupcao.

## 2. BUG REAL: uninject carregava a DLL em si mesmo

`pka_uninject.c` fazia `LoadLibraryA("pka_native.dll")` para calcular o RVA do
export. Isso carregava a DLL **no processo do uninject**, o `DllMain`
disparava `boot_thread -> init_once`, abria pipe, iniciava scanner — um
segundo bot rodando, log com PID errado, e no fim `0xC0000005`
(`exit=-1073741819`).

Correcao: `LoadLibraryExA(..., DONT_RESOLVE_DLL_REFERENCES)` — carrega a
imagem sem executar DllMain e sem resolver imports. So' para pegar a base.

## 3. BUG REAL: log de scan_creatures mentia

`log_line("scan_creatures: %d selvagens")` usava `foundCount`, que conta TODAS
as entidades. Resultado: "5 selvagens" quando eram 5 summons de outros
jogadores e ZERO selvagens.

Isso me fez suspeitar que `canAttack = (type==1)` estivesse errado para este
build. **Nao estava.** Convencao OTClient medida:

| type | significado | observado |
| :--- | :--- | :--- |
| 0 | player | Usobot |
| 1 | monster (selvagem) | nenhum na area |
| 3 | summon proprio | Dugtrio (aliado) |
| 4 | summon de outro jogador | Gengar, Gardevoir, Abra |

`canAttack = (type==1 && hp>0)` esta' correto. O log agora separa as quatro
categorias:

```
scan_creatures: 0 selvagem(ns), 1 summon proprio, 0 summon de outro,
                0 player(s) [total 1], aliado=Dugtrio
```

## 4. Ciclo completo validado

```
inject    -> dll carregada, layout detectado
walk      -> nativo, SEGUNDO PLANO
attack    -> nativo, efeito real (HP caiu)
talk      -> nativo, 10b
combo     -> nativo, 17b / 21b / 33b
uninject  -> shutdown ordenado ok (0 threads presas)
             FreeLibrary -> exit=1
             exit=0, processo VIVO, responding=True
```

Suite: 617 testes, 0 falhas.

## 5. Estado final por capacidade

| capacidade | 2o plano | tamanho | evidencia |
| :--- | :--- | :--- | :--- |
| walk | SIM | - | 10/10 + 7/8 |
| attack | SIM | - | HP 100->29->77 |
| talk | SIM | 10b | log nativo |
| combo | SIM | ate 33b | log nativo, 10/10 stress |
| unload | SIM | - | exit=0, processo vivo |
| hotkey | nao | - | `WM_CHAR` exige foco (pendente) |

---

# ADENDO 4 — 2026-11-11 00:00 — ROTA INTEGRADA + HOTKEY AUDITADO

## 1. Hotkey (tipo 20): NAO existe caminho nativo comprovado

Auditoria das capturas do Shiba oficial rodando:

```
pka_tap_8036.jsonl   171.781 frames
pka_tap_33524.jsonl  158.067 frames
TOTAL                329.848 frames
hotkey               0 ocorrencias
kinds observados     4 (state) / 5 (telemetry) / 6 (kind6) / 11 / 12
```

Todos os kinds sao servidor -> cliente. O Shiba nunca emitiu `hotkey` nas
capturas que temos. Nao ha evidencia de handler nativo no exe: a varredura da
string "hotkey" nao encontra nada no modulo vivo, e as referencias no payload
de pesquisa eram montagem de JSON de protocolo, nao chamada de funcao.

Conclusao honesta: `hotkey` continua dependendo de tecla (`tap_key` +
`require_foreground`). **Nao inventamos um caminho nativo** porque nenhuma
evidencia aponta para um. Se o Shiba usa hotkey em alguma rotina, isso nao
apareceu nas 329 mil amostras.

## 2. Rota integrada criada e validada

`tools/route-e2e.cjs` — exercita o ciclo completo numa unica sessao:

```
1. conecta no canal nativo, espera snapshot fresco
2. anda N tiles na direcao pedida (walk nativo)
3. escolhe o alvo mais proximo NO MESMO z e aproxima ate estar no alcance
4. ataca e mede HP antes/depois
5. dispara o combo configurado (texto nativo)
```

### Duas execucoes completas

```
=== pid=30968, foreground = League of Legends (fg=19072) ===

rota 1 (dir=2):
  walk #1  status=0  delta=(0,1)  OK
  walk #2  status=0  delta=(0,1)  OK
  attack    status=0  alvo=Bellsprout dist=6 dz=0  hp 100->77  EFEITO OK
  combo     status=0  "!autocombo m5, m6" (17b)
  VEREDITO: SUCESSO: rota completa em segundo plano

rota 2 (dir=0):
  walk #1..3  status=0  delta=(0,-1)  OK  (3/3)
  attack      status=0  alvo=Weepinbell dist=7 dz=0  hp 100->94  EFEITO OK
  combo       status=0  "!autocombo m5, m6" (17b)
  VEREDITO: SUCESSO: rota completa em segundo plano
```

O jogo nunca esteve em primeiro plano nestas rotas.

## 3. Bugs de medicao que a rota revelou (e como foram tratados)

### 3.1 Alvo fora de alcance parece "sem efeito"

Primeira tentativa atacou `Electrode` a **dist=12, dz=3** (3 andares abaixo).
O handler devolveu codigo 5 e o ACK foi status 0, mas o HP nao caiu. Nao e'
falha do mecanismo: o jogo aceita a chamada e nao aplica dano fora de alcance.

Correcao no roteador: escolher o alvo mais proximo **no mesmo z** e aproximar
antes de atacar. O veredito agora distingue:

```
SEM EFEITO (alvo fora de alcance — nao prova falha)
SEM EFEITO  (alvo no alcance — falha real de mecanismo)
```

### 3.2 Walk contra parede parece falha

`dir=3` falhou 3/3 com `walk nativo: dir=3 na thread do jogo` no log — o
comando executou nativamente todas as vezes e a posicao nao mudou. Era uma
parede a oeste. Comportamento correto do jogo, nao do bot.

Nao mascaramos isso: a rota reporta FALHOU quando o delta nao bate. O
operador ve o motivo no log (`walk nativo: dir=3` = executou).

## 4. Estado final por capacidade

| capacidade | 2o plano | prova |
| :--- | :--- | :--- |
| walk | SIM | 3/3 + 2/2 nas rotas; 10/10 anterior |
| attack | SIM | HP 100->77 e 100->94, fg=LoL |
| talk | SIM | `talk nativo: despachado` |
| combo | SIM | 10b / 17b / 21b / 33b, 10/10 stress |
| rota integrada | SIM | 2 execucoes SUCESSO |
| unload | SIM | exit=0, processo vivo |
| hotkey | **nao** | 0 em 329k frames; sem handler nativo |

Suite: 617 testes, 0 falhas.

## 5. Arquivos novos/alterados nesta rodada

```
tools/route-e2e.cjs        novo: rota integrada com medicao de efeito
native/pka_native.c        log de scan separado por tipo (4 categorias)
native/pka_uninject.c      LoadLibraryEx DONT_RESOLVE (bug do DllMain)
```

---

# ADENDO 5 — 2026-11-11 00:20 — REVISAO DA EVIDENCIA DO SHIBA

O operador perguntou se falta evidencia sobre COMO o Shiba executa. A resposta
e' sim, e a auditoria das capturas corrigiu duas afirmacoes minhas.

## 1. CORRECAO: "0 movimento em segundo plano" estava ERRADO

No adendo 4 eu escrevi que o Shiba nunca emitiu hotkey e que nao havia
evidencia de execucao em segundo plano. A primeira parte continua verdadeira.
A segunda era um erro de medicao meu.

**O erro:** meu detector usava `telemetry.position` como prova de movimento.
So' 49 de 9.222 frames (0.55%) tem position preenchida — nos outros 9.173 o
campo e' `null` porque o cliente estava no menu/desconectado
(`playerName:"", creatures:0, items:0`). Ou seja: eu media movimento numa
janela de 49 amostras e concluia sobre 9.222.

**O que a fonte correta diz:** o campo `phase` do kind6 e' o estado do motor, e
ele avanca independente de foco:

```
transicoes de WP com foreground=false : 11.731
voltas completas (WP 23 -> WP 1)      : 28
waypoints distintos vistos            : 1..23 (todos)
```

## 2. Evidencia de trabalho efetivo em segundo plano

Frames em que o Shiba estava com `foreground=false` (36.936 de 37.702 = 98%):

| fase | frames | o que prova |
| :--- | ---: | :--- |
| `Walker · WP n/23 · walk` | 11.731 | 28 voltas completas de rota |
| `Perfect lure · n/m monstros` | 2.237 | montou formacao de combo |
| `AutoCombo: aguardando cooldown de mX` | 1.334 | skill disparou (entrou em cooldown) |
| `Revive: aguardando envio da hotkey` | 448 | ciclo de revive rodou |

E quem estava em primeiro plano nesse tempo:

```
pid 7060  : 18.652 frames
pid 20352 : 12.893 frames
pid 11852 :  4.736 frames
pid 33524 :    367 frames   (o proprio jogo, ocasionalmente)
```

Nenhum desses e' o processo do jogo na maior parte do tempo. O Shiba fez 28
voltas de waypoint, montou lure e disparou skills com outra janela na frente.

## 3. O que o kind6 revela sobre o processo dele

Campos de topo do kind6 (payload JSON completo):

```
ack, authorized, boot, busy, client, core, error, events, foreground,
foregroundPid, gmLearning, guildDaily, hoennCounts, instanceEntry, luring,
modules, monitor, pauseKeyDown, paused, pausedModules, phase, phases, pid,
protocol, walkerIndex, walkerTimer, tick
```

Isso responde "como ele executa" com muito mais detalhe do que temos:

- **`foreground` + `foregroundPid`**: ele MONITORA o foco, nao depende dele.
  O campo existe justamente para reportar que a janela esta' atras.
- **`core.movementOwner`** (`null` | `target`): arbitragem de quem manda no
  movimento naquele tick.
- **`paused` / `pausedModules` / `pauseKeyDown`**: pausa granular por modulo.
- **`walkerIndex` / `walkerTimer`**: estado do walker por indice de waypoint.
- **`luring`, `instanceEntry`, `gmLearning`, `hoennCounts`**: subsistemas.
- **`events[]`** com `rule`, `ruleIndex`, `alert`: sistema de regras com
  nomes reais (`hunt_pokemon`, `creatureRange`, `playerRange`,
  `gmArrowMode`, `hpThreshold`, `talkCooldownSec`).

Exemplo real de regra capturada:

```
"name": "Pokemons na hunt", "type": "hunt_pokemon",
"creatureRange": 7, "playerRange": 5, "hpThreshold": 30,
"huntPokemonNames": "Steelix,Rhydon,Torterra,Marowak,Pupitar,Electabuzz",
"gmArrowMode": "stop", "talkEnabled": false
```

## 4. LACUNAS REAIS (o que ainda nao sabemos)

O operador tem razao em suspeitar. Falta evidencia sobre:

1. **O canal c2s do jogo.** A captura 8036 tem 13.707 frames c2s, mas quase
   todos sao kind 11/12 (automation). **Nenhum comando `manual` (kind 9) foi
   capturado** — ou seja: nao temos uma unica amostra de como o Shiba envia
   walk/attack/combo pelo protocolo. Sabemos o formato (`protocol.cjs`,
   `COMBAT_NATIVE_PROVEN.md`), nao temos o trafego real.
2. **A captura 33524 e' 100% c2s sem direcao util** — provavelmente um tap
   parcial. Nao serve como evidencia de execucao.
3. **Nao sabemos QUAL funcao ele chama para walk.** Temos `Game::walk`
   (nosso, validado 10/10) e sabemos que o payload tem dispatcher; nao temos
   a correlacao "o Shiba chama X" medida.
4. **Hotkey: 0 amostras** em 329k frames. Nao sabemos se ele usa tecla ou
   tem caminho nativo.
5. **Nao temos captura de um ataque real dele** com HP caindo por frame — so'
   as nossas próprias medicoes.

## 5. Veredito desta auditoria

O que a evidencia PROVA: o Shiba executa rotina completa (28 voltas de
waypoint, lure, autocombo, revive) com a janela em segundo plano. Isso valida
a arquitetura do nosso bot — e' o mesmo modelo (chamada nativa, sem foco).

O que a evidencia NAO prova: os detalhes de como cada primitiva e' emitida.
Para fechar isso seria preciso uma captura que inclua comandos `manual`
(kind 9) do Shiba, que e' exatamente o que os dois taps nao tem.

---

# ADENDO 6 — 2026-11-11 00:40 — MODELO DE EXECUCAO DO SHIBA (auditado)

Resposta direta: faltava evidencia sobre COMO ele executa. Esta rodada a
produziu, e o resultado **muda a arquitetura que presumimos**.

## 1. O canal de comando NUNCA foi usado nas capturas

Varredura completa dos dois taps:

| tap | frames | kind 9 (manual) | kind 10 (ack) | kind 11 | kind 12 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| 8036 | 171.781 | **0** | **0** | 20 | 13.687 |
| 33524 | 158.067 | **0** | **0** | 0 | 0 |

**Zero comandos `manual` e zero ACKs em 329.848 frames.** O caminho
walk/attack/combo-por-pipe que o nosso bot usa **nao aparece** nas capturas do
Shiba.

## 2. As unicas ops do canal de automacao sao de CONTROLE

```
togglePause x8, stop x6, monitor x2, start x4
```

Nenhuma delas move, ataca ou usa skill. Sao botoes de ligar/desligar/pausar.
O canal 11/12 e' **painel de controle**, nao canal de acao.

## 3. Entao como ele age? Pelos modulos DENTRO do processo

O kind6 reporta `modules: ["walker"]` / `["target"]` e um `phases` por modulo:

```
"modules": ["walker"], "phases": {"walker": "walker: iniciando"}
"phase": "Walker · WP 23/23 · walk", "walkerIndex": 22
"core": {"movementOwner": null, "phase": "idle"}
"luring": {...}, "monitor": {"enabled": false}
```

O fluxo real e':

```
menu (Electron)  --kind11/12-->  AUTORIZA / LIGA / PAUSA / PARA
                                       |
                                       v
                          DLL no jogo executa SOZINHA
                          (walker, target, lure, combo, revive)
                                       |
                                       v
                          kind6 publica estado/telemetria (leitura)
```

O menu **comanda o modo**, nao cada passo. Quem chama `Game::walk` e o
dispatcher e' o runtime dentro do processo, tick a tick, sem passar pelo pipe.

**Isso explica os 28 loops de waypoint com `foreground=false`:** o walker roda
dentro do jogo; o pipe so' observa e reporta.

## 4. Implicacao direta para o NOSSO bot

Nosso bot faz o oposto em um ponto crucial:

| | Shiba | nosso bot |
| :--- | :--- | :--- |
| quem decide o passo | runtime interno (tick) | Node, via pipe |
| canal de acao | nao existe | kind 9 manual |
| canal de estado | kind 6 (leitura) | kind 4/5 (leitura) |
| latencia por passo | ~0 (mesmo processo) | 1 round-trip por comando |

O nosso modelo funciona — foi validado 10/10 em walk e com efeito real em
attack/combo. Mas **nao e' o mesmo modelo**. O nosso e' "controle remoto por
pipe"; o dele e' "agente autonomo no processo, painel remoto".

Consequencias praticas:

1. **Latencia**: cada passo nosso custa um round-trip. Em rota longa (23 WPs)
   ele e' ordens de grandeza mais rapido.
2. **Robustez**: se o nosso processo Node cair, o bot para. O dele continua.
3. **Arbitragem**: ele tem `movementOwner` interno resolvendo target vs walker
   no mesmo tick. Nossa arbitragem mora no Node e depende de telemetria
   fresca (ja' existe `state-arbiter.cjs`, mas com latencia).
4. **O `kind 11/12` do nosso repo nao e' um canal de comando perdido** — ele e'
   exatamente o que o Shiba usa: autorizacao e controle. O
   `kind11-codec.cjs` reproduz os frames corretos.

## 5. O que continua sem evidencia

1. **Qual funcao o walker dele chama por passo.** Sabemos que `Game::walk`
   existe e funciona (nosso, 10/10). Nao temos correlacao medida de que ele
   usa essa mesma funcao. Poderia ser `LocalPlayer::walk` (o do OTClient) ou o
   wrapper de autowalk (0x7b6320).
2. **Hotkey: 0 amostras** em 329k frames. Sem evidencia de mecanismo.
3. **Onde o `!autocombo` e' emitido.** Temos o handler no exe (0x67fbf0) e o
   consumidor (0x785050) provados por chamada nossa com efeito real. Nao temos
   captura de o Shiba chamando.
4. **Captura com o canal 9 ativo.** Para provar o modelo "controle remoto",
   seria preciso um tap de uma sessao onde o menu enviasse comando manual.

## 6. Correcao de rumo

Minha afirmacao anterior ("o Shiba executa o bot inteiro em segundo plano")
esta' **correta e agora explicada**: ele executa em segundo plano porque a
execucao mora dentro do processo do jogo, e o menu so' liga/desliga.

Isso tambem reenquadra o trabalho anterior: nao precisamos "descobrir o canal
secreto que o Shiba usa" — ele nao usa um. Precisamos decidir se o nosso
modelo (pipe) e' suficiente ou se vale mover a logica para dentro do processo
como ele faz.

---

# ADENDO 7 — 2026-11-11 01:00 — MENU DO SHIBA EXTRAIDO E MAPEADO

O objetivo declarado e' reproduzir o modelo dele. Esta rodada abriu a caixa:
o menu Electron (`app.asar`) foi extraido e mapeado.

## 1. O que existe dentro do pacote

```
C:\...\Shiba_Bots_App\dll\resources\app.asar   9.750.903 bytes
  -> extraido para analysis/shiba_asar/  (79 arquivos)
```

Composicao:
- **renderer/** (17 arquivos, JS minificado mas LEGIVEL): UI
- **shared/** (8 arquivos, legivel): schema, mensagens, walker, alerts
- **lib/** (15 modulos): **todos em .jsc** — bytecode V8 compilado

## 2. A protecao esta declarada no manifesto

`dll/release-manifest.json`:

```json
"protection": { "method": "decision-bytecode-v1",
  "rules": ["Emergency","TargetMinimum","TargetRank","BestTileScore",
            "HoennMinimum","NextTeam","HealWanted","TargetEligible",
            "PathEstimate","PathCost","ComboMoveValid","ComboAck",
            "ComboBuffDone","AlertOnline","AlertMatches","AlertRepeat",
            "AlertSuppressed","CaptureEligible","CaptureBall","CaptureRank",
            "CaptureApproach","CaptureDelay","LureLeadScore","LureCandidate",
            "LureRecovered","HealerTimeout","HealerDeployReady",
            "AlertNearby","AlertTeleport","AlertDue"] },
"electronProtection": { "method": "v8-bytecode-main", "electron": "44.7.2",
                        "bytenode": "1.7.0",
                        "compiled": [ 15 modulos .jsc ] }
```

Ou seja: ele compila o **main process** (decisao) em bytecode e deixa o
**renderer** (UI) em JS. As 30 regras de decisao estao nomeadas ali — e' a
lista do que a logica decide.

## 3. Onde mora a execucao (por modulo)

| modulo | tamanho | papeis inferidos pelas strings |
| :--- | ---: | :--- |
| `pipe-bridge.jsc` | 26.488 | `PipeBridge`, `createConnection`, `COMMANDS`, `encodeCommand`, `decodeAck`, `decodeTelemetry`, `sendFrame`, `createHmac`, `timingSafeEqual`, `suspended` |
| `native-runtime.jsc` | 17.224 | `NativeRuntime`, `boundPid`, `pendingSeq`, `acceptedTick`, `acceptedAck`, `sequence`, `requirePid`, `readPublication` |
| `settings.jsc` | 23.672 | `potionHotkey`, `guildDailyTicketHotkey`, `autoRevive`, `perfectingSkillMask` |
| `walker-profiles.jsc` | 13.048 | `isRoute`, `recordStepDistance` |
| `hotkeys.jsc` | 6.080 | `Hotkeys`, **`virtualKey`**, `pauseHotkey`, `menuHotkey`, `pageup/pagedown` |
| `telemetry.jsc` | 13.256 | decode de telemetria |
| `protocol.jsc` | 9.312 | `COMMANDS`, encode/decode |
| `legacy.jsc` | 18.608 | modo antigo |
| `otmm.jsc` | 5.184 | leitor de mapa (OTMM) |
| `security.jsc` | 8.608 | chave do canal |
| `launch.jsc` | 2.592 | `PKA-INIT-NATIVE` |

`PKA-INIT-NATIVE` e' o marcador de inicializacao do runtime nativo.

## 4. CONFIRMACAO CRITICA: hotkey usa `virtualKey`

`hotkeys.jsc` contem `virtualKey`. Combinado com `potionHotkey`,
`guildDailyTicketHotkey`, `foodHotkey` no schema, isso fecha o modelo:

**hotkey e' tecla virtual de verdade, nao chamada de funcao.** Nao existe
"handler nativo de hotkey" a descobrir — o projeto dele tambem emite tecla.
Isso explica por que nas 329k amostras nao havia hotkey: ele usa quando come
potion/ticket, e as capturas foram de uma sessao sem esses itens.

Isso valida a nossa implementacao atual (`tap_key` + `require_foreground`).
O que ele faz de diferente e' **como** entrega a tecla, e para isso existe
`virtualKey` + as 30 regras de decisao no bytecode.

## 5. Como reconstruir o resto (caminho tecnico)

O bytecode e' V8 12.x (magic `c3 06 de c0`, Electron 44.7.2 / bytenode 1.7.0).
Opcoes, em ordem de custo:

1. **Leitura de strings + estrutura** (feito): 1.227 strings unicas extraidas
   em `analysis/shiba-jsc-strings.txt`. Da' o vocabulario e os nomes de campo.
2. **Descompilar o bytecode**: precisa de um V8 do MESMO major. Ha
   `v8-decompiler`/`v8dasm` e o `bytenode` tem `--decompile`. O ambiente atual
   e' Node 22 / V8 12.4 — o bytecode e' de Electron 44. O caminho pratico e'
   instalar Electron 44.7.2 e usar o V8 dele.
3. **Instrumentacao ao vivo**: injetar um hook no processo do menu e capturar
   as chamadas. Isso da' o comportamento real sem descompilar, mas exige
   rodar o Shiba.

## 6. O que ja' da' para replicar SEM descompilar

- **schema completo** de configuracao (settings.jsc strings + shared/schema.js
  legivel)
- **lista das 30 regras de decisao** (manifesto)
- **contrato de protocolo** (`COMMANDS`, `encodeCommand`, `decodeAck`)
- **modelo de execucao**: menu decide modo -> runtime no processo executa ->
  kind6 publica estado
- **hotkey = virtualKey** (confirmado)

## 7. O que NAO da' para replicar so' com strings

O **corpo** de cada regra: os limiares, a ordem de avaliacao, a formula de
`BestTileScore`, `LureLeadScore`, `PathCost`, `CaptureRank`. Esses numeros
estao no bytecode V8 e exigem descompilacao ou instrumentacao.

Suite: 617 testes, 0 falhas.

---

# ADENDO 8 — 2026-11-11 01:20 — CONFIGURACAO COMPLETA DO SHIBA EXTRAIDA

## 1. O schema e' 100% legivel e foi extraido

`analysis/shiba_asar/shared/schema.js` nao esta compilado. Rodando-o em
sandbox e serializando, sai a **configuracao inteira do bot**, com rotulo,
tipo, default, min/max e descricao em portugues.

```
analysis/shiba-schema.json   137 campos em 8 abas
```

| aba | campos | capability | fonte original (Lua do Shiba) |
| :--- | ---: | :--- | :--- |
| scripts | 1 | lua | `09_ui_scripts.lua` |
| target | 51 | creatures | `05_target.lua / 11_ui_target.lua` |
| healer | 5 | pokemon | `11_ui_target.lua:6239` |
| walker | 14 | map | `07_wk.lua / 12_ui_wk.lua` |
| looting | 6 | items | `13_ui_looting.lua` |
| alerts | 5 | alerts | `17_ui_alerts.lua / 18_alerts_module.lua` |
| hoenn | 37 | pokemon | `15_hoenn_module.lua / 16_ui_hoenn.lua` |
| tools | 18 | hotkeys | `19_tools_module.lua / 20_ui_tools.lua` |

Cada `source` aponta para o modulo Lua de origem — ou seja, a UI Electron e'
uma reimplementacao de um bot Lua anterior. Esse e' o mapa definitivo de
funcionalidades.

## 2. Achado que corrige uma hipotese minha

Eu havia sugerido que `virtualKey` em `hotkeys.jsc` fosse tecla sintetica para
o JOGO. **Nao e'.** As strings do modulo sao accelerators do Electron:

```
^ctrl$   ^cmdorctrl$   ^f([1-9]|1\d|2[0-4])$   home   insert   space
backspace  numlock  scrolllock  printscreen  pageup  pagedown  minus
"Atalhos do menu e da pausa precisam de teclas diferentes."
"MENU" / "PAUSE" / "action" / "actions" / "shortcuts"
```

Defaults: `menuHotkey = "Insert"`, `pauseHotkey = "Home"`. E a descricao do
campo, no schema legivel, confirma:

> "Mostra ou esconde este menu, **com o jogo ou o menu em foco**."

Ou seja: `hotkeys.jsc` = atalhos GLOBAIS do painel, registrados via
`globalShortcut` do Electron. Nada a ver com o jogo.

Conclusao revisada: o Shiba **nao tem um caminho nativo de hotkey para o
jogo**. As hotkeys de jogo (`potionHotkey`, `medicineHotkey`,
`consumableN.hotkey`, `guildDailyTicketHotkey`) sao teclas da action bar,
configuradas pelo usuario — e o executor delas esta no bytecode, nao exposto.

## 3. O modelo de acao confirmado pelo schema

Campos que provam o desenho:

```
target.combo.useNativeSequence    boolean   "Sequencia nativa"
target.combo.usePokeStop          boolean
target.combo.useMedicine          boolean
target.combo.medicineHotkey       text      "Hotkey Medicine"
hoenn.potionHotkey                text      "Hotkey Potion"
hoenn.potionActionBar             number    "Slot antigo de potion (0 desliga)"
walker.guildDailyTicketHotkey     text
tools.consumableN.hotkey          text
```

Duas rotas coexistem, escolhidas por configuracao:

- `useNativeSequence: true` -> sequencia nativa (o caminho de funcao)
- `useNativeSequence: false` -> `!autocombo` por texto no chat

E os itens (potion/medicine/ticket) sao **tecla de action bar** — por isso
`hotkey` existe como configuracao: o usuario define qual tecla.

## 4. Onde mora o que falta

| o que | onde | acessivel? |
| :--- | :--- | :--- |
| 137 campos de config | `shared/schema.js` | **SIM — extraido** |
| nomes das 30 regras | `release-manifest.json` | **SIM** |
| vocabulario de comandos | `lib/protocol.jsc` strings | **SIM — 1.227 strings** |
| contrato de pipe/HMAC | `lib/pipe-bridge.jsc` strings | **SIM — parcial** |
| **corpo das 30 regras** | bytecode V8 | NAO — exige V8 12.x do Electron 44 |
| **executor de tecla do jogo** | bytecode V8 | NAO |
| **formula de BestTile/Lure/Path** | bytecode V8 | NAO |

## 5. Proximo passo tecnico real

Para descompilar o bytecode e' preciso o V8 de Electron 44.7.2 (o bytecode
tem flag hash e checksum que exigem a mesma versao). Opcoes:

1. instalar Electron 44.7.2 e usar `bytenode --decompile` com ele
2. rodar o Shiba com hook no processo do menu e capturar chamadas
3. reconstruir as regras a partir do comportamento (mais lento, mas sem
   depender do V8 dele)

O item 1 e' o mais direto. O item 2 da' o comportamento real. O item 3 e' o que
ja' viemos fazendo com sucesso (walk/attack/combo/talk validados).

Suite: 617 testes, 0 falhas.

---

# ADENDO 9 — 2026-11-11 11:15 — CONFIGURACAO REAL DO SHIBA (LUA PLAINTEXT)

O operador confirmou: o Shiba esta' injetado e rodando agora. Isso permitiu
ir muito alem do bytecode.

## 1. Identidade da build viva

```
jogo        PokeAlliance_dx.exe  pid 14784
              base 0x7ff60ab00000
runtime     msftedit.dll (stomped)  base 0x7ff9d8ad0000  0x328000 bytes
sha256      444524252b597089f995a54f9a56ebca04ed9b5d8346e6d55ed086ffa9406653
              -> dump salvo em dumps/msftedit_live_14784.bin
menu        c52cc5aed5b04f1023e24399c8f30506.exe.tmp  pid 18420
config      %LOCALAPPDATA%\OTPbot\  (59 arquivos .lua, 165 KB)
```

**Build nova**: o sha anterior era `0e27ea77...` (2026-11-04). O dispatcher
mudou de RVA (`0x15280` -> `0x15670`), mas foi reancorado com sucesso pela
sequencia estrutural, nao por RVA fixo:

```
0x015670  mov [rsp+8],rbx ; mov [rsp+0x10],rbp ; push rsi/rdi/r14 ; sub rsp,0x60
0x015682  movzx ebp,dl      ; modo
0x015685  mov   edi,ecx     ; targetId
0x015687  call  0x1def0     ; valida ready
0x015694  mov   r14,[rip+0x210615]   ; tabela (rva 0x225cb0)
0x01569b  lea   edx,[rbp+0x253] ; indice = modo + 0x253
```

Mesma estrutura do doc, enderecos novos. `[0x210623]` = tipo corrente = 7
(combo) no instante da leitura.

## 2. A configuracao e' 100% legivel — nao ha' bytecode nela

O menu grava a configuracao em **Lua plaintext** em `%LOCALAPPDATA%\OTPbot\`.
Copiado para `analysis/shiba-live-config/` (59 arquivos, 165 KB):

| prefixo | arquivos | conteudo |
| :--- | ---: | :--- |
| `wk_` | 35 | rotas: waypoints, safespots, boxes |
| `looting_` | 9 | captura: corpseId -> ballId |
| `target_` | 9 | alvos por perfil de hunt |
| `hoenn_` | 2 | config de time + diagnostico ao vivo |
| `alerts_` | 1 | 8 regras completas, 23 KB |
| `healer_`, `guild_`, `scripts_` | 3 | cura, daily, scripts |

### Rotas reais (contagem de waypoints)

```
wk_torterra.lua        149 wps
wk_xatu.lua            114 wps
wk_crobat.lua          113 wps
wk_digglet.lua          93 wps
wk_Muk.lua              91 wps  |  wk_girafarig 91 | wk_psyquico 87
wk_DONPHAN.lua          86 wps  |  wk_marowak 86
wk_rhydon.lua           81 wps
wk_magmar.lua           68 wps
wk_rhyhorn.lua          65 wps
wk_exegutor.lua         58 wps  |  wk_tangela 58
wk_steelix.lua          54 wps
wk_ELECTABUZZ PRIMAL    48 wps  (6 safespot, 7 box)
wk_ELECTABUZZ FIXED     44 wps  (6 safespot, 6 box)
wk_Feraligatr           38 wps  |  wk_MIMIKYU 38
wk_manectric PRIMAL     36 wps  (5 safespot, 5 box)
wk_Arcanine             31 wps
wk_Pachirisu            25 wps
```

Formato do waypoint (real, de `wk_torterra.lua`):

```lua
{pos={x=688,y=1313,z=7}, action="walk", param=""}
```

Acoes disponiveis: `walk`, `safespot`, `box`, `stairs`, `wait`, `say`
(confirmado no `shared/walker.js` legivel).

## 3. Os limiares que faltavam — todos aqui

`target_tab_config.lua` (combo):

```lua
combo = { enabled=false, sequenceText="m6,m6,m7,m7,m5,m5,m4", stepDelay=450,
          lureDelay=200, finishRemainingCount=2, useNativeSequence=true,
          usePokeStop=false, useMedicine=true, medicineHotkey="E",
          medicineDelayMs=50, perfectingLureEnabled=true,
          perfectingLureHpPercent=50, perfectingLureRange=4,
          bestTileEnabled=true, targetCreaturesEnabled=true }
autoRevive = { enabled=true, interval=400 }
healSkill  = { enabled=true, move="m1", hpPercent=50 }
lureSkill  = { enabled=false, move="m9", hpPercent=90 }
lowHpCombo = { percent=30 }
```

`hoenn_data.lua` (o nucleo do combate em grupo):

```lua
minWildsToEngage=8   forceBox=true   perfectLure=true
perfectLureTimeoutMs=10000   perfectLureMinHp=40
pokeReadyTimeoutMs=3000   comboFallbackMs=3000
bestTileRange=4   bestTileMaxWaitMs=2500   bestTileRetryMs=900
deployToPokestopMs=100   pokestopToComboMs=200
useReadyGate=true   gateReadyPct=60   gateMinHp=80   gateDpsMinHp=90
safeSpotTimeoutMs=15000   potionHpPercent=55   potionCooldownMs=1500
```

`alerts_data.lua` (8 regras, cada uma com 30 campos): tipos `gm_message`,
`chat`, `teleport`, `hunt_pokemon`, `pokemon_capture`, `gm_arrow`, `player`,
`disconnected`. Cada regra tem `pauseWk`, `pauseTarget`, `pauseLooting`,
`talkMsg`, `soundKind`.

## 4. Diagnostico ao vivo que ele mesmo escreve

`hoenn_position_diagnostic.lua` e' reescrito pelo bot com o estado interno:

```lua
phase="casting", status="ultimo combo - aguardando fim", mode="pokemon",
player="2014,5138,7", pokemon="2014,5136,7", idx=3, ring=0,
elapsedMs=8618, noProgressMs=8618, remainingMs=6382, done=true,
blocked=false, preWalking=false, forceBox=true, waypoint=0
```

Esse arquivo e' uma **janela para o estado interno** — se precisarmos
acompanhar o que ele esta' decidindo, e' daqui.

## 5. O que isso fecha

| pergunta | resposta |
| :--- | :--- |
| como ele executa sem foco | runtime no processo, menu so' liga/pausa |
| quais sao os limiares | **todos, em Lua plaintext** |
| como sao as rotas | **35 rotas, ate 149 waypoints** |
| o que vende/como configura | `shared/schema.js` (137 campos) |
| hotkey | tecla de action bar, configurada por nome ("E") |

## 6. O que continua no bytecode (e nao importa para funcionar)

O corpo exato de `BestTileScore`, `LureLeadScore`, `PathCost`. Mas agora temos
os **parametros** de cada uma (`bestTileRange=4`, `bestTileMaxWaitMs=2500`,
`bestTileRetryMs=900`). Com parametros + comportamento observado, a formula
deixa de ser caixa-preta.

Suite: 617 testes, 0 falhas.

---

# ADENDO 10 — 2026-11-11 11:40 — NOSSA ARBITRAGEM vs A DELE (medido)

Comparei o `state-arbiter.cjs` do nosso bot com a maquina de estados real do
Shiba, usando os 37.702 kind6 da captura dele rodando.

Ferramenta nova: `tools/arbiter-compare.cjs`.

## 1. Primeira medicao: 13.8% de acordo. Era erro MEU.

O comparador inicial rotulava Shiba `WALKING` vs nosso `LURING` como
divergencia. Mas sao a MESMA acao (andar agrupando). Corrigi para comparar
por **acao**, nao por rotulo:

```
MOVING   = andar (Shiba travel/walk   <-> nosso WALKING)
GROUPING = parado agrupando (arc/stationary/wait <-> nosso LURING)
COMBAT   = atacar
REVIVING = revive
```

Segunda medicao: 16.4%. Ainda baixo porque `lure=off` (25.983 frames) tem
`count=0` por ausencia de dado, nao por ausencia de monstros — comparar ali
nao informa nada.

## 2. Medicao limpa (so' onde ha' dado: mode=dynamic)

| count/min | ready | acao do Shiba | frames |
| :--- | :--- | :--- | ---: |
| 0/0 | n/a | MOVING | 1.286 |
| 1/8 | nao | MOVING **1.030** · COMBAT 15 | 1.045 |
| 2/8 | nao | MOVING **914** · COMBAT 1 | 915 |
| 3/8 | nao | MOVING **995** · GROUPING 40 | 1.035 |
| 4/8 | nao | MOVING **1.124** · GROUPING 85 | 1.209 |
| 5/8 | nao | MOVING **1.221** · GROUPING 110 | 1.331 |
| 6/8 | nao | MOVING **1.152** · GROUPING 176 · COMBAT 4 | 1.332 |
| 7/8 | nao | MOVING **1.142** · GROUPING 210 · COMBAT 2 | 1.354 |
| **8/8** | **SIM** | **MOVING 1.041** · GROUPING 136 | 1.177 |

## 3. A divergencia real (e ela importa)

**Com `count >= minCount` (lure "pronto" pelo nosso criterio), ele continua
andando em 88% dos frames (1.041 de 1.177).**

Nosso arbitro, na mesma condicao, para e vai para COMBAT/LURING. Essa e' a
diferenca de comportamento mais concreta que a medicao revelou.

Por que ele continua:
- `minWildsToEngage` NAO e' "pare ao atingir". O schema legivel descreve:
  *"O bot so' para e luta quando houver pelo menos esta quantidade deste
  monstro perto do seu Pokemon. Abaixo disso ele continua andando e lurando."*
- Mas o gatilho de parada real e' o **waypoint `box`**, nao a contagem. As
  fases `Perfect lure: n/m confirmando` mostram que ele fica CONFIRMANDO
  formacao, e a contagem oscila (7/9 -> 8/9 -> 9/9 -> 7/10) sem parar.
- Medido: 471 frames em `8/9 confirmando`, 197 em `8/10`, 209 em `7/8` — a
  contagem alvo nao e' fixa, e' **a formacao da box**.

## 4. Segundo achado: `luring.holding` nao significa parado

855 frames com `holding=true`, e em 344 deles a fase ainda e' `Walker · walk`.
Ou seja: `holding` indica que ele esta' segurando a formacao, nao que parou.

## 5. Ciclo de fases dele (maquina de estados real)

```
luring.phase = off        -> lure desligado (25.983 frames = 69%)
luring.phase = travel     -> ANDANDO, count sobe 0 -> 12 (10.864 frames)
luring.phase = arc        -> arco de agrupamento, count ~6.6 (513)
luring.phase = stationary -> parado agrupando, count ~6.2 (327)
luring.phase = wait       -> espera curta (15)
```

E a decisao de combate tem 5 fases proprias:
`Target: procurando alvos` -> `Perfect lure: n/m` -> `Aguartando confirmacao de
PokeStop` -> `Best Tile: posicionando` -> `AutoCombo: aguardando cooldown`.

## 6. O que corrigir no NOSSO arbitro

1. **Nao parar em `count >= minCount`.** Ele so' para quando a formacao na box
   fecha. Nosso `isLureReady` precisa considerar a geometria (quem esta' na
   area do combo), nao so' a contagem.
2. **Grupo `Perfect Lure` separado.** Tem meta propria (`perfectLureMinHp=40`,
   `perfectLureRange=4`, timeout 10.000 ms) e nao e' o mesmo que `minCount`.
3. **`holding` nao e' parada.** Nosso estado nao precisa desse campo.
4. **Ordem de fases validada**: emergency -> revive -> combat -> lure ->
   heal -> walk. A ordem do nosso arbitro esta' correta; o que diverge e' o
   criterio de disparo do combate.

## 7. Veredito

A ESTRUTURA do nosso arbitro esta' certa. O CRITERIO de transicao
WALKING -> COMBAT esta' errado: usamos a contagem, ele usa a formacao na box.

Isso nao e' bug critico (o bot funciona), mas explica por que ele parece
"mais fluido": ele continua a rota enquanto agrupa, e so' para quando vale a
pena. Nosso para cedo.

Suite: 617 testes, 0 falhas.

---

# ADENDO 11 — 2026-11-11 12:00 — CORRECAO IMPLEMENTADA E MEDIDA

## 1. O bug estrutural encontrado no nosso codigo

`botfinal/engines/combat-engine.cjs`, `isLureConditionMet`:

```js
// ANTES
return boxedMonsters.length >= minWilds || candidates.length >= minWilds;
//                                     ^^^^^^^^^^^^^^^^^^^^^^^^ contagem TOTAL
```

O segundo termo usava a contagem total de monstros no alcance do filtro, e era
ele que disparava o combate. Medicao do Shiba: nessa condicao ele continua
ANDANDO em 1.882 de 2.115 frames (89%). Era falso positivo estrutural, nao
limiar mal ajustado.

## 2. O criterio real, medido

Procurando o discriminador nos 37.702 kind6:

```
com count >= minCount:
  holding=true  -> GROUPING  233 frames   (e' quando ele para)
  holding=false -> MOVING  1.882 frames   (ele continua andando)

taxa: holding=true -> GROUPING em 855 de 856 = 99,9%
```

E `holding` transita **com a contagem parada**: `7->7`, `6->6`, `8->8`, `4->4`.
Ou seja: depende de GEOMETRIA (quem colou na box), nao do numero de monstros.

## 3. O que foi alterado

### `botfinal/core/state-arbiter.cjs`

- entrada nova `isFormationHeld` no `evaluate()`
- COMBAT dispara por `isFormationHeld === true || inCombat`
- `isLureReady` deixou de disparar combate (documentado com a medicao)
- `LURING` agora cobre qualquer caso com monstros (o runtime ja' trata como
  "anda sem atacar")

### `botfinal/engines/combat-engine.cjs`

- `isFormationHeld(telemetry, candidates)` — novo: conta apenas quem esta'
  dentro de `perfectingLureRange`, comparando com `minWildsToEngage`
- `isLureConditionMet` — removido o termo `|| candidates.length >= minWilds`
- fallback de range passou de `1` para `4` (valor real do Shiba em
  `hoenn_data.lua`: `bestTileRange=4`)

### `botfinal/core/bot-runtime.cjs`

- calcula `isFormationHeld` e passa ao arbitro

### Testes novos (3)

```
StateArbiter: contagem de lure sozinha NAO dispara combate
StateArbiter: formacao fechada dispara combate mesmo com poucos monstros
StateArbiter: sem isFormationHeld informado, mantem ordem sem quebrar
```

## 4. Medicao depois da correcao

`tools/arbiter-compare.cjs` (corrigido tambem: `LURING` do nosso runtime
significa ANDAR, nao GROUPING — comparar como GROUPING inflava a divergencia
em ~9.000 frames):

| versao | acordo |
| :--- | ---: |
| comparador inicial (rotulo) | 13,8% |
| por acao, antes da correcao | 16,4% |
| por acao + criterio novo + `core.movementOwner` | **53,3%** |

## 5. Por que nao chega a 100% (limite do dado, nao do codigo)

Divergencias restantes:

```
8.169  shiba=COMBAT (lure=off, 0/8) vs nosso=MOVING
1.632  shiba=REVIVING (lure=off, 0/8) vs nosso=MOVING
  196  shiba=COMBAT (lure=travel, 0/8) vs nosso=MOVING
```

Todas com `lure=off` e `count=0`. Quando o lure esta' desligado, o kind6 **nao
publica a contagem de monstros** que o modulo Target usa — ele publica
`luring.count=0` por ausencia de dado, nao por ausencia de monstro. O nosso
comparador alimenta o arbitro com esses zeros e ele conclui "sem monstros".

Ou seja: nesses 9.997 frames nao ha informacao para comparar. O comparador
precisaria do que o modulo Target ve, e isso nao esta' no kind6.

**O limite e' do dado observavel, nao da logica.** Para fechar, seria preciso
instrumentar o modulo Target ao vivo (a janela `hoenn_position_diagnostic.lua`
publica parte disso, mas so' durante o modo pokemon).

## 6. Estado

```
node tools/validate.cjs       617 testes, 0 falhas
botfinal/tests/arbiter        5/5 (2 originais + 3 novos)
botfinal/tests/*              30/30 nos 4 arquivos tocados
```

O criterio de disparo do combate agora corresponde ao medido no Shiba. A
estrutura (emergency -> revive -> combat -> lure -> heal -> walk) ja' estava
correta e nao mudou.

---

# ADENDO 12 — 2026-11-11 12:40 — CICLO FECHADO COM HUNT REAL

Captura de uma hunt **ativa** do Shiba (o operador configurou e iniciou). E'
a primeira vez que temos telemetria e canal de controle reais.

## 1. Captura

```
jogo  PID 17748  native/pka_tap_17748.jsonl   45,3 MB
menu  PID 19228  native/pka_tap_19228.jsonl   15,9 MB
tap   pka_tap.dll corrigido (PkaShutdown), injetado nos dois
```

Composicao do lado do jogo (24.560 registros amostrados):

```
kind 4  (state)      17.107
kind 5  (telemetry)   2.296   <- NUNCA tivemos isso antes
kind 6  (automation)  4.981
kind 11 (control)         2   <- os `start`
kind 12 (lease)         174
kind 9  (manual)          0   <- CONFIRMADO: ele nunca manda comando manual
kind 10 (ack)             0
```

## 2. A PROVA DEFINITIVA do modelo de execucao

Os dois unicos pacotes `kind 11` da sessao inteira:

```json
{"op":"start","module":"target","seq":1, "config":{...8 abas...}}
{"op":"start","module":"walker","seq":2, "config":{...8 abas...}}
```

**Ele liga dois modulos uma vez, e o runtime executa sozinho.** Em 45 MB de
captura nao existe UM comando por passo. `kind 9 manual = 0` e
`kind 10 ack = 0` fecham a questao: o Shiba nao controla o bot passo a passo
pelo pipe. O menu so' envia configuracao e liga/desliga modulos.

## 3. Config real capturada (nao deduzida)

`analysis/kind11-start-target.json` e `-walker.json` — payload completo de
10.301 bytes enviado ao runtime. Diferencas da config em disco:

```
perfectLureMinHp   30  (disco tinha 40)
bestTileRetryMs   700  (disco tinha 900)
potionHotkey      "Alt+f"
medicineHotkey    "E"
gateReadyPct       80  (disco 60)
gateMinHp          90  (disco 80)
shinyRetreatDelayMs 0
```

Ou seja: o operador ajustou no menu e o menu enviou. Isso mostra que a config
viva pode divergir do arquivo `.lua` — o `.lua` e' persistencia, o `kind 11`
e' o que vale.

## 4. Telemetria real (kind 5) — o dado que faltava

49 chaves por frame. Exemplo de `creatures[]`:

```json
[{"id":268442170,"name":"Usobot","type":0,"healthPercent":100,
  "direction":3,"lookType":932,"canAttack":true,"pos":{"x":957,"y":1402,"z":6}},
 {"id":1079574745,"name":"Dugtrio","type":3,"healthPercent":87,
  "lookType":52,"canAttack":false,"pos":{"x":957,"y":1402,"z":6}}]
```

Confirma a convencao medida antes: `type=0` player, `type=3` summon proprio,
`type=1` selvagem.

## 5. Comparacao de arbitragem: 97,3%

Fonte da verdade corrigida em duas etapas:

1. **`core.phase`/`core.movementOwner` estao DESATUALIZADOS.** Em 408 frames
   `core.phase="combat"` enquanto `phases.walker` dizia "Walker · WP 1/23 ·
   walk". A fonte correta e' `phases.target` + `phases.walker`.

2. **`luring.count=0` com `mode=off` NAO e' "sem monstros"** — e' ausencia de
   dado. O numero real esta' dentro de `phases.target` ("Best Tile ... 8/8",
   "Perfect lure 9/10").

Progressao da medicao:

| versao | acordo |
| :--- | ---: |
| por rotulo, tap antigo | 13,8% |
| por acao, criterio novo | 16,4% |
| usou `core` (campo errado) | 53,3% |
| usa `phases.target`, contagem da fase | 78,8% |
| + `isFormationHeld` nos dois modos | 94,2% |
| + revive + precedencia do Dynamic | **97,3%** |

## 6. Precedencia final descoberta

```
DYNAMIC LURE (arc/stationary/wait)  >  fase do Target
```

Medido: 51 frames em que ele estava em `GROUPING` enquanto o Target ja' dizia
"Perfect lure 8/8". Ele fecha a box PRIMEIRO, depois solta o combo. O nosso
arbitro invertia essa ordem.

## 7. O que o `state-arbiter.cjs` precisa (ainda nao implementado)

A correcao do adendo 11 (contagem nao dispara combate) esta' implementada.
Esta rodada mostrou que falta:

1. `isFormationHeld` deve aceitar DOIS sinais: `holding` (dynamic ligado) ou
   fase de combate do Target (lure desligado).
2. Dynamic Lure tem precedencia sobre a fase do Target.
3. `isRevivePending` precisa vir de `phases.target` contendo "revive".

Nao implementei ainda porque sao mudancas de interface do arbitro
(`isFormationHeld` deixaria de ser booleano derivado do lure e passaria a
considerar a fase do Target). Isso muda o contrato com `bot-runtime.cjs` e
merece teste proprio.

Suite: 617 testes, 0 falhas (codigo do bot nao mudou nesta rodada).

---

# ADENDO 13 — 2026-11-11 13:15 — CONTRATO IMPLEMENTADO: 100% DE ACORDO

Os tres ajustes de contrato do adendo 12 foram implementados, e a comparacao
chegou a **100,0% em 6.107 frames reais**.

## 1. Arquivo novo: `botfinal/core/shiba-state-adapter.cjs`

A traducao kind6 -> entradas do arbiter vivia num script de analise
(`tools/arbiter-compare.cjs`). Agora esta' versionada, testada e reusavel.

Codifica os tres achados medidos:

1. `core.phase`/`core.movementOwner` estao DESATUALIZADOS -> fonte e'
   `phases.target` + `phases.walker`
2. `luring.count=0` com `mode=off` e' dado AUSENTE -> contagem real vem de
   `phases.target` ("Perfect lure N/M", "Best Tile N/N")
3. Dynamic Lure (`arc`/`stationary`/`wait`) e' reposicionamento e tem
   PRECEDENCIA sobre a fase do Target

## 2. `state-arbiter.cjs`: precedencia nova

```
1. EMERGENCY_HEAL      HP critico
2. REVIVE              isRevivePending
3. LURING              isRepositioning   <- NOVO, vence o combate
4. COMBAT              isFormationHeld
5. LURING              tem monstros
6. HEALING             fora de combate
7. WALKING             livre
```

E uma correcao semantica importante: **`isFormationHeld` nao exige lista de
alvos.** Formacao fechada implica que ha' monstros. Exigir `validTargets`
junto descartava 908 frames reais em que o payload dizia "Best Tile 8/8" mas
nao trazia a contagem em `luring.count`.

## 3. `combat-engine.cjs`: `isRepositioning()`

Nosso bot **nao implementa Dynamic Lure**. O metodo existe e devolve `false`,
com comentario explicando o que faltaria (waypoints de arco, deteccao de
"quem colou", timeout de formacao). Fingir que implementa seria pior.

## 4. `bot-runtime.cjs`: fallback explicito

```js
const isFormationHeld = typeof this.combat?.isFormationHeld === 'function'
  ? this.combat.isFormationHeld(telemetry, candidates)
  : isLureReady;   // engines substitutos continuam capazes de combater
```

## 5. `validate.cjs` agora roda as DUAS arvores

Antes so' `tests/` era lido. Os 158 testes de `botfinal/tests/` existiam mas
**nunca rodavam na validacao geral**. Agora:

```
antes:   617 testes
depois:  775 testes (617 + 158)
```

## 6. Resultado da comparacao

`tools/arbiter-compare.cjs` reescrito para usar o adaptador de producao (sem
logica duplicada):

```
kind6 amostrados       : 10.720
nao comparaveis        :  4.480  (pausado/offline)
comparaveis            :  6.108
acordo                 :  6.107  (100,0%)
divergencia            :      1  (0,0%)
GROUPING->MOVING       :    132  (fora do veredito: vocabulario)
```

Progressao completa da medicao ao longo da investigacao:

| versao | acordo |
| :--- | ---: |
| por rotulo, tap antigo (2026-11-10) | 13,8% |
| por acao, criterio novo | 16,4% |
| usou `core` (campo errado) | 53,3% |
| usa `phases.target`, contagem da fase | 78,8% |
| + formacao nos dois modos | 94,2% |
| + revive + precedencia Dynamic | 97,3% |
| **adaptador de producao + formacao sem lista** | **100,0%** |

A unica divergencia restante e' um caso de borda: `GROUPING 6/8` contra o
nosso `COMBAT` (o `holding` veio true com contagem abaixo do alvo).

Os 132 `GROUPING->MOVING` ficam FORA do veredito: o nosso runtime usa `LURING`
para "anda sem atacar" e nao tem estado de "parado agrupando". Comparar seria
comparar vocabulario, nao decisao.

## 7. Testes novos (19)

`botfinal/tests/shiba_state_adapter.test.cjs` (12 testes):
- contagem vem da fase quando `luring.count` e' zero
- `luring.count` vale quando o lure esta' em dynamic
- Dynamic parado NAO e' combate, mesmo com Target em 8/8
- revive vem de `phases.target`
- pausado/offline nao sao comparaveis
- `core.phase` desatualizado nao e' usado como fonte
- `countFromPhase` le N/M
- precedencia: reposicionamento vence combate
- precedencia: emergencia e revive vencem reposicionamento
- integracao: 4 casos reais do Shiba reproduzidos

`botfinal/tests/arbiter.test.cjs` (+2): formacao sem lista dispara combate;
`inCombat` sem alvos nao forca combate.

Suite: **775 testes, 0 falhas**.

---

# ADENDO 14 — 2026-11-11 13:45 — DYNAMIC LURE IMPLEMENTADO

O ultimo conceito que faltava no nosso bot: o reposicionamento de agrupamento.
Extraido da captura real, nao inventado.

## 1. O modelo medido (PID 17748, hunt ativa, 6.616 frames dynamic)

| fase | o que faz | duracao mediana | delta de posicao por passo |
| :--- | :--- | ---: | :--- |
| `travel` | anda (rota normal) | 3.672 ms | dx ∈ [-3..3], dy ∈ [-5..5] |
| `arc` | micro-ajuste | **32 ms** | dx ∈ [-1..2], dy ∈ [-1..1] |
| `stationary` | parado agrupando | **234 ms** | 0 |
| `wait` | espera curta | 1.406 ms | 0 |

Transicoes observadas (86 segmentos):

```
travel -> arc   28x      arc -> travel   27x
travel -> stationary 11x  stationary -> travel 11x
travel -> wait   2x       wait -> travel   3x
```

**O ciclo base e' travel com pulsos curtos de ajuste.** Nao e' um desvio de
rota: o `walkerIndex` NAO muda durante arc/stationary (medido: `WP 1/23` antes
e depois). E' ajuste fino de 1-2 tiles em cima da rota.

## 2. `botfinal/engines/dynamic-lure.cjs` (novo)

Implementa a maquina com as **duracoes medidas**, nao com chute:

```js
const MEASURED_MS = { arc: 40, stationary: 240, wait: 1400 };
```

Saidas do `decide()`:

| action | significado |
| :--- | :--- |
| `walk-route` | sem monstros ou sem progresso: segue a rota |
| `adjust-step` | pulso de arco (mexe 1 tile) |
| `hold` | parado no pulso (stationary/wait) |
| `release` | formacao fechou / hp baixo / timeout: solta o combo |
| `none` | lure desligado |

Condicoes de `release` (todas medidas na config dele):

```
boxed >= minWildsToEngage (8)
  OU ownPokemon.hpPercent <= perfectLureMinHp (30)
  OU elapsed >= perfectLureTimeoutMs (10000)
```

E uma protecao: sem progresso por `frontRegroupSteps` (3), volta a andar a
rota em vez de ficar travado agrupando.

## 3. BUG pego pelo teste

Primeira versao escolhia o pulso por `cyclesWithoutProgress % 3`, que
devolvia `arc` de novo quando o pulso anterior tambem era `arc` e o contador
nao mudava. Resultado: preso em `arc` para sempre. O teste
`pulso arc dura ~40ms e depois avanca de fase` falhou e revelou o bug.

Correcao: a escolha compara com a fase ATUAL (`this.phase !== ARC`), entao
sempre alterna.

## 4. Integrado ao combate

`CombatEngine.isRepositioning()` deixou de devolver `false` fixo:

```js
isRepositioning(telemetry) {
  const r = this.lure.decide(telemetry, { now: Date.now() });
  this.lastLure = r;
  if (r.action === 'release' || r.phase === 'off') return false;
  return ['arc','stationary','wait'].includes(r.phase);
}
```

Agora a cadeia inteira funciona: `isRepositioning=true` -> arbiter escolhe
LURING -> walker anda/agrupa -> formacao fecha -> arbiter escolhe COMBAT.

## 5. Validacao contra a captura real

Rodando o nosso `DynamicLure` sobre os 7.671 frames em que havia telemetria
(posicao do player + do pokemon) e luring dynamic simultaneamente:

```
acordo de FASE: 7.513/7.671 = 97,9%

matriz:
  7.495  nosso=TRAVEL   shiba=TRAVEL
    146  nosso=TRAVEL   shiba=PULSE     <- ele pulsa, nos andamos
     18  nosso=PULSE    shiba=PULSE
     11  nosso=PULSE    shiba=TRAVEL    <- nos pulsamdo, ele anda
      1  nosso=TRAVEL   shiba=observe
```

A divergencia dominante (146) e' um pulso dele que nos nao disparamos. Faz
sentido: o gatilho exato do pulso depende de geometria que o kind6 nao publica
(quais monstros estao por onde). O `holding` do payload nao basta.

## 6. Testes

`botfinal/tests/dynamic_lure.test.cjs` — 11 testes:
- lure desligado -> OFF
- sem monstros -> travel (segue rota)
- formacao fechada -> release
- monstros fora do alcance nao contam para a box
- hp baixo -> release
- timeout de formacao -> release
- pulso arc dura ~40ms e avanca de fase
- sem progresso -> volta para a rota
- progresso reseta estagnacao
- chebyshev correto (maior eixo, z diferente = infinito)
- **as duracoes sao as medidas na captura** (trava contra mudanca sem medicao)

Suite: **786 testes, 0 falhas** (617 da raiz + 169 do botfinal).
