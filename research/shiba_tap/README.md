# Shiba Tap & Sniffer

Captura passiva do tráfego do named pipe do Shiba Bots oficial. Módulo de
pesquisa — **não** é o bot, não fala o protocolo, não toca no jogo além de ler
os bytes que já passam por ele.

## Regras de coexistência

O agente do bot é dono de `botfinal/`, `reconstruction/` e `native/pka_native.c`.
Este módulo **não escreve** nesses caminhos.

| caminho | dono |
| :--- | :--- |
| `native/pka_native.c`, `native/pka_native.dll`, `native/pka_host.exe` | bot |
| `native/pka_tap.c`, `native/pka_tap.dll` | este módulo |
| `tools/tap_*.cjs` | este módulo |
| `tools/build_native.cjs` | compartilhado — use `--only tap` |
| `tools/pka_*.py` | este módulo (análise estática do dump) |
| `research/shiba_tap/` | este módulo |
| `botfinal/`, `reconstruction/` | **nunca tocar** |

Nunca rode o tap e o bot no mesmo processo do jogo: o bot cria o pipe
`pka-runtime-2-<pid>` e brigaria com o do fornecedor.

## Como funciona

O tap é uma DLL injetada no **mesmo processo** onde a DLL do fornecedor roda.
Ele troca os slots da IAT de `ReadFile`/`WriteFile` (kernel32) por um thunk
próprio e grava todo byte que passa por um handle de pipe.

Decisões que custaram bugs e não devem ser desfeitas:

1. **Hook na kernel32, não na ntdll.** O payload do fornecedor importa
   `ReadFile`/`WriteFile` de `KERNEL32.dll` na IAT estática. Hookar só
   `ntdll!NtReadFile` não intercepta nada.
2. **Nunca consultar o nome do handle.** `NtQueryObject(OBJ_NAME_INFORMATION)`
   em pipe síncrono pode bloquear indefinidamente e congelar o processo.
   Filtrar por tipo (`GetFileType == FILE_TYPE_PIPE`) e por conteúdo.
3. **Montar o frame no tap.** Quem escreve pode mandar os 8 bytes de header
   numa `WriteFile` e o corpo na seguinte. Validar por chunk isolado rejeita
   metade dos frames.
4. **Stream por `(handle, direção)`.** Pipe duplex usa o mesmo handle nos dois
   sentidos; sem separar, os buffers se misturam e nenhum frame fecha.
5. **Arquivo por PID.** `pka_tap_<pid>.jsonl` ao lado da DLL. Processo já em
   execução não herda ambiente, então `PKA_TAP_OUT` não chega — e jogo e menu
   precisam de arquivos distintos.

## Dois processos, dois taps

A DLL do fornecedor é o **servidor** do pipe, rodando dentro do jogo
(`pipe-bridge.jsc` do menu é o **cliente**, e contém o literal
`\\.\pipe\pka-runtime-2-`). Então:

```
PokeAlliance_dx.exe  ->  pka_tap_<pid-jogo>.jsonl   (s2c: state, telemetry, ack)
menu Electron        ->  pka_tap_<pid-menu>.jsonl   (c2s: manual)
```

`--inject` tapа os dois e acha o menu pelo `--client-pid=<pid do jogo>`.

## Uso

```cmd
npm run build      :: compila so pka_tap.dll
npm run test       :: 17/17 contra servidor de teste local
npm run inject     :: injeta no jogo (e no menu, se aberto)
npm run watch      :: acompanha o crescimento das capturas
npm run report     :: decodifica tudo da sessao
npm run kind6      :: mapeia o frame kind 6 (automation) da maior captura
npm run test:state :: 14 testes do modelo kind 6 contra amostras reais
```

## Modelo do kind 6 (consumível pelo bot)

`automation-state.cjs` traduz o payload `kind 6` num estado normalizado. Não
fala com o jogo e não escreve no bot — é só a camada de leitura.

```js
const { parse, movementPermission, detectStall } = require('./automation-state.cjs');
const state = parse(payload);
state.movementOwner            // null | 'target'
state.phase.core               // 'idle' | 'combat'
state.lure.phase               // off|travel|arc|stationary|wait|observe
state.lure.gateOpen            // count >= minCount
movementPermission(state)      // { allowed, reason }
```

O campo que importa é `movementOwner`: é ele que impede target e walker de
mandarem passo no mesmo tick. `movementPermission()` aplica a regra derivada
da captura (12.020 amostras com `target` dirigindo, 16.810 livres).

Enum desconhecido **não derruba o parser**: vira entrada em `issues[]` e o
valor é preservado para diagnóstico. Build nova do fornecedor aparece como
`issues`, não como crash.

Referência completa dos 246 campos e das transições reais:
`KIND6_MAP.md`.

Fluxo real:

1. fecha o jogo
2. `npm run inject -- --wait 300` (fica esperando o processo)
3. abre o launcher e clica ENTRAR (isso injeta a DLL deles e abre o menu)
4. `npm run inject` de novo para pegar o menu
5. usa o Shiba normal
6. `npm run report`

## Saída

O report mostra, por frame:

```
servidor->cliente telemetry  tick=42 player="Usobot" creatures=8 items=2 campos=31
cliente->servidor manual     talk(?) text="!autocombo m5, m6" cmdId=7 len=44
servidor->cliente ack        talk status=0 (enviado)
```

`--compare <captura>` responde o que importa: quais comandos o Shiba emite que
o nosso bot ainda não manda, e **quais campos de telemetria eles publicam que a
gente não modela**.

## Análise estática (sem jogo)

`tools/pka_re_map.py`, `pka_combat_disasm.py`, `pka_cmd_vocab.py`,
`pka_cmd_coverage.py`, `pka_pipe_imports.py` leem
`dumps/payload_reconstructed.dll` e não abrem processo nenhum. Resultado em
`reconstruction/COMBAT_NATIVE_PROVEN.md` (documento de leitura, não código do
outro agente).

O achado principal: `attack` **não é tecla**. O fornecedor chama função dentro
do jogo — dispatcher em RVA `0x12c40`, chamada real em `0x19b20`.

## Estado verificado (2026-11-04)

```
node tools/tap_test.cjs                 17/17
  challenge authenticate welcome state telemetry manual ack
  manual :: walk, hotkey="F2"   acks :: walk=3, hotkey=3
  telemetry :: schema=2 campos=24
node tools/build_native.cjs --only tap  OK pka_tap.dll (190976 bytes)
```

O que **não** foi provado: captura contra a DLL do fornecedor real. Todos os
testes usam o servidor de teste deste repositório.

## Footgun

`pka_tap.dll` é injeção clássica e aparece na lista de módulos do alvo. O
Defender apaga o injetor (ThreatID 2147731250). Adicione `native\` às exclusões
antes do build.
