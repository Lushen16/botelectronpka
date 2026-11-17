# Executor: foreground e background

Este documento separa três coisas que eram confundidas: **transporte**,
**executor** e **foco**.

## Camadas

```
Node (botfinal)                        Camada
  CommandDispatcher.send()             decisão de envio
    -> Transport.sendCommand()         transporte: named pipe + HMAC
      -> \\.\pipe\pka-runtime-2-<pid>  transporte
        -> pka_native.dll                executor
          -> PostMessageA(WM_KEYDOWN)    execução (envio de mensagem)
            -> cliente PokeAlliance      efeito (movimento/jogo)
```

O transporte **não** é independente de foco. Ele é só o canal de bytes até a
DLL. Quem decide se uma tecla pode ser enviada é o **executor**, dentro da DLL.
Uma coisa não implica a outra.

## O defeito que existia

A versão anterior de `execute_command` (tipo 1, walk) fazia, **a cada passo**:

```c
ShowWindow(hwnd, SW_RESTORE);
SetForegroundWindow(hwnd);
BringWindowToTop(hwnd);
```

`SW_RESTORE` não é "mostrar a janela". A documentação da Microsoft diz que, se a
janela estiver **maximizada ou minimizada**, o sistema a restaura ao tamanho e
posição **originais**. Efeitos observáveis:

| estado do jogo antes | após um passo |
| :--- | :--- |
| maximizado | volta ao tamanho original (des-maximiza) |
| minimizado | restaurado ao tamanho original |
| em background | foco roubado do usuário |
| já em foco, tamanho normal | nada visível |

Isso é interferência não autorizada na área de trabalho. Foi removido em
2026-11-05.

## Modos

### `PKA_EXECUTOR_MODE=foreground` (padrão)

- Exige que a janela **já esteja** em primeiro plano (`GetForegroundWindow`).
- **Não** captura foco, **não** restaura, **não** reordena janelas.
- Se não estiver em foco: devolve `STATUS_NO_FOREGROUND = 5` e **não envia
  tecla**. O `CommandDispatcher` traduz em `COMMAND_REJECTED` com status 5.
- Não envia teclas para outra aplicação: se não é o jogo em foco, não envia.
- Não retoma sozinho. Uma nova tentativa exige uma nova chamada explícita.

**Estado: validado no cliente em 2026-11-05 12:46** — um passo ao norte,
`(3304,2038,7) → (3304,2037,7)`, delta exato `(0,-1,0)`, z intacto. Naquela
execução o jogo estava em foco por ação externa **minha** (ver desvio 2 no
checkpoint), não por captura da DLL.

### `PKA_EXECUTOR_MODE=background` (experimental)

- Não tenta foco e não verifica primeiro plano.
- Apenas posta a mensagem na janela.
- **NÃO VALIDADO NO CLIENTE.** Evidência indireta de que **não funciona**:
  com o jogo em background (Cyberpunk em foco), `PostMessageA` retornou
  sucesso e o personagem não se moveu em 4 direções testadas.
- **NÃO SUPORTADO** até prova em contrário. Não é um "falso background" que
  captura foco em laço — isso é justamente o que foi removido.

## Regra para falha de foco

Falha de foco produz resultado explícito e **interrompe** a tentativa. Não
dispara escalada de métodos (AttachThreadInput, SendInput, etc.). O usuário
decide se quer trazer o jogo para frente.

## Como parar

- **Parar de despachar:** `runtime.stop()` + `runtime.pause()` (camada Node).
  É a única parada que o bot realmente controla.
- **Comando `stop` (tipo 4):** a DLL recebe e responde `STATUS_OK`. Isso
  significa apenas "não há mais tecla pendente para emitir". **Não** é
  cancelamento de movimento no cliente — não existe chamada ao jogo que faça
  isso nesta DLL e não inventamos uma.
- **Encerrar o bot:** Ctrl+C no processo Node. O transporte fecha; a DLL
  continua carregada no processo do jogo até ele encerrar (não há export de
  unload).

## O que ainda não existe

- Execução legitimamente independente de foco. Não há, hoje, interface
  conhecida para isso no cliente. Usar RVAs desconhecidas ou endereços de outra
  versão do executável está fora de escopo.
- Cancelamento de movimento já enviado.
- Combate, cura, captura: `execute_command` devolve `STATUS_UNSUPPORTED` (4).
