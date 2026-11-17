# Executor em segundo plano — auditoria e bloqueio técnico

Data: 2026-11-06. **Somente leitura**: nenhuma ação no jogo, nenhuma captura
nova, nenhuma alteração de foco.

Conclusão antecipada: **background NÃO SUPORTADO**. Abaixo, a evidência de por
quê e o que seria necessário para mudar isso.

---

## 1. O que já estava medido (não é suposição)

Experimento de 2026-11-05 12:44, no cliente real:

| condição | direções postadas | movimento observado |
| :--- | :--- | :--- |
| outra janela em primeiro plano | 4 (`PostMessage`) | **0** |
| jogo trazido para frente, mesmas 4 | 4 | **4**, com delta exato `(0,-1) (0,+1) (+1,0) (-1,0)` |

Também medido no teste A (19:10Z) e no teste B (01:40Z): com o jogo em foco,
o movimento acontece. Sem foco, não.

**Conclusão medida:** este cliente ignora `WM_KEYDOWN`/`WM_KEYUP` postados
enquanto não está em primeiro plano.

O projeto já sabia disso e registrou em `reconstruction/BACKGROUND_CAPTURE.md`:

> "PostMessage não garante que o cliente processe input quando minimizado;
> não existe fallback de foco."

---

## 2. O que a auditoria desta rodada acrescentou

### 2.1 O cliente é um OTClient

Descoberto por leitura da imagem em memória do PID 21900:

```
classe da janela : PokeAllianceV3
strings no módulo: [%i] LocalPlayer::walk server walk
                   [%i] LocalPlayer::preWalk %s -> %s, prewalk:%s
                   [%i] cancelWalk
                   [%i] stopWalk
                   [%i] terminateWalk
                   /modules/game_walking/autowalk.otui
                   [%i] walkStep to %s: tile=%s ground=%s walkable=%s
RTTI             : .?AVLuaObject@@  .?AVTile@@  .?AVCreature@@
```

Módulos carregados: **sem SDL, sem DirectInput, sem XInput, sem raw input
handler**. Só `USER32`, `WINMM`, `IMM32`, `MSCTF`, `textinputframework`.

### 2.2 O movimento é chamada nativa, não tecla

`LocalPlayer::walk` / `preWalk` / `cancelWalk` são métodos de C++ com RTTI.
Em OTClient, mover significa chamar `LocalPlayer::walk(dir)` (ou o autowalk do
módulo `game_walking`), que envia `server walk` ao servidor. **Não há tecla de
movimento a simular nessa engine.**

Isso explica por que:
- `PostMessage` só funciona quando a janela está em primeiro plano:
  o caminho que reage a `WM_KEYDOWN` é o handler de UI, não o motor de jogo;
- o modo background "funcionava" na cabeça da implementação anterior —
  ele apenas postava a mensagem e não verificava que nada acontecia.

### 2.3 Por que não dá para chamar `LocalPlayer::walk` agora

Tentei localizar a função para uma chamada legítima. Bloqueio:

| passo | resultado |
| :--- | :--- |
| IAT em memória | **1 função por DLL**; nenhuma API de input. Importação dinâmica. |
| strings de input na memória | existem, mas **só em módulos do sistema** (`textinputframework.dll`, `user32.dll`, `winmm.dll`, `amdxx64.dll`) — **nenhuma no módulo do jogo** |
| cabeçalho PE em memória | **ilegível/corrompido** — as seções lidas retornam valores absurdos (`va=0xdd580004`) |
| `.text` do jogo | 26.2 MB lidos, código válido (`pxor xmm4,xmm4`) |
| xrefs para `LocalPlayer::walk` | **0** em 26.2 MB |
| endereço absoluto da string como qword | **0** |
| RVA da string como imediato de 32 bits | **0** |

Zero referências em 26 MB de código significa que o binário **não referencia as
strings de forma estática** — usa tabela construída em runtime, strings
cifradas, ou resolve tudo dinamicamente. Sem resolver isso, eu não tenho:

- RVA estável de `LocalPlayer::walk`;
- assinatura/ABI (é `this` em `rcx`? `dir` em `dl`? retorno?);
- contexto de thread (precisa da thread do jogo? fila de comandos?);
- pré-condições (precisa de `Tile` válido? de estado de walk em andamento?).

**Chamar um endereço presumido com ABI desconhecida em processo vivo é o que a
instrução proíbe, e com razão: pode corromper o cliente.**

---

## 3. O que foi corrigido nesta rodada (código)

`native/pka_native.c`:

| antes | agora |
| :--- | :--- |
| `PKA_EXECUTOR_MODE=background` pulava o gate de foco e postava mesmo assim | devolve `STATUS_BACKGROUND_UNSUPPORTED` (6) **antes** de postar |
| modo background "funcionava" (retornava OK sem efeito) | recusa explícita, com log |

Nenhuma outra mudança. O caminho foreground está intacto.

Build: `pka_native_new.dll` (207.360 B). **Não carregada** — a DLL em uso está
travada pelo cliente. Promover exige reinício controlado.

---

## 4. Caminhos possíveis para background legítimo

Em ordem de viabilidade, com o que cada um exige:

### 4.1 Canal do próprio cliente (mais promissor)

O cliente é OTClient e fala `server walk` com o servidor. Se houver um canal
local (socket, pipe, IPC) entre cliente e um módulo autorizado, mandar `walk`
por ele não depende de foco nenhum.

**O que falta:** descobrir se esse canal existe e está exposto. Não investiguei
— exigiria captura de rede/socket, e a pergunta precisa ser específica.

### 4.2 Chamada nativa a `LocalPlayer::walk`

**O que falta:** resolver o endereço em runtime (não por RVA fixa), confirmar
ABI e pré-condições. O bloqueio da seção 2.3 impede isso hoje.

### 4.3 Injeção de script (Lua)

Há RTTI `LuaObject` e o cliente carrega `.otui`. Se o motor de script estiver
ativo e exposto, um bind de `walk` resolveria sem tocar memória de código.

**O que falta:** confirmar se o interpretador está ativo no runtime e se há
superfície de script acessível. Também não investiguei.

### 4.4 PostMessage (descartado)

Medido: não funciona sem foco. Não é caminho.

---

## 5. Classificação

| item | estado |
| :--- | :--- |
| background com janela aberta atrás de outra | **NÃO SUPORTADO** (medido: 0 movimento) |
| background minimizado | **NÃO SUPORTADO** (nem testado — depende do anterior) |
| foreground | VALIDADO NO CLIENTE (testes A e B) |
| proteção contra overshoot | corrigida localmente; validação no cliente pendente |
| interrupção de novos despachos | validada localmente |

## 6. Próximo passo mínimo

Não implementar nada de background até responder **uma** pergunta, com captura
específica:

> Existe canal local entre o cliente e o servidor, ou superfície de script
> ativa, por onde um `walk` possa ser emitido sem depender da janela?

Se sim, o caminho 4.1 ou 4.3 fica viável. Se não, background permanece
bloqueado e o bot fica foreground-only — o que é uma limitação honesta, não um
defeito escondido.
