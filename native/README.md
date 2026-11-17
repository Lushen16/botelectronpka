# pka_native — servidor do canal nativo

DLL que **substitui o runtime do fornecedor** dentro do `PokeAlliance_dx.exe`:
cria o named pipe, faz o handshake HMAC e publica state/telemetry lendo a
memória do próprio processo.

A DLL deles não é um cliente — é o **servidor** do pipe. Sem ela o pipe não
existe, e é por isso que "cliente nativo" nunca funcionou sozinho.

## Arquivos

| Arquivo | O que é |
| :--- | :--- |
| `pka_native.c` | fonte da DLL (canal + scanner + executor) |
| `pka_native.dll` | 198 KB, x64, compilada com zig cc |
| `pka_inject.c` | injetor `CreateRemoteThread` + `LoadLibraryA` |
| `pka_inject.exe` | injetor compilado |
| `pka_native_host.c` | carrega a DLL fora do jogo (modo prova) |
| `pka_host.exe` | host compilado |
| `pka_window_target.c` | alvo de teste com janela que conta teclas |
| `pka_window_target.exe` | alvo compilado |

## Build

Sem MSVC. Usa zig (clang 21) cross-compilando para `x86_64-windows-gnu`:

```cmd
python -m pip install ziglang
node tools\build_native.cjs
```

## Contrato implementado

```
quadro   [u32 len][u32 kind][payload]     MAX_FRAME 2105344
kinds    1 challenge  2 authenticate  3 welcome  4 state
         5 telemetry  8 revoked  9 manual  10 ack

challenge    nonce 32 bytes
authenticate HMAC-SHA256(key, "PKA2/client\0" + nonce + u32le(pid))
welcome      u32le(pid) + HMAC-SHA256(key, "PKA2/server\0" + nonce + u32le(pid))
state        48 bytes
ack          12 bytes (id, tipo, status)
```

O domínio **inclui o NUL**: `"PKA2/client"` = 11 chars + NUL = 12 bytes. Usar
`strlen()` dá 11 e o HMAC não confere — foi o primeiro bug pego no e2e.

### state, 48 bytes (layout corrigido por captura real)

Confirmado em 18.492 amostras do canal oficial (`native/pka_tap_10244.jsonl`):

| off | tipo | campo | observação |
| :-- | :--- | :---- | :--------- |
| +0 | u32 | `version` | **contador**, não versão (148136953..149316578) |
| +4 | u32 | `isOnline` | 0/1 |
| +8 | u32 | `healthPercent` | 0..100 |
| +12 | f64 | `hp` | **-1 = sem leitura** (não 0) |
| +20 | f64 | `mana` | -1 = sem leitura |
| +28 | f64 | `cap` | |
| +36 | u32 | `targetId` | |
| +40 | u32 | `attackSeqNum` | |
| +44 | u32 | `protoVersion` | **854**, não 1 |

Dois valores do decoder antigo eram inventados: `version:1` e `protoVersion:1`
nunca vieram do servidor. O nome `version` foi mantido porque o vetor
diferencial do módulo original usa esse nome (`tick` é alias não-enumerável).

## Chave

Um processo já em execução não recebe variável de ambiente. A DLL procura:

1. `PKA_CHANNEL_KEY` no ambiente do alvo
2. `PKA_CHANNEL_KEY_FILE` no ambiente do alvo
3. **`pka_channel_key.txt` ao lado da DLL** ← caminho normal na injeção
4. `%TEMP%\pka_channel_key.txt`

Sem chave a DLL **não cria o pipe** (não inventa canal).

## Nome do jogador

O scanner de `find_player()` procura o nome do personagem. Um processo já
rodando também não herda `PKA_PLAYER_NAME`, então a DLL busca:

1. `PKA_PLAYER_NAME` no ambiente do alvo
2. **`pka_player_name.txt` ao lado da DLL** ← caminho normal na injeção
3. `%TEMP%\pka_player_name.txt`

Sem nome configurado o canal funciona, mas `state` fica `online=false hp=0` e
`telemetry.playerName` sai vazio — não é falha de handshake, é ausência de
identidade. Grave o nick no arquivo antes de injetar.

## Leitura in-process

`find_player()` roda **dentro** do jogo, então `g_proc` é NULL e
`ReadProcessMemory` não existe. O walk usa `GetCurrentProcess()` +
`VirtualQueryEx` e copia direto da própria memória. Sem isso o scanner morria
na primeira região e o estado nunca saía de `online=false`.

## Execução de comandos

| Opcode | Nome | Como executa | Status |
| :--- | :--- | :--- | :--- |
| 1 | walk 0..7 | `PostMessageW` seta na janela | 0 = entregue |
| 20 | hotkey | `PostMessageW` VK (F1-F12, A-Z, 0-9, setas) | 0 = entregue |
| 2 | attack | precisa do dispatcher nativo | 3 |
| 6, 7 | talk, combo | precisa do dispatcher nativo | 3 |
| outros | — | precisa do dispatcher nativo | 3 |

O payload de `hotkey` é `[24 bytes fixos][texto utf8]` — o texto começa no
offset **24**, não no 12. `protocol.cjs` monta `Buffer.concat([bytes(24), text])`;
ler em 12 pega `uuidHash`/`expectedAction` e devolve `status 1` (comando
inválido). `walk` lê a direção em 8, que é o offset certo do parâmetro numérico.

`status 3` é o código do próprio protocolo ("Funções do jogo indisponíveis").
Não fingimos sucesso onde não há implementação.

`status 0` significa **tecla entregue na janela**, não que o jogo reagiu.
`effectVerified` continua `false` em todo registro.

## Uso

### 1. Prova de handshake (sem jogo)

Sobe a DLL em modo host com PID falso, e conecta com o cliente real do botfinal:

```cmd
node tools\native_e2e.cjs
```

### 2. Prova de injeção (processo controlado)

Injeta num `cmd.exe` próprio, verifica módulo carregado, pipe criado e handshake:

```cmd
node tools\native_inject_test.cjs
```

### 3. Prova de execução (tecla chega na janela)

Alvo com janela real que conta WM_KEYDOWN/WM_KEYUP:

```cmd
node tools\native_exec_test.cjs
```

### 4. No jogo real

```cmd
:: 1. chave do canal (capture antes de fechar o menu, ou use a sua)
python tools\find_channel_key.py --auto --write captures\channel-key.json

:: 2. grave a chave ao lado da DLL
copy /Y captures\channel-key.json native\pka_channel_key.txt

:: 3. com o jogo aberto, injete
native\pka_inject.exe --name PokeAlliance_dx.exe --dll native\pka_native.dll

:: 4. confirme o canal
cd botfinal
node index.cjs --transport=native --probe --key-file ..\native\pka_channel_key.txt
```

Para esperar o jogo subir (útil quando a injeção precisa acontecer no boot):

```cmd
native\pka_inject.exe --name PokeAlliance_dx.exe --wait --dll native\pka_native.dll
```

## Estado de verificação (2026-11-03)

Executado nesta máquina, com os binários deste diretório:

| Teste | Resultado |
| :--- | :--- |
| `native_e2e.cjs` (host mode) | **7/7** — handshake, state, telemetry, ACK |
| `native_inject_test.cjs` | **9/9** — injeção, módulo listado, pipe, handshake |
| `native_exec_test.cjs` | **12/12** — walk e hotkey com `status 0`, `keyDown=3 keyUp=4 lastVk=0x74` |
| probe do `botfinal` contra a DLL | `autenticado: true`, `resultado: OK` |
| **canal no jogo real** (PID 22260) | `autenticado: true`, `online:1`, `hp:100`, `pos:{3321,2050,7}` |

O canal nativo foi provado no `PokeAlliance_dx.exe` real: handshake HMAC,
state com HP/online e telemetria com nome e posição verdadeiros.

O que **não** foi provado: efeito de comando no jogo. `walk` retorna `status 0`
(tecla entregue ao `PostMessageW`) mas o personagem não se moveu nos testes —
o alvo estava em tela sem entidade (zero instâncias do vtable de LocalPlayer).
Falta um teste com o personagem visível e livre no mapa.

## Limites conhecidos

- **Localização do jogador:** usa o vtable do `LocalPlayer` em RVA constante
  `0x1FAC310` (varre as regiões legíveis por um qword igual a
  `moduleBase+RVA`). Deu exatamente 1 instância no jogo real e o VA bateu com o
  scanner Python. A varredura por nome existe como último recurso e só roda
  quando o módulo do jogo está presente — sem isso ela acharia strings soltas e
  devolveria VA inválido (foi um bug real, corrigido).
- **`DEFAULT_CHAINS` do Python estão quebradas** neste build: `0x392E9C0`
  devolve `0x3bc63abd39aba59b` e as outras nem resolvem. O próprio
  `pka_live_session.py` cai no fallback `locate_by_name`. A DLL mantém as
  cadeias por compatibilidade, mas a fonte é o vtable.
- **Criaturas:** `creatures` sai sempre vazio. Falta o walk de RTTI
  (`Monster`/`Creature` vtable → instâncias) dentro do C.
- **attack/talk/combo:** dependem do RVA do dispatcher nativo (`0x12c40`
  segundo o dump, não confirmado neste build). Por isso respondem `status 3`.
- **Assinatura:** a DLL não é assinada. O Defender apaga o `pka_inject.exe`
  (ThreatID 2147731250). Adicione `native\` às exclusões antes de compilar.
- **Modo host** não tem janela do jogo: `walk`/`hotkey` respondem `status 3`.

## Footgun

`pka_inject.exe` faz injeção clássica (`CreateRemoteThread` + `LoadLibraryA`),
que aparece na lista de módulos do alvo. Rode com o jogo já estabilizado, e
adicione `native\` às exclusões do Defender antes de compilar — senão o injetor
é apagado no meio do build.
