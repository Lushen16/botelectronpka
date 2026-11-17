# PROMPT DE CONTEXTO — Reconstrução do Bot PokeAlliance (RE do Shiba Bots)

Documento de retomada. Gerado em 2026-11-11. Cole isto no início de uma nova
sessão para restaurar o contexto sem reler 2,5 GB de logs.

---

## 1. Objetivo central

Reconstruir, por engenharia reversa, um bot funcional para PokeAlliance usando
o **Shiba Bots / PKA Tools 3.1.9** (um bot validado, que funciona) como
referência. O alvo não é "um bot parecido": é **reproduzir o comportamento dele**
com evidência medida, não com suposição.

Princípio de trabalho que se provou correto em todas as rodadas:

> Medir primeiro, implementar depois. Nenhuma afirmação de funcionamento sem
> evidência do cliente ou do log. Quando o dado não existe, declarar a lacuna
> em vez de estimar.

---

## 2. Ambiente

| item | caminho / valor |
| :--- | :--- |
| projeto oficial | `C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial` (grafia exata: `OFIcial`) |
| contratos originais | `..\Extracted_Source` (preservar, não editar) |
| app original | `..\Shiba_Bots_App` (o build verifica o ASAR) |
| jogo | `PokeAlliance_dx.exe`, instalado em `%LOCALAPPDATA%\PokeAlliance Games\PokeAlliance` |
| config real do Shiba | `%LOCALAPPDATA%\OTPbot\` — 59 arquivos `.lua` plaintext |
| validação geral | `node tools/validate.cjs` — **786 testes, 0 falhas** |
| menu do Shiba | `app.asar` extraído em `analysis/shiba_asar/` |

Leia antes de mexer: `AGENTS.md` (regras multiagente), `LEIA-ME.md`,
`CHECKPOINT_2026-11-10_WALK.md` (o mais completo, 62 KB, adendos 1–14).

---

## 3. O que o Shiba faz (medido, não deduzido)

### 3.1 Modelo de execução — a descoberta estrutural

```
menu (Electron) --kind11/12--> AUTORIZA / LIGA / PAUSA / PARA
                                    ↓
                      DLL no jogo executa SOZINHA
                      (walker, target, lure, combo, revive)
                                    ↓
                      kind6 publica estado (leitura)
```

**Evidência:** os únicos 2 pacotes `kind 11` de uma sessão inteira são
`start target` e `start walker`. Em 45 MB de captura há **zero** `kind 9`
(comando manual) e **zero** `kind 10` (ack). Ele não controla passo a passo
pelo pipe — liga dois módulos e o runtime executa.

**Consequência para nós:** o modelo dele é agente autônomo no processo. O nosso
é controle remoto por pipe. Funciona, mas não é o mesmo modelo.

### 3.2 Caminhos nativos (sem tecla, sem foco)

| ação | como | evidência |
| :--- | :--- | :--- |
| walk | `Game::walk` via hook `WH_CALLWNDPROC` na thread do jogo | 10/10 + 7/8, com fg=LoL |
| attack | handler `exe+0x784be0` | HP 100→29→morto |
| talk/combo | consumidor `0x785050` com `std::string` na pilha | 10b/17b/21b/33b |
| hotkey | **tecla real** (`tap_key`) | 0 amostras em 329k frames; usa action bar |

### 3.3 Config real capturada (`analysis/kind11-start-*.json`)

```lua
minWildsToEngage=8  perfectLure=true  perfectLureTimeoutMs=10000
perfectLureMinHp=30  bestTileRange=4  bestTileMaxWaitMs=2500
gateReadyPct=80  gateMinHp=90  potionHotkey="Alt+f"  medicineHotkey="E"
```

**Importante:** a config do `kind 11` **difere** do `.lua` em disco. O `.lua` é
persistência; o `kind 11` é o que vale.

### 3.4 Rotas reais

35 rotas em `analysis/shiba-live-config/`, até 149 waypoints
(`wk_torterra.lua`). Formato: `{pos={x=688,y=1313,z=7}, action="walk", param=""}`.
Ações: `walk`, `safespot`, `box`, `stairs`, `wait`, `say`.

---

## 4. O que está implementado e validado

### 4.1 Walk nativo — fechado

Três bugs reais corrigidos, todos com medição:

1. **`WM_NULL` não chega ao hook** — trocado por `RegisterWindowMessage`
2. **Hook morria com a thread que instalou** — `thread_alive` + reinstalação
3. **`FreeLibrary` matava o cliente** — export `PkaShutdown` antes do unload

### 4.2 Texto nativo — fechado

`0x785050` com `std::string` montada na pilha do jogo. Meu diagnóstico inicial
estava errado: o epílogo destrói a string **local dele**, não a do chamador.
Por isso funciona com buffer estático, sem heap, sem divergência de CRT.

### 4.3 Arbitragem — 100% de acordo

`botfinal/core/shiba-state-adapter.cjs` + `state-arbiter.cjs`: **12.390 de
12.391 frames** de acordo com o Shiba.

Correções que chegaram lá:

```
core.phase está DESATUALIZADO      -> usar phases.target + phases.walker
luring.count=0 com mode=off        -> dado AUSENTE, não zero monstros
Dynamic Lure vence fase do Target  -> ele fecha a box antes de atacar
isFormationHeld não exige lista    -> formação fechada implica monstros
```

### 4.4 Dynamic Lure — implementado

`botfinal/engines/dynamic-lure.cjs`, com durações **medidas**:

| fase | duração mediana | delta de posição |
| :--- | ---: | :--- |
| travel | 3.672 ms | dx∈[-3..3] dy∈[-5..5] |
| arc | **32 ms** | ±1 tile |
| stationary | **234 ms** | 0 |
| wait | 1.406 ms | 0 |

Acordo de fase: **97,9%** em 7.671 frames reais.

### 4.5 Testes

`node tools/validate.cjs` → **786 testes, 0 falhas** (617 raiz + 169 botfinal).

Correção de infraestrutura: `validate.cjs` só lia `tests/`, ignorando
`botfinal/tests/` — 158 testes que nunca rodavam. Agora lê as duas árvores.

---

## 5. Análise de `holding` — resultado atual

### 5.1 O sinal

`luring.holding` é o gatilho de intenção de parada. Internamente consistente:
**0 divergências contra `phase`** em 24.011 frames. Idade ≤ 281 ms.

### 5.2 A pergunta que restou

`holding` descreve **intenção**, não movimento. Se o personagem para
fisicamente, e com que latência, **não está verificado** — falta vídeo.

### 5.3 Sobre `count` — hipótese refutada

| estimador | delta | veredito |
| :--- | ---: | :--- |
| pooled (enviesado) | +7,35 p.p. | artefato de ponderação |
| **padronizado (155 entradas)** | **−0,57 p.p.** | **nulo** |
| **padronizado, cobertura completa (143)** | **−6,55 p.p.** | **negativo** |

**108 de 155 paradas** ocorreram sem nenhuma subida de `count` nos 600 ms
anteriores. Em **43,9%** o `count` não varia **nada**. Subida não é condição
necessária (refutado no intervalo observado).

### 5.4 Duas diferenças de contagem, explicadas

**20.348 vs 20.334 (14 frames):** o estrato contém todos os 23.473 controles; o
pooled só soma estratos com `entries > 0`. Os 14 são `n=7` (10 frames) e `n=8`
(4 frames) — têm controles mas zero entradas.

**68 vs 102 históricos estáveis:** 68 incluía o frame da transição
(`[...anteriores, countAtEntry]`); 102 usa só anteriores, que é o predicado
correto. Verificável em `stratified.stability`.

---

## 6. Pendências, em ordem

### 6.1 BLOQUEADA — piloto de 60 s (o próximo passo real)

Falta **tudo**. Verificado em 2026-11-11 16:49: nenhum MP4 do PokeAlliance em
disco, nenhum `pilot-sync-*.json`.

```
[ ] captures/pilot-<data>.mp4      tela inteira, 60 fps CFR
[ ] native/pka_tap_<pid>.jsonl     tap ativo na MESMA sessão
[ ] pilot-sync-<data>.json         marcadores A (início), B (meio), C (fim)
                                   com videoFrame + logT + logLine
[ ] verificar offset / deriva_ms_per_min / erro_B antes de medir
```

Roteiro: tap ativo → gravar → menu (A) → 20 s → `!autocombo` (B) → 20 s →
menu (C) → parar.

Critérios congelados:

```
erro_B > 33 ms (2 frames a 60 fps) -> revisar pareamento
deriva por minuto                  -> reportar sempre
janela de associação               -> ±1.000 ms (encurtar NÃO corrige sync)
repouso                            -> ≥100 ms = 7 frames a 60 fps
ordem indeterminada se |Δt| < incerteza
```

Com os três arquivos: validação por evento em ~90 min para 60–80 paradas.

### 6.2 Higiene de disco — ATENÇÃO

Os taps continuam crescendo, porque a DLL ficou injetada:

```
native/pka_tap_17748.jsonl   2.455,7 MB (2,4 GB)
native/pka_tap_19228.jsonl   2.444,2 MB (2,4 GB)
native/pka_tap_8036.jsonl      577 MB
```

O snapshot de análise está congelado e íntegro
(`sha256 55dc9bce…`, 616.925.188 bytes). Mas os originais crescem sem limite.
Decidir: descarregar o tap (exige `PkaShutdown`, que já existe) ou rotacionar.

### 6.3 Vulnerabilidades conhecidas do nosso bot

| item | estado |
| :--- | :--- |
| Dynamic Lure implementado | mas não validado no cliente |
| `isRevivePending` | vem de `phases.target`, não testado ao vivo |
| hotkey | depende de foco (não há caminho nativo provado) |
| combo > 15 bytes | funciona (buffer estático), sem teste de estresse longo |

### 6.4 Perguntas em aberto (para depois do piloto)

| pergunta | precisa de |
| :--- | :--- |
| o personagem para fisicamente? | vídeo |
| latência intenção → movimento | vídeo + marcador |
| qual formação dispara a parada | posição de selvagem por tile |
| qual função o walker dele chama | hook no processo, se necessário |

**Posição de selvagem:** o `kind5` não publica. Zero ocorrências de `type=1` em
2.296 amostras. Se for necessário, a fonte é `scan_creatures` da nossa DLL
(varre memória por RTTI `.?AVMonster@@`) — mas isso conflita com a regra de não
rodar as duas DLLs juntas.

---

## 7. Regras de trabalho que não devem ser quebradas

1. **Nunca os dois DLLs no mesmo processo.** `pka_native.dll` (nosso bot) e
   `pka_tap.dll` (espião) brigam pelo pipe.
2. **Não editar `research/shiba_tap/` nem `tools/tap_*`** ao mexer no bot.
3. **Nunca chamar endereço presumido.** Validar prólogo antes; se o build mudou,
   recusar.
4. **Não descarregar DLL sem `PkaShutdown`.** Foi assim que o jogo morreu duas
   vezes (`0xC0000005`).
5. **Rotear por assinatura, não por RVA.** O build muda: `0x15280` → `0x15670`.
6. **Snapshot congelado é imutável.** Análise lê dele, nunca do tap crescendo.

---

## 8. Comandos úteis

```bash
# validação completa
node tools/validate.cjs

# build da DLL do bot
node tools/build_native.cjs --only bot

# injetar / remover (sempre com shutdown ordenado)
native/pka_inject.exe --pid <pid> --dll native/pka_native.dll
native/pka_uninject.exe --pid <pid> --module pka_native.dll

# teste de walk no cliente
node tools/walk-verify.cjs --pid <pid> --dir 2 --watch 6

# rota integrada (walk + attack + combo)
node tools/route-e2e.cjs --pid <pid> --steps 2 --dir 2

# comparação de arbitragem com o Shiba
node tools/arbiter-compare.cjs --tap native/pka_tap_<pid>.jsonl

# análise de count (snapshot congelado)
node tools/lure-count-history.cjs \
  --in analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl
```

---

## 9. Onde está cada coisa

```
analysis/shiba_asar/           menu Electron extraído (79 arquivos)
analysis/shiba-live-config/    59 .lua da config real do Shiba
analysis/lure-stop-rule/       análise de holding (7 relatórios + snapshots)
  RELATORIO.md                 passo 0 (sanidade)
  RELATORIO-REPLAY.md          replay da regra
  RELATORIO-REVISAO.md         reconciliação dos 5 totais
  RELATORIO-VALIDACAO.md       count + protocolo de vídeo  <- LER ESTE
  count-history.json           dados da análise de count
  snapshot-...jsonl            snapshot congelado (616 MB, sha256 55dc9bce)

botfinal/core/                 arbitragem, sessão, transporte, adaptador
botfinal/engines/              walker, combat, healer, dynamic-lure
native/pka_native.c            DLL do bot (walk, attack, texto, pipe)
native/pka_tap.c               DLL espiã (hook IAT, passiva)

CHECKPOINT_2026-11-10_WALK.md  histórico completo, adendos 1-14
```

---

## 10. Estado em uma frase

O bot faz **walk, attack, talk, combo e rota integrada em segundo plano**, com
arbitragem 100% alinhada ao Shiba e 786 testes passando. O que falta é a
**única pergunta que o log não responde**: se `holding=true` corresponde a uma
parada **física** do personagem, e com que latência. Isso exige um vídeo de 60
segundos gravado junto com o tap — e é o próximo passo.
