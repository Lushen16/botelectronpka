# Combate do Shiba — o que a captura prova

Data: 2026-11-14. Extraído por `tools/analise_combate_shiba.cjs` das capturas
do tap. Nenhuma captura nova foi feita; nenhuma DLL nova foi escrita.

## Como reproduzir

```cmd
node tools/analise_combate_shiba.cjs --tap native/pka_tap_17748.jsonl --max 900000
```

## O bloqueio de evidência, declarado primeiro

**Nenhuma das cinco capturas tem selvagens.**

| captura | MB | `kind5` com `position` | `creatures[]` máx | tipos vistos | frames com selvagem |
| :--- | ---: | ---: | ---: | :--- | ---: |
| `pka_tap_17748` | 2690 | 12.072 | 2 | `0` (jogador), `3` (Pokémon) | **0** |
| `pka_tap_19228` | 2677 | — | 2 | `0`, `3` | **0** |
| `pka_tap_33524` | 573 | — | 2 | `0`, `3` | **0** |
| `pka_tap_8036` | 577 | — | 2 | `0`, `3` | **0** |

O Shiba foi capturado andando em área sem monstros (ou o `kind5` só publica
`creatures` quando há algo relevante na tela). Consequência direta:

- **distância Pokémon → monstro: NÃO medida**
- **box (quantos dentro de N tiles): NÃO medida**
- **movimento do Pokémon durante a lure: NÃO medido**

Qualquer número que eu inventasse aqui seria ficção. O que **foi** medido está
abaixo.

## O que a captura prova: tempos de fase da lure

`kind6.luring.phase`, 4.174 transições em 472.170 linhas do `pka_tap_17748`:

| fase | n | mediana | p90 | máx |
| :--- | ---: | ---: | ---: | ---: |
| `off` | 3.779 | 62 ms | 6.687 ms | 20.000 ms |
| `travel` | 4.174 | **2.469 ms** | 3.469 ms | 12.812 ms |
| `arc` | 237 | **157 ms** | 562 ms | 938 ms |
| `stationary` | 194 | **187 ms** | 875 ms | 3.500 ms |
| `wait` | 29 | **547 ms** | 1.735 ms | 8.031 ms |
| `observe` | 3 | 250 ms | 328 ms | 328 ms |

Na captura menor (`pka_tap_8036`, 1.058 transições de `travel`): mediana
1.609 ms, p90 3.156 ms. A diferença entre capturas é grande — usar mediana
como valor único é frágil.

### Transições medidas (as 10 mais comuns, 17748)

```
travel -> off             3764     off -> travel             3734
arc -> travel              226     travel -> arc              209
stationary -> travel       185     travel -> stationary       175
wait -> travel              27     off -> arc                  27
travel -> wait              26     off -> stationary           19
```

O ciclo base é `travel` alternando com pulsos curtos (`arc`, `stationary`,
`wait`). `off` domina porque a captura passa muito tempo sem lure ativa.

## O que a captura prova: `luring.target` é a posição-alvo da lure

`kind6` tem **uma única** coordenada em todo o payload: `luring.target`.
Nenhum outro campo tem `x`/`y`/`z` (verificado varrendo o JSON inteiro).

Como esse alvo se move, por fase:

| fase | frames | moveu | mediana do salto | máx |
| :--- | ---: | ---: | ---: | ---: |
| `travel` | 56.198 | 38% | 1 tile | 5 |
| `arc` | 591 | 38% | 1 tile | 4 |
| `stationary` | 589 | 31% | 1 tile | 4 |
| `wait` | 177 | **11%** | 1 tile | 4 |
| `observe` | 4 | 50% | 1 | 1 |

**Leitura**: em `travel` o alvo se move 38% dos frames (~1 tile). Em `wait`
cai para 11%. Isso é consistente com "anda, depois espera" — mas é o **alvo**
se movendo, não o personagem. Sem a posição do Pokémon não dá para afirmar que
o personagem parou.

## O que a captura prova: `holding`

`holding=true` foi observado em `wait`, com `count=5` e `minCount=8`:

```
fase=travel count=5/8 holding=false target={957,1414,7}
fase=wait   count=5/8 holding=true  target={957,1416,7}
```

Ligou quando o alvo andou 2 tiles em y. Amostras insuficientes (poucas
ocorrências) para afirmar a regra completa.

## O que NÃO está provado — e não vou afirmar

| afirmação | estado |
| :--- | :--- |
| Distância que ele mantém do Pokémon | **sem dados** (0 selvagens) |
| Quantos tiles o Pokémon fica do jogador | **sem dados** |
| A box de 8 fecha antes do combo? | **sem dados** |
| Parada física durante a lure | sem vídeo sincronizado |
| Fluidez de caminhada | sem vídeo sincronizado |
| Equivalência do nosso motor com o dele | não comparado |

## O que isso significa para a consolidação

**Consolidar o combate com base nesta captura não é possível.** O `kind6` prova
temporização de fase (que já está implementada em `dynamic-lure.cjs` com os
valores medidos) e prova que `luring.target` existe. Mas o dado espacial — que
é o coração da pergunta "que distância ele mantém" — **não foi capturado**
porque não havia monstros.

Para fechar o combate há dois caminhos reais:

1. **Nova captura com monstros na tela.** Tap no jogo do Shiba durante uma hunt
   ativa, com `kind5` publicando `creatures[type=1]`. É o único jeito de medir
   distância, box e movimento do Pokémon. Requer o Shiba rodando.

2. **Usar o nosso próprio cliente como referência espacial.** Já temos
   `creatures` com posição e `ownPokemon` com posição no nosso `kind5`. O que
   falta não é captura — é escolher a política (que distância manter) e medir
   o resultado. Isso não copia o Shiba; define o nosso.

## Correção ao que eu disse antes

Eu afirmei que "os dados que você quer já estão na captura". **Estava errado.**
A temporização está; a geometria não. O motivo é específico e verificável: as
cinco capturas têm no máximo 2 criaturas por frame, e são `type 0` e `type 3`.

## Arquivos

| arquivo | papel |
| :--- | :--- |
| `tools/analise_combate_shiba.cjs` | analisador; cruza `kind5`×`kind6` |
| `research/shiba_tap/KIND6_MAP.md` | mapa dos 246 campos |
| `analysis/lure-stop-rule/RELATORIO-VALIDACAO.md` | registro da ausência de vídeo |
