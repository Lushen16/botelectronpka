# Canal nativo — evidência de 2026-11-02/03

## O que foi observado

Injeção feita pelo usuário, capturada pelo watcher em
`captures/injection-2026-11-02T19-45-35/`:

- `PokeAlliance_dx.exe` PID 23152, iniciado 20:02:17.
- `msftedit.dll` carregado em `0x7ffd09bc0000`, 3309568 bytes (0x328000).
- Pipes `pka-runtime-2-23152` e `pka-security-23152` criados.
- Menu Electron PID 17908, `...\dll\c31df7063cd2f1b41aad733fb9177f5a.exe.tmp`,
  com `--client-pid=23152`.
- Dump de memória do módulo: `memory-23152-200243/` (3 regiões, 270 KB).

## Chave do canal

`PKA_CHANNEL_KEY` **não existe no bloco de ambiente** de nenhum processo
verificado: 23152 (jogo), 13656 (launcher), 17908 (menu), 23052, 6564, 25340
(renderer/GPU/network do menu) e 5192 (PKAengine) — todos sem a variável.

O valor `4cf1efb6b1939579d5c3868138c28ffa` aparece como literal
`PKA_CHANNEL_KEY=<valor>` no heap do menu (VA `0x1d38f545141`) e também no heap
do jogo (VA `0x1d63023fa90`, na região `0x1d6301c6000`), ao lado do
identificador alfanumérico do pipe (`L.R.P.C.-.c.5.7.0.d.6.1.a.c.e.0.6.d.f.5.0.9.a`,
que é `RP C- c570d61ace06df509a` em UTF-16 intercalado). `tools/find_channel_key.py`
reproduz a extração do heap do menu, read-only.

## Handshake: não provado

Sequência real depois de fechar o menu:

1. `CreateFileW` READ e RW passaram a abrir com sucesso.
2. `GetNamedPipeInfo`: `maxInstances=1` nos dois pipes.
3. `PeekNamedPipe` retorna sucesso com `avail=0`.
4. `ReadFile` retorna `ERROR_PIPE_NOT_CONNECTED` (233) imediatamente, sempre.
5. 15 tentativas espaçadas de 1 s: mesma resposta em todas.
6. Pelo Node: `ERROR_PIPE_BUSY` (231) com o menu aberto; `EPIPE` com o menu
   fechado.

Conclusão: a instância existe, mas o servidor não aceita conexão. O runtime
continua carregado — duas threads têm `Win32StartAddress` dentro do
`msftedit.dll` (`0x7ffd09c91a90` e `0x7ffd09bd0d30`) e o código do módulo está
estável entre leituras (`sha256 4da97af30668951f...`). Isso não prova que o
worker do pipe esteja atendendo; prova apenas que o módulo não foi descarregado.

Nenhum `challenge`, `welcome`, `state` ou `telemetry` foi recebido do runtime
real. **A autenticação no cliente real não foi demonstrada.**

## O defeito que impedia o botfinal

`botfinal/core/pipe-transport.cjs` enviava comandos no quadro `authenticate`
(kind 2). O runtime só aceita comandos em `manual` (kind 9). Contra o servidor
de fixture, antes da correção: `Timeout aguardando ACK`, zero quadros recebidos
pelo servidor. Depois: ACK `status=0`, quadro `kind=9`, opcode correto.

O arquivo agora é um adaptador fino de `reconstruction/transport.cjs`, que já
tinha a prova HMAC validada nos dois sentidos. Verificação diferencial contra o
bytecode original: o `proof` do original monta `"PKA2/" + dominio + "\0"`; o
nosso `PKA2/client\0` produz o mesmo digest
(`3a769cb645b567d1a57613e9530f2a85...`) para a mesma chave, nonce e PID.

## O que foi montado

- `core/native-session.cjs` — snapshot a partir de `state` + `telemetry`, com
  `ageMs`, sem preencher campo ausente.
- `core/command-dispatcher.cjs` — tradução dos motores para o protocolo,
  exigência de snapshot fresco, `inputAccepted` vs `effectVerified`.
- `core/bot-runtime.cjs` — um tick, um comando.
- `index.cjs` — canal nativo primeiro, `--rpm` explícito como fallback.
- `engines/combat-engine.cjs` — corrigido para um comando por tick e para
  propagar o código de erro.

38 testes do botfinal passam (`node --test tests/*.test.cjs`), incluindo a
pilha completa `PipeTransport → NativeSession → CommandDispatcher → BotRuntime`
contra `reconstruction/runtime-server.cjs`.

## Limites

- Nenhum ataque, cura, movimento ou captura foi executado no jogo.
- `effectVerified` permanece `false` em todo registro.
- O servidor de fixture é reconstruído, não o runtime original.
- Pipe órfão nesta sessão: reinjetar é necessário para testar o canal real.
- 72 literais JSON do runtime (`inspection`, `performance`, `session_id`,
  `hwnd`, `instanceEntry`, ...) não são modelados; captura e Hoenn dependem deles.

## Segunda injeção (2026-11-03)

Reinjeção feita pelo usuário: jogo PID **26596**, menu PID 9192
(`33d1d2059b3693082de2ddf8dbf48c88.exe.tmp --client-pid=26596`), pipes
`pka-runtime-2-26596` e `pka-security-26596`.

Chave desta injeção: `45d9b2b308059ad199ac05b56532efc5`, recuperada do heap do
menu (VA `0x1ffc9e05100`) e confirmada no heap do jogo (VA `0x211f4391b40`).
Dump do módulo desta injeção: `captures/keydump/payload-26596.bin`
(`msftedit.dll` em `0x7ffd09bc0000`, 0x328000 bytes — mesmo tamanho da anterior).

### O que o teste mostrou

| Momento | Menu aberto | Menu fechado |
| :--- | :--- | :--- |
| `CreateFileW` READ | 231 BUSY | **abre** |
| `CreateFileW` RW | 231 BUSY | **abre** |
| `PeekNamedPipe` | — | sucesso, `avail=0` |
| `ReadFile` | — | **233 NOT_CONNECTED**, imediato |

Corrida (`tools/race_probe.py`, 5 ms entre tentativas): **ganhou a instância na
primeira tentativa** e leu 233. `probe_hold.py` (handle único, sem reabrir):
mesmo 233. Os dois pipes ao mesmo tempo (`pipe_dual_watch.py`): 233 nos dois.

O runtime está carregado e parado: duas threads com `Win32StartAddress` dentro
do `msftedit.dll` (`0x7ffd09c91a90`, `0x7ffd09bd0d30`), **0,00 ms de CPU em 2 s**
nas duas. Nenhum objeto `Local\PKA.Session.2.<pid>` existe (22 nomes × 3 tipos,
zero encontrados).

### O que isso significa

O 233 é devolvido na primeira leitura de um handle recém-aberto, sem espera.
Isso é o comportamento de `DisconnectNamedPipe` do lado servidor, não de um
servidor que nunca aceitou. O módulo importa `GetNamedPipeClientProcessId`, o que
lhe permite olhar quem conectou, e contém a mensagem
"Sessão não autorizada pela DLL." — ou seja, ele tem como recusar o cliente.

Conclusão: **o runtime não re-arma depois que o menu original cai.** A instância
que sobra está condenada, e qualquer cliente que a pegue recebe 233. Testar o
canal no jogo exige que o botfinal conecte **antes ou no lugar do menu**, na
mesma sessão de injeção.

### O probe está correto

`node tools/verify_race_probe.cjs` sobe o `RuntimeServer` reconstruído, disputa a
instância e fecha o handshake:

```
WON the instance after 1 attempts
CHALLENGE bytes=32 nonce=0505...05
AUTHENTICATE sent proof=ececd626...
WELCOME pid=64292 MATCH=True
RESULT AUTHENTICATED
```

Então a ferramenta fecha handshake quando o servidor atende. O que falha é o
runtime nesta sessão, não o cliente.

### Próximo teste, o único que falta

1. Fechar jogo e menu.
2. Iniciar `python tools/race_probe.py --key <chave> --seconds 600` **antes** de
   disparar a injeção/menu, para que ele ganhe a instância assim que o pipe
   nascer.
3. Observar se vem `CHALLENGE`/`WELCOME`. Se vier, o canal está provado. Se der
   233 mesmo ganhando a corrida, o runtime exige um cliente específico
   (`GetNamedPipeClientProcessId`) e o caminho é substituir o menu, não competir
   com ele.

