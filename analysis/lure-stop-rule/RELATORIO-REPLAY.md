# Replay sincronizado — regra `holding` contra o que o log permite

Data: 2026-11-11. Somente leitura no snapshot congelado. Nada executado contra o
jogo, nada capturado.

---

## 0. Bloqueio declarado antes dos resultados

**Não existe gravação da sessão.** Varredura completa:

| fonte procurada | resultado |
| :--- | :--- |
| `*.mp4/mkv/avi/webm/mov/gif` no projeto | **0** do PokeAlliance |
| `~\Videos` (28 arquivos > 1 MB) | **todos** de League of Legends / Cyberpunk |
| screenshots de 11/11 em `Pictures`/`Desktop` | **0** |
| `captures/`, `dumps/`, `local-data/` com imagem de 11/11 | **0** |

Sem referência visual, **"o personagem realmente parou?" não é respondível**.
A latência real de parada/retomada fica **em aberto**, conforme instruído.

O que o replay faz: mede o que é mensurável do próprio sinal — estabilidade,
histerese, coerência e sobrevivência ao limite de 600 ms — e prova
quantitativamente que `minCount` não governa a decisão.

---

## 1. Snapshot congelado

```
arquivo : analysis/lure-stop-rule/snapshot-17748-2026-11-11T1411.jsonl
bytes   : 616.925.188
linhas  : 172.735
sha256  : 55dc9bcecd86d65977df02d59e7f05c4ab33936a9d801aac6fedd24b665491a0
```

Cópia atômica (`.part` → rename) com hash verificado. O tap original permanece
como está; o snapshot é imutável.

---

## 2. Regra testada (única, congelada)

```
holding === true   -> manter parada
holding === false  -> liberar movimento normal
kind6 anterior ausente OU idade > 600 ms -> INDETERMINADO
count / minCount NÃO entram nesta decisão
```

`N = 600 ms` vem da análise anterior (mediana 203 ms, p95 250 ms, p99 265 ms).

O replay decide **a cada kind6**, sempre usando o **kind6 imediatamente
anterior** — nunca o atual. Isso reproduz a condição real de operação (só se
sabe o passado).

---

## 3. Resultados

### Volume

| métrica | valor |
| :--- | ---: |
| kind6 total | 42.602 |
| kind6 em lure `dynamic` | 24.011 |
| episódios | 1.576 (mediana **16** frames, máx 64) |

### Decisões do replay

| decisão | frames | % |
| :--- | ---: | ---: |
| **STOP** (manter parada) | 529 | 2,2% |
| **MOVE** (liberar movimento) | 21.906 | 91,2% |
| **INDETERMINADO** | 1.576 | 6,6% |

Motivo único dos indeterminados: **"sem kind6 anterior"** — é o primeiro frame de
cada episódio (1.576 episódios = 1.576 primeiros frames). Nenhum indeterminado
por idade > 600 ms: a cadência nunca estourou o limite.

### O sinal é estável?

| métrica | valor |
| :--- | ---: |
| trocas STOP↔MOVE | **305** (parada→andou 150, andou→parada 155) |
| idade do kind6 usado | mediana 203 ms, p95 250 ms, **máx 281 ms** |
| coerência `phase` × `holding` | **0 divergências** em 24.011 frames |

### Duração do sinal

| métrica | valor |
| :--- | ---: |
| run de kind6 consecutivos | mediana **2**, p90 12, máx 35 |
| duração estimada (×203 ms) | mediana **406 ms**, p90 2.436 ms, máx 7.105 ms |
| runs com ≤ 2 kind6 (~< 600 ms) | **173 de 305 = 56,7%** |

**Este é o achado mais importante.** Mais da metade das paradas dura menos de
600 ms — aproximadamente 2 publicações. Isso tem duas leituras e ambas importam:

1. O sinal é **muito curto** comparado ao tempo que o personagem leva para
   completar um tile (o passo no jogo é mais lento que 400 ms).
2. Portanto, se `holding=true` significa "pare AGORA", ele ordena parar antes
   de o passo anterior terminar — o que é coerente com micro-ajustes de
   reposicionamento, não com "parar e esperar".

Isto reforça que `holding` descreve **intenção de formação**, não estado de
repouso. Mas sem vídeo, **não posso confirmar** se o personagem chega a parar
fisicamente nesses 406 ms.

### O que `minCount` faz (e não faz)

Transições de entrada em parada (`travel → arc/stationary/wait`), 329 transições
capturadas:

| padrão | ocorrências |
| :--- | ---: |
| `count=7 → 7` | 27 |
| `count=8 → 8` | 16 |
| `count=6 → 6` | 14 |
| `count=7 → 8` | 13 |
| `count=4 → 4` | 13 |
| ... | |
| `count=10 → 10` | 5 |

**A contagem não muda na entrada da parada.** Ele para com 3, 4, 5, 6, 7, 8, 9
ou 10 monstros. Nenhum limiar dispara.

Transições de saída da parada (169 observadas):

| condição | ocorrências | % |
| :--- | ---: | ---: |
| `count >= minCount` | 59 | **34,9%** |
| `count < minCount` | 110 | **65,1%** |

**65,1% das retomadas acontecem com a contagem ABAIXO do `minCount`.**

Distribuição das saídas: `count=7` (44×), `8` (31×), `6` (23×), `5` (18×),
`9` (18×), `4` (13×), `3` (11×), `10` (9×).

Conclusão medida: **`minCount` não controla nem a parada nem a retomada do
lure.** Confirmado o que o Teste B havia sugerido, agora com a direção da
transição explícita.

---

## 4. O que permanece incerto

| pergunta | status | motivo |
| :--- | :--- | :--- |
| O personagem para fisicamente em `holding=true`? | **INDISPONÍVEL** | sem vídeo |
| Quanto tempo até parar de fato? | **INDISPONÍVEL** | sem vídeo |
| Retoma junto com `holding=false`? | **INDISPONÍVEL** | sem vídeo |
| `holding` prediz movimento real? | **NÃO TESTADO** | ausência de rótulo |
| `minCount` governa o combo? | hipótese não testada | exige observar o combo |

O que **está** provado: o sinal é consistente (0 divergências), pontual (idade ≤
281 ms), e independente de `count`.

---

## 5. Próximo passo: nova sessão de teste

Sem vídeo da sessão antiga, a validação precisa de uma sessão nova. Procedimento
mínimo:

**5.1 Captura**
- Gravar a tela (OBS, 60 fps) **durante** a coleta do tap.
- Iniciar gravação e tap no mesmo instante, se possível.
- Um evento de sincronização visível: abrir/fechar o menu do Shiba, ou um
  `!autocombo` — os dois aparecem no vídeo e no log.

**5.2 Marcação**
- No vídeo, marcar o frame em que o personagem **para de mudar de tile**.
- E o frame em que **volta a andar**.
- Anotar o horário do vídeo (não o `t` do log) de cada evento.

**5.3 Alinhamento**
- `t` do tap é `GetTickCount()` do processo do jogo: monotônico, sem data/hora.
- Só é comparável se a gravação tiver seu próprio relógio monotônico (OBS tem).
- Alinhar pelo evento de sincronização, não por estimativa.

**5.4 Tiles ocupados (para a hipótese geométrica)**
- No vídeo, anotar a posição de cada selvagem visível por tile.
- Comparar com `luring.count` — é a única forma de calibrar `boxed`.
- O kind5 dessas sessões **não tem** selvagem (2.288 de 2.296 vazios,
  0 com `type=1`), então a geometria só sai do vídeo ou de `scan_creatures`.

---

## 6. Recomendação

1. **Adotar `holding` como gatilho agora** — é o sinal que ele publica, é
   internamente consistente (0 divergências) e pontual (≤281 ms).
2. **`minCount` fica fora da decisão de parada** — medido: 65,1% das retomadas
   ocorrem abaixo dele, e a entrada na parada não depende da contagem.
3. **Indeterminado** quando não há kind6 anterior ou idade > 600 ms. Na prática
   isso atinge só o primeiro frame de cada episódio.
4. **Permanece incerto** se o personagem para fisicamente e quanto tempo leva.
   Sem vídeo, `holding` é intenção declarada, não movimento confirmado.
5. **O dado que fecha:** gravação de tela com evento de sincronização +
   posição dos selvagens por tile. Com isso testa-se a latência real e a
   hipótese geométrica (`holding` = "formação em progresso").
