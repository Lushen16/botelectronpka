# Bot Final — canal nativo do PokeAlliance

Reconstrução do fluxo do Shiba Bots v3.2.9 sobre o canal nativo
(`\\.\pipe\pka-runtime-2-<pid>`), com HMAC-SHA256. Tudo aqui é derivado de
bytecode e de memória observada; nada foi validado em combate real.

## Estado real (2026-11-02)

Verificações feitas nesta máquina, com injeção ativa:

| Item | Observado |
| :--- | :--- |
| Jogo | `PokeAlliance_dx.exe` PID 23152 |
| Módulo stomped | `msftedit.dll` base `0x7ffd09bc0000`, 0x328000 bytes |
| Pipes | `pka-runtime-2-23152`, `pka-security-23152` |
| Instâncias | `maxInstances=1` nos dois |
| Chave | recuperada da memória do menu e confirmada no heap do jogo |
| Handshake | **não validado**: o pipe abre mas o servidor devolve `EPIPE`/233 |

O runtime nativo continua carregado (duas threads começam dentro de
`msftedit.dll`), mas o servidor do pipe não aceita conexão nesta sessão. O canal
não foi provado. Não existe, neste repositório, nenhuma execução de ataque,
cura, movimento ou captura pelo canal nativo.

## O que este módulo faz

- `core/pipe-transport.cjs` — adaptador do transporte provado
  (`reconstruction/transport.cjs`): handshake HMAC-SHA256 nos dois sentidos,
  comandos no quadro `manual` (kind 9). Classifica `busy` e `orphaned`.
- `core/native-session.cjs` — junta os quadros `state` e `telemetry` num
  snapshot com `ageMs`, sem inventar campos ausentes.
- `core/command-dispatcher.cjs` — traduz o vocabulário dos motores para o
  protocolo, exige snapshot fresco e registra `inputAccepted`/`effectVerified`.
- `core/bot-runtime.cjs` — um tick: snapshot → árbitro → um comando.
- `core/state-arbiter.cjs` — hierarquia cura emergencial → revive → combate →
  lure → cura → caminhada.
- `core/kind11-codec.cjs` — envelopes do kind 11/12, sem depender de
  `research/`. Reproduz byte a byte os 20 frames capturados do fornecedor
  (`tests/kind11_golden.test.cjs`). Config base em
  `config/kind11/target-config.json`.
- `core/automation-control.cjs` — canal kind 11 com estados explícitos. Aprende
  o `boot` do kind 6 da sessão; nunca reporta `effect: true` (kind 11 não tem ACK).
- `core/control-bridge.cjs` — ponte que liga o controle aos motores próprios:
  valida a config, propaga para os quatro motores e arma/desarma o runtime.
- `engines/` — combate (target lock por id), walker (waypoints) e healer.

`index.cjs` tenta o canal nativo primeiro e só usa RPM/PostMessage com `--rpm`
explícito.

## O que `--auto` (kind 11) NÃO faz

`automation_apply()` na DLL só copia campos para quatro flags e as publica no
kind 6. **`modules: ["target"]` não inicia motor, `monitor.enabled: true` não
liga monitor e `stop` não interrompe ação.** Kind 11 é a superfície de
compatibilidade com o menu do fornecedor; não é o controle do nosso bot.

Quem arma os motores é `--start`, via `ControlBridge`:

```cmd
node index.cjs --pid <pid> --key-file <key.json> --start=walker
node index.cjs --pid <pid> --key-file <key.json> --walk=north --walk-steps=1
```

`--walk` exercita a cadeia inteira e reporta `effectObserved` separado de ACK:
só é `true` quando a posição no snapshot muda.

## kind 11 (`--auto`)

Um comando por execução, e sai. O kind 11 não tem ACK: o relatório mostra
`sent` e `effect: "unverified"`. Efeito só se confirma no kind 6.

```cmd
node index.cjs --pid 23152 --key-file ..\captures\channel-key.json ^
  --auto=start:target --auto-require-boot --auto-boot-wait 2000
```

`--auto=start:target|stop:walker|monitor:on|pause:off`,
`--auto-lease` (manda kind 12 antes, como o menu faz),
`--auto-require-boot` (recusa sem `boot` de sessão),
`--no-engine` (segura o canal sem despachar kind 9).

## Como rodar

```cmd
cd botfinal
node index.cjs --pid 23152 --key-file ..\captures\channel-key.json
```

Só conferir o canal, sem enviar comando:

```cmd
node index.cjs --pid 23152 --key-file ..\captures\channel-key.json --probe
```

Fallback (outra arquitetura, sem canal nativo):

```cmd
node index.cjs --pid 23152 --rpm
```

Capturar a chave quando o menu original estiver aberto:

```cmd
python tools/find_channel_key.py --auto --write captures/channel-key.json
```

## O que falta para fechar o canal

1. Fechar jogo e menu, reiniciar a injeção do zero com o watcher ligado.
2. No instante em que `pka-runtime-2-<pid>` aparecer, rodar `--probe`.
3. Comparar o `state` recebido com `reconstruction/protocol.cjs` (48 bytes) e a
   telemetria com `reconstruction/telemetry.cjs`.

## Limites conhecidos

- `effectVerified` é sempre `false`: aceite do transporte não é efeito no jogo.
- `maxInstances=1`: o menu original e o botfinal não podem usar o canal juntos.
- 72 literais JSON do runtime (ex.: `inspection`, `performance`, `hwnd`,
  `session_id`) ainda não são modelados; módulos de captura/Hoenn dependem deles.
- A chave é por sessão de injeção; reinjetar invalida a anterior.

## Testes

```cmd
cd botfinal
node --test tests/*.test.cjs
```
