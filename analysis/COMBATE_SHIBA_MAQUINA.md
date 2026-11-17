# Combate do Shiba — máquina de estados e tempos

Data: 2026-11-15. Fonte: `native/pka_tap_572.jsonl` (351,8 MB, 87.599 linhas,
captura final — o jogo foi fechado).

Esta captura fecha a **temporização** do combate. Não fecha a **geometria**
(distância, box em tiles) porque o `kind5` do Shiba nunca publicou selvagens —
medido no arquivo inteiro: 1.705 amostras de `kind5`, `tipos = {0: 58, 3: 58}`,
zero `type 1`.

## A máquina de estados, medida

Transições observadas (top 14) e a leitura de cada uma:

| transição | n | leitura |
| :--- | ---: | :--- |
| `Walker → Dynamic` | 568 | andando → lure ativa |
| `Dynamic → Walker` | 568 | lure termina, volta a andar |
| `Target → Walker` | 150 | combate termina, retoma rota |
| `Perfect lure → AutoCombo` | 129 | box fechou, solta o combo |
| `Best Tile → Aguardando PokeStop` | 128 | melhor tile escolhida, manda pokestop |
| `Walker → Best Tile` | 120 | chega no ponto, procura melhor tile |
| `Aguardando PokeStop → Perfect lure` | 119 | pokestop ok, começa a fechar box |
| `AutoCombo → Target` | 114 | combo terminou, volta a atacar |
| `AutoCombo → Walker` | 79 | combo terminou, retoma rota |
| `Walker → Revive` | 82 | Pokémon caiu durante a rota |
| `Revive → Target` | 76 | revive ok, volta ao combate |

### O ciclo canônico

```
Walker ──(chega no ponto)──> Best Tile ──(escolheu)──> PokeStop
   ^                                                      │
   │                                                      ▼
   └──(rota)── Target <── AutoCombo <── Perfect lure ──────┘
                 │                        ▲
                 └──(Pokémon caiu)──> Revive
```

O `Dynamic` (lure) entra em paralelo ao Walker: `Walker ↔ Dynamic` é o par mais
frequente (568 cada sentido), ou seja, **a lure liga e desliga enquanto anda**.

## Tempos por fase (mediana e p90)

| fase | n | mediana | p90 |
| :--- | ---: | ---: | ---: |
| `Target` (procurando alvo) | 249 | **63 ms** | 3.047 ms |
| `Dynamic` (lure ativa) | 568 | **156 ms** | 469 ms |
| `Best Tile` (escolhendo tile) | 132 | **750 ms** | 2.188 ms |
| `Revive` | 82 | **594 ms** | 641 ms |
| `Walker` (andando) | 858 | **594 ms** | 6.235 ms |
| `AutoCombo` (executando) | 195 | **1.328 ms** | 1.390 ms |
| `Aguardando PokeStop` | 128 | **1.375 ms** | 1.422 ms |
| `Perfect lure` (fechando box) | 133 | **2.406 ms** | 4.641 ms |
| `Pausa global` | 2 | 5.359 ms | — |

Leituras que importam:

- **`Perfect lure` dura 2,4 s** (p90 4,6 s) — é o tempo que ele espera a box
  fechar antes de soltar o combo. Confirma `perfectLureTimeoutMs: 10000` como
  teto, não como espera típica.
- **`AutoCombo` dura 1,3 s** (p90 1,39 s — muito consistente). Com `stepDelay:
  250 ms` e 5-6 skills, 5 × 250 = 1.250 ms. Bate.
- **`Target` procura alvo em 63 ms** — quase imediato quando há alvo.
- **`Best Tile` leva 750 ms** — não é instantâneo; ele avalia.
- **`Revive` 594 ms** — menos que o timeout de 3 s; o timeout é fallback.

## Eventos (arquivo inteiro)

| evento | n |
| :--- | ---: |
| `AutoCombo concluído: ultima skill (m5)` | 383.398 |
| `PokeStop sem confirmação após quatro tentativas` | 336.531 |
| `target: Pokémon ausente durante o combo; aguardando recuperação` | 267.265 |
| `Target: 1 monstro(s) vivo(s), dentro do limite de 2; deixando para trás` | 155.755 |
| `AutoCombo concluído: sem monstro visível (m5)` | 37.530 |
| `Best Tile: limite de ajuste atingido` | 20.706 |
| `Perfect lure: HP do Pokémon em risco (26% <= 30%); liberando o combo` | 13.784 |
| `Revive sem confirmação do Pokémon em 3 s` | 4.431 |

## O que o nosso motor já tem vs. o que falta

| regra do Shiba | nosso estado |
| :--- | :--- |
| combo m1..m6 por Pokémon | **implementado** (`sequence()` lê roster) |
| HP de emergência 30% | **implementado** (`minHpPercent`) |
| `finishRemainingCount: 2` | **implementado** (`rpm-combat-runtime:572`) |
| PokeStop 4 tentativas | **implementado** (`POKESTOP_ATTEMPTS`, +2 testes) |
| Revive timeout 3 s | parcial (cooldown de 3 s) |
| Best Tile com limite | **não implementado** |
| `Perfect lure` 2,4 s de espera | **implementado** (`dynamic-lure.cjs`) |
| `Dynamic ↔ Walker` em paralelo | **não implementado** (o nosso lure pausa a rota) |
| Pokémon ausente → espera, não cancela | **não implementado** |

## O que continua impossível com esta captura

| pergunta | por quê |
| :--- | :--- |
| Distância Pokémon → monstro | 0 frames com `type 1` em 351 MB |
| Box em tiles | idem — só o count textual ("8/9") |
| Movimento do Pokémon na lure | idem |
| Parada física | sem vídeo sincronizado |

Para fechar isso é preciso **uma captura com monstros na tela**. O script
`tools/captura_combate.cjs` já valida isso ao vivo — mostra
`[CAPTURANDO COMBATE]` só quando `kind5` traz `type 1`.

## Arquivos

| arquivo | papel |
| :--- | :--- |
| `native/pka_tap_572.jsonl` | **a captura** (351,8 MB, final) |
| `tools/captura_combate.cjs` | captura com validação ao vivo |
| `tools/analise_combate_shiba.cjs` | analisador de fases e distâncias |
| `analysis/COMBATE_SHIBA_EVENTOS.md` | os 8 eventos e as regras |
| `analysis/COMBATE_SHIBA_MAQUINA.md` | este documento |
