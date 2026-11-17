# Validação RPM no build 3.2.9 com seções ofuscadas — 2026-11-03

Executado com o jogo real aberto: `PokeAlliance_dx.exe` PID **25876**,
jogador **Nobutdopai** em (957, 1406, 6), HP 100.

## Build novo

| Item | Valor |
| :--- | :--- |
| SHA-256 | `82eadedcba74e368a7b981a11a6a4d20546b490be6bd4565026c2de847554e1c` |
| Tamanho | 31.318.576 bytes (antes 37.755.952) |
| Timestamp PE | 1793683192 |
| Seções | `.'$:`, `.*>C`, `.ny1` (nomes ofuscados) + `.text/.rdata/.data/.pdata/.rsrc/.reloc` |

O layout de entidade **não mudou**: `typeOffset 0x186`, `id 0x5C`, `hp 0xC0`,
`pos 0x30`, `name 0x80`. Confirmado por RTTI no processo vivo.

## Gates atualizados

Antes havia o hash antigo repetido em quatro lugares. Agora existe um módulo
único, `reconstruction/executable-profile.cjs`, com a lista de builds
verificados e o layout de cada um.

| Arquivo | Antes | Agora |
| :--- | :--- | :--- |
| `reconstruction/item-source.cjs` | hash fixo | `isSupportedExecutable()` |
| `reconstruction/rpm-combat-runtime.cjs` | hash + `0x186` fixos | `layoutFor(sha)` |
| `tools/creature_identity.py` | já tinha lista | mantido |
| `tools/item_identity.py` | hash + RVAs do build antigo | **não alterado** (ver limites) |

Regra documentada no módulo: hash novo só entra depois de o layout ser
verificado no processo real.

## Resultado da validação ao vivo

`node tools/rpm_live_validate.cjs --pid 25876` — **18/18 OK**:

```
OK processo lido
OK jogador identificado :: Nobutdopai
OK posicao valida :: {"x":957,"y":1406,"z":6}
OK posse verificada
OK hash do build suportado :: 82eadedcba74e368
OK layout declarado para o build :: build-2026-11-03
OK typeOffset confere :: 0x186 vs 0x186
OK telemetria montada a partir do processo
OK Target iniciou com o perfil do build ativo
OK tick executou sem pausar :: status=combat
OK comando despachado ao cliente :: envios=1
OK comando tem guarda de identidade
OK alvo e hostil verificado :: type=1
OK PID do envio confere :: 25876
OK efeito nao e declarado
OK rotacao continuou :: total=4
OK runtime nao pausou no meio
OK sem efeito declarado
```

As criaturas dessa validação foram **sintéticas** (injetadas no canal), porque
o processo não tinha monstros na tela. O jogador e o perfil vieram do processo
real.

## Envio real ao cliente

`node tools/live_key_send.cjs --pid 25876 --key F1` — **8/8 OK**:

```
OK probe do transporte
OK janela encontrada :: 0x50e6c
OK dimensoes validas :: 1920x1009
OK canal PostMessageW
OK modo background (sem foreground forcado)
OK tecla aceita pelo transporte
OK eventos contabilizados :: eventsSent=2
OK efeito NAO declarado
```

`effectVerified: false` — aceite do transporte não é prova de skill no jogo.

## Bloqueio encontrado: janela minimizada

O atuador falhou primeiro com "Falha ao enumerar janelas do cliente". Causa
real: o jogo estava **minimizado** (`IsIconic = True`), `GetClientRect`
devolvendo 0x0. Um `ShowWindow(SW_RESTORE)` resolveu, e o probe passou a
reportar 1920x1009.

Não é bug: sem área de cliente não há projeto de coordenada nem clique. O
leitor de memória continua funcionando minimizado; só o atuador precisa da
janela visível.

## Criaturas: por que o scan deu zero

Não é falha do scanner. `tools/diag_creature_candidates.py` mostra:

- **99** instâncias com a vtable do wrapper `_Ref_count_obj2<Monster>`
- **1** com `ptr@16 == monsterVtable` (o filtro correto de posse)
- dessa uma, o objeto é **Diglett, type 3** — o pet do jogador
- posição `(65535, 65535, 255)` = sentinela de "guardado na pokeball"

Ou seja: **não há monstros no mapa** na posição atual (957, 1406, 6). O
pipeline lê, resolve RTTI, aplica os filtros e rejeita corretamente as 98
entradas que não são criaturas.

Para validar targeting com alvo real, o jogador precisa estar com monstros na
tela. Não inventei nenhum.

## Stream

`scan_creatures.py --stream` grava o snapshot corretamente
(`captures/rpm-25876/stream3.json`, jogador e perfil corretos). Os laços
internos silenciam exceções com `except Exception: pass`, o que dificultou o
diagnóstico; usei `tools/diag_stream_loop.py` para ver o estado real de cada
volta. Vale corrigir esse silêncio em algum momento.

## Limites

- `tools/item_identity.py` continua preso ao build antigo: usa RVAs de vtable
  por build (`ITEM_VTABLE_RVA`, `PLAYER_VTABLE_RVAS`) que **não** foram
  reverificados no build novo. Captura de itens fica desabilitada — e é o
  correto, porque ler com offset velho poderia apontar para memória errada.
- Nenhum efeito no jogo foi comprovado. `effectVerified` é `false` em todo
  registro.
- As 3 falhas em `tests/win32_infrastructure.test.cjs` são **pré-existentes**
  (persistem com meu código revertido via `git stash`) e tratam do laço de
  respawn do provider, não do build novo.
- O Windows guarda `generatedAt` com microssegundos; comparações de frescor
  usam `Date.parse`, que trunca — sem impacto nos limites atuais (1000–3000 ms).

## Suíte

| Alvo | Resultado |
| :--- | :--- |
| `botfinal` | **50/50** |
| `tests/executable_profile.test.cjs` | **7/7** |
| repo principal | 600/611 (3 falhas pré-existentes + 8 skipped) |

## Reproduzir

```cmd
python tools/scan_creatures.py --pid 25876 --output captures\rpm-25876\creatures.json
node tools/rpm_live_validate.cjs --pid 25876
node tools/live_key_send.cjs --pid 25876 --key F1
python tools/diag_creature_candidates.py --pid 25876 --limit 8
```
