# Combate do Shiba — extraído da captura viva do pid 572

Data: 2026-11-15. Fonte: `native/pka_tap_572.jsonl` (235 MB, crescendo), captura
passiva do Shiba oficial rodando.

**Esta captura é diferente das anteriores**: o Shiba estava com Target + Walker
ativos numa hunt real. `kind6.phase` e `kind6.events[]` mostram o ciclo completo.

## O que mudou em relação às 5 capturas antigas

Antes: `kind5` sem selvagens, sem como medir nada.

Agora: `kind6.events[]` carrega o **log interno do próprio Shiba**, com a decisão
que ele tomou em cada passo. É a especificação dele, escrita por ele.

## Os 8 eventos medidos (agrupados por tipo)

| evento | ocorrências |
| :--- | ---: |
| `[info] AutoCombo concluído: ultima skill (m5).` | **56.356** |
| `[warning] PokeStop sem confirmação após quatro tentativas; seguindo o fluxo de segurança do Lua.` | 35.658 |
| `[error] target: Pokémon ausente durante o combo; aguardando recuperação.` | 27.568 |
| `[info] Target: 1 monstro(s) vivo(s), dentro do limite de 2; deixando para trás e seguindo a rota.` | 8.519 |
| `[warning] Perfect lure: HP do Pokémon em risco (26% <= 30%); liberando o combo.` | 6.741 |
| `[info] AutoCombo concluído: sem monstro visível (m5).` | 4.472 |
| `[warning] Best Tile: limite de ajuste atingido; seguindo o fluxo de segurança do Lua.` | 2.247 |
| `[warning] Revive sem confirmação do Pokémon em 3 s; seguindo o combate.` | 2.247 |

## Regras que ficam provadas

### 1. Combo = 6 skills: `m1` → `m6`

Duas conclusões distintas aparecem no log, e a diferença importa:

```
AutoCombo concluído: ultima skill (m5).   x56.356
AutoCombo concluído: ultima skill (m6).   x3.024
```

Por skill citada como "última":

| skill | vezes |
| :--- | ---: |
| m1 | 3.172 |
| m2 | 6.214 |
| m3 | 6.300 |
| m4 | 3.152 |
| **m5** | **71.338** |
| **m6** | **3.024** |

**Por que dois finais** — o `kind5.roster` mostra que **cada Pokémon tem seu
próprio conjunto de moves**:

```
slot 1 Squirtle  hp=100  m1(12s) m2(10s) m3(12s) m4(15s) m5(12s) m6(30s) m7(30s)
slot 2 Weedle    hp=100  m1(20s) m2(10s) m3(10s)                      ← só 3
slot 3 Diglett   hp=100  m5(40s) m6(45s) m3(15s) m4(25s) m1(20s) m2(5s)
slot 4 Togepi    hp=100  m1(50s) m2(40s) m3(5s) m4(100s) m5(15s) m6(40s)
```

O Diglett tem 6 moves e o maior configurado é `m6`; o Squirtle tem 7. A
sequência de combo **muda com o Pokémon ativo** — não é constante global.

Consequência para o nosso motor: `sequenceText` **não pode ser literal fixo**.
Tem que vir do roster do Pokémon ativo ou de `target.combo.sequenceText`.

Cada move carrega `remainingMs`/`totalMs` (cooldown). Ex.: `m6` do Diglett tem
45 s — é a skill cara, a que fecha o combo.

### 2. HP de emergência da lure: 30%, com margem de 4 p.p.

```
Perfect lure: HP do Pokémon em risco (26% <= 30%); liberando o combo.
```

Confirma `perfectingLureHpPercent: 30`. A margem de 4 p.p. sugere que ele não
checa a cada 1%, e sim quando percebe a queda.

### 3. Deixar monstros para trás: limite 2

```
Target: 1 monstro(s) vivo(s), dentro do limite de 2; deixando para trás
```

Confirma `finishRemainingCount: 2` — com até 2 vivos, retoma a rota.

### 4. PokeStop: 4 tentativas antes de desistir

```
PokeStop sem confirmação após quatro tentativas; seguindo o fluxo de segurança
```

### 5. Revive: timeout de 3 s

```
Revive sem confirmação do Pokémon em 3 s; seguindo o combate.
```

`autoRevive.interval: 1500` na config, mas o timeout de confirmação é 3 s
(2 × intervalo).

### 6. Pokémon ausente durante o combo → espera

```
target: Pokémon ausente durante o combo; aguardando recuperação.
```

27.568 ocorrências. O Shiba **não cancela** o combo quando o Pokémon some —
ele espera recuperação.

### 7. Best Tile tem limite de ajuste

```
Best Tile: limite de ajuste atingido; seguindo o fluxo de segurança do Lua.
```

### 8. Combo sem monstro visível ainda assim executa

```
AutoCombo concluído: sem monstro visível (m5).
```

4.472 vezes. Ele solta a sequência mesmo sem alvo — o que explica o
`attackTargetId` não ser obrigatório no combo.

## Sequência de fases observada (kind6.phase)

Amostras reais consecutivas:

```
Walker · WP 13/21 · walk          lure=travel  count=7
Perfect lure: 8/9 monstros na área do combo   lure=off
Revive: aguardando Pokémon recuperado         lure=off
Walker · WP 15/21 · walk          lure=travel  count=2
Walker · WP 17/21 · walk          lure=travel  count=3
Walker · WP 19/21 · walk          lure=travel  count=10
Target: aguardando Pokémon, preservando combo  lure=off
Walker · WP 20/21 · walk          lure=travel  count=2
```

O ciclo real: `walk` → agrupa (`count` sobe) → `Perfect lure` fecha a box
(8/9) → combate → `Revive` → retoma `walk`.

## O que continua sem medida

`kind5` desta captura tem **0 selvagens** — as criaturas existem no runtime C++
do Shiba, mas ele não as republica no `kind5` enquanto a lure está ativa. Então:

| pergunta | estado |
| :--- | :--- |
| Distância Pokémon → monstro | **sem dados** (`kind5` sem `type=1`) |
| Box em tiles | **sem dados** — só o count textual ("8/9") |
| Movimento do Pokémon durante a lure | **sem dados** |
| Sequência de skills do combo | ✅ m1..m5 |
| HP de emergência | ✅ 30% |
| Limite de monstros ao retomar | ✅ 2 |
| Timeouts (PokeStop 4x, Revive 3s) | ✅ |

## O que isso permite consolidar agora

Estas já podem ir para o motor sem esperar nova captura:

1. **Combo de 5 skills** (`m1..m5`) — o nosso `fireCombo` usa `sequenceText`,
   que na config real é `"m5"`. Precisa ser a lista completa.
2. **Emergency HP 30%** — já implementado em `dynamic-lure.cjs`
   (`minHpPercent: 30`, lido de `perfectingLureHpPercent`).
3. **`finishRemainingCount: 2`** — o nosso motor não tem esse campo.
4. **Revive timeout 3 s** — o nosso `revive()` usa cooldown de 3 s; coincide.
5. **PokeStop 4 tentativas** — o nosso motor não tenta PokeStop.

## Arquivos

| arquivo | papel |
| :--- | :--- |
| `tools/captura_combate.cjs` | captura com validação ao vivo |
| `tools/analise_combate_shiba.cjs` | analisador de fases e distâncias |
| `native/pka_tap_572.jsonl` | a captura (cresce enquanto o Shiba roda) |
