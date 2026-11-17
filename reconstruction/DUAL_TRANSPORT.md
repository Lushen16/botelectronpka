# Dual-Transport — native e mock

## Por que

O canal nativo depende de um runtime que hoje está bloqueado por um problema do
fornecedor (catálogo anuncia 3.3.0, binário ainda reporta 3.2.9, API recusa
login). Para não parar o desenvolvimento nem tocar em binário de autenticação
de terceiros, o `botfinal` passou a ter dois transportes com a **mesma API**.

```cmd
node index.cjs --transport=native --pid <pid> --key-file captures\channel-key.json
node index.cjs --transport=mock   --pid 45000
```

Estado do protocolo exposto pela configuração:

```cmd
node index.cjs --version
{"configSchema":2,"pulseVersion":3,"transport":null}
```

## Camada de transporte (`botfinal/core/pipe-transport.cjs`)

| Classe | Uso | Handshake |
| :--- | :--- | :--- |
| `NativeTransport` | canal real do jogo | HMAC-SHA256 nos dois sentidos (`reconstruction/transport.cjs`) |
| `MockTransport` | servidor local simulado | mesmo handshake, mesma chave, mesmo pipe |

Ambos expõem `connect()`, `close()`, `sendCommand(name, param, options)` e os
eventos `state` / `telemetry` / `ack` / `error` / `close`. Nenhum motor sabe
qual está embaixo.

`classify(error)` traduz o resultado do canal em cinco categorias, todas vistas
em campo:

| Categoria | Origem real |
| :--- | :--- |
| `busy` | `EAGAIN`, `EBUSY`, "Handshake expirou" — menu segura a instância |
| `orphaned` | `EPIPE`, `ECONNRESET`, 233 — instância condenada após o menu sair |
| `missing` | `ENOENT` — jogo não injetado ou PID errado |
| `bad-key` | prova do servidor não confere |
| `unknown` | resto |

## `--probe`

Conecta, espera `state` + `telemetry` e **não envia comando**. Sai com código 0
só quando recebeu os dois. Relatório:

```text
[probe] transporte      : mock
[probe] pid             : 46200
[probe] autenticado     : true
[probe] tempo           : 139 ms
[probe] state           : online=true hp=100 targets=0
[probe] telemetria      : tick=1 jogador="MockTrainer" pos={"x":100,"y":100,"z":7}
[probe] criaturas       : 4 pet=Charizard
[probe] resultado       : OK
```

Falha classificada, sem stack trace:

```text
[probe] falha           : missing (ENOENT)
[probe] detalhe         : connect ENOENT \\.\pipe\pka-runtime-2-99999
[probe] leitura         : Pipe inexistente: o jogo nao esta injetado ou o PID esta errado.
[probe] resultado       : FALHOU (missing)
```

## Servidor mock (`tools/mock_game_pipe.cjs`)

Cria `\\.\pipe\pka-runtime-2-<pid>` com o ciclo de vida do runtime real:
challenge → authenticate → welcome, `state` de 48 bytes e `telemetry` JSON a
cada 100 ms, `ack` para cada comando, e **recusa a segunda conexão**
(`maxInstances=1`, como o original).

O mundo simulado reage de verdade:

| Comando | Efeito |
| :--- | :--- |
| `walk` | move o jogador na direção (0..3) |
| `attack` | fixa `targetId` e incrementa `attackSeq` |
| `talk` / `combo` | registra a skill e tira 10% de HP do alvo |
| `stop` | para o movimento |
| `potion` | cura 20 |
| direção > 7 | ACK com status 1 (recusado) |

O jogador também toma dano periodicamente, para o healer ter o que fazer.

CLI:

```cmd
node tools/mock_game_pipe.cjs --pid 45000 --key mock-channel-key-000000000000 --seconds 60
```

## Validação E2E

`tools/mock_e2e.cjs` acopla o runtime real (arbiter + engines + dispatcher) ao
mock e executa três fases:

| Fase | Verificação |
| :--- | :--- |
| 1 — sem monstros | `WALKING` aparece, walker anda, posição muda 100→106 |
| 2 — com monstros | `COMBAT` preempta, mira por id, skill sai, alvo 100→80 HP |
| 3 — API | `attack` aceito, `talk` aceito, direção inválida recusada |

Resultado: **14/14**, estados vistos `IDLE, WALKING, COMBAT`.

Reproduzir:

```cmd
node tools/mock_e2e.cjs --seconds=4
```

## Testes automatizados

`botfinal/tests/transport_modes.test.cjs` (9 casos) cobre: modos válidos,
handshake idêntico, comando+ACK, movimento, dano por skill, recusa de segunda
conexão, probe OK, probe com falha classificada e o mapa de `classify` com os
erros reais de campo.

Suíte do botfinal: **50 testes, 50 passando**.

```cmd
cd botfinal
node --test tests/*.test.cjs
```

## O que isto prova e o que não prova

Prova: a pilha transporte → sessão → runtime → engines funciona de ponta a
ponta, com o protocolo exato do runtime, sem travar.

Não prova: nada sobre o cliente real. O mock é um `RuntimeServer` nosso, não a
DLL do jogo. O canal nativo continua **não provado** — o runtime real devolve
233 nesta build, independentemente do transporte.

## Troca quando a Shiba publicar a 3.3.0

1. Instalar a versão oficial pelo launcher.
2. Abrir jogo e menu, e capturar a chave:
   `python tools/find_channel_key.py --auto --write captures/channel-key.json`
3. Rodar `node index.cjs --transport=native --pid <pid> --key-file captures/channel-key.json --probe`

Se o probe voltar `OK`, o canal está provado e os motores ligam sem mudança de
código — é a mesma interface que o mock já exercita.
