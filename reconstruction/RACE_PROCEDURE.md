# Corrida pelo canal nativo — procedimento

## Por que existe

O pipe `\\.\pipe\pka-runtime-2-<pid>` tem `maxInstances=1`. Quem conecta primeiro
fica com ele. O menu Electron (PKA Tools) conecta ao subir, e depois que ele cai
a instância que sobra devolve `ERROR_PIPE_NOT_CONNECTED` (233) para sempre — o
runtime não re-arma.

Consequência prática: para o botfinal usar o canal, ele tem de pegar a instância
**antes ou no lugar do menu**, na mesma sessão de injeção.

## Ferramenta

`tools/race_probe.py` disputa a instância a cada 5 ms, ganha, segura o handle e
faz o handshake HMAC. Não envia comando de jogo: só o quadro `authenticate`.

A chave não existe antes da injeção, então o probe usa `--key-later`: ele abre e
segura **sem chave**, imprime o `CHALLENGE` quando chegar, e autentica na mesma
conexão assim que o arquivo de chave aparecer.

## Procedimento

Terminal 1 — deixe rodando:

```
python tools/race_probe.py --key-later --key-file captures/channel-key.json --seconds 900
```

Ou simplesmente `tools\RACE_PROBE.bat`.

Terminal 2 — quando a injeção estiver feita, capture a chave:

```
python tools/find_channel_key.py --auto --write captures/channel-key.json
```

O probe detecta o arquivo, autentica e imprime:

```
CHALLENGE bytes=32 nonce=...
KEY loaded from captures\channel-key.json
AUTHENTICATE sent (late key) proof=...
WELCOME pid=... MATCH=True
RESULT AUTHENTICATED
```

## Resultados possíveis

| Saída | Significado |
| :--- | :--- |
| `RESULT AUTHENTICATED` | canal provado nesta sessão. Aí sim dá para ligar os motores. |
| `instance already orphaned (233)` antes de qualquer challenge | esta injeção já perdeu o servidor. Reinjete. |
| `RESULT CHALLENGE_WITHOUT_KEY` | servidor atendeu, mas não foi passado `--key-file`. |
| `RESULT NEVER_WON` | outro cliente ficou com a instância o tempo todo. |
| `WELCOME ... MATCH=False` | servidor respondeu com prova de outra chave: a chave capturada não é desta sessão. |

## Verificação da ferramenta

```
node tools/verify_race_probe.cjs      # handshake com chave conhecida
node tools/verify_key_later.cjs       # --key-later: corrida antes, chave depois
```

Os dois sobem o `RuntimeServer` reconstruído. Ambos passam. Isso prova que o
probe fecha handshake quando o servidor atende; o que falhou no jogo foi o
runtime desta sessão, não o cliente.

## Estado em 2026-11-03

Na injeção do PID 26596, o menu (9192) subiu primeiro e pegou a instância.
Depois que ele saiu, todo cliente recebeu 233. O probe foi testado ao vivo e
marcou aquele PID como órfão, como esperado. **O canal ainda não foi provado no
jogo.** O teste que falta é este: probe rodando antes da injeção.
