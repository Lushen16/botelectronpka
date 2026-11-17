# Validação de `holding` × movimento real — ENCERRADA SEM MÉTRICAS

Data: 2026-11-11 18:50. **Offline.** Nenhuma interação com PID, tap ou cliente.

---

## Resultado

**A avaliação não pôde ser executada.** Dois bloqueios independentes, e cada um
sozinho já é suficiente:

1. **Não existe vídeo da mesma sessão que o JSONL.**
2. **Não consigo analisar vídeo** — este modelo não suporta entrada de imagem.

Nenhuma métrica foi calculada. Nenhum Δt, nenhuma mediana, nenhuma tabela de
pares. Isso é deliberado: produzir números sem referência visual seria inventar
o dado que a tarefa existe para obter.

---

## 1. Localização dos arquivos — o que existe e o que falta

### JSONL disponível

| arquivo | janela (t) | duração | MB | mtime |
| :--- | :--- | ---: | ---: | :--- |
| `native/pka_tap_17748.jsonl` | 43.038.562 – 62.233.718 | **319,9 min** | 2.690 | 17:31:36 |

Contém lure ativo: **33.577 frames** de `kind6` com `mode=dynamic` no trecho
posterior ao snapshot. O `holding` está lá, completo.

### Vídeo disponível

| arquivo | duração | fps | resolução | mtime |
| :--- | ---: | ---: | :--- | :--- |
| `~\Videos\SteelSeries Moments\League-of-Legends__2026-11-11__17-50-58.mp4` | 59,8 s | **30** | 1920×1080 | **17:51:04** |

**Por que não serve:**

| requisito | vídeo | veredito |
| :--- | :--- | :--- |
| mesma sessão que o JSONL | tap termina às **17:31:36**, vídeo é de **17:51:04** | **19 min depois** — sessão diferente |
| conteúdo do jogo | nome do arquivo indica **League of Legends** | não é PokeAlliance |
| 60 fps | **30 fps** | abaixo do pedido |
| ciclos de parada/retomada do personagem | não verificável | — |

O SteelSeries Moments captura por evento de jogo. Os 28 arquivos em disco são
todos de League of Legends e Cyberpunk. **Nenhum do PokeAlliance.**

Busca executada em `Videos`, `Desktop`, `Downloads`, `Documents`, `OneDrive`,
`Pictures` e raízes `C:\`/`D:\`, por padrões `Poke`, `PKA`, `Shiba`, `Alliance`,
`pilot`, `Usobot`. **Zero resultados.**

### O que falta, nominalmente

```
[ ] um arquivo de vídeo capturado DURANTE a janela em que o tap gravou
[ ] preferencialmente 60 fps constantes
[ ] personagem e piso visíveis (para medir deslocamento entre tiles)
[ ] vários ciclos de parada e retomada
[ ] o JSONL da MESMA sessão (o atual serve, se o vídeo for da mesma janela)
```

O tap cobre `43.038.562 – 62.233.718` (319,9 min). Um vídeo gravado dentro
dessa janela serve. Fora dela, não.

## 2. Bloqueio técnico: incapacidade de ler imagem

Além da ausência do arquivo, há um impedimento que preciso declarar sem rodeios:

**Este modelo não aceita entrada de imagem.** A etapa 3 da tarefa exige *"revise
o vídeo sem usar holding, phase ou count para classificar o movimento"*. Isso é
inspeção visual frame a frame — marcar o último deslocamento antes de um trecho
imóvel e o primeiro deslocamento depois.

Tentei extrair frames com `ffmpeg` (disponível no sistema) e abrir o PNG.
A leitura falhou: o modelo não suporta imagem.

**Consequência:** mesmo que você grave o piloto agora, eu não consigo executar a
anotação visual. A etapa 3 é intrinsecamente visual e não tem substituto
programático confiável — detectar "o personagem mudou de tile" a partir de
pixels exigiria visão computacional calibrada contra o cenário, o que é
exatamente o que a anotação humana faria melhor.

### O que isso implica, na prática

| etapa | quem pode executar |
| :--- | :--- |
| 1. localizar arquivos | **eu** — feito |
| 2. sincronizar relógios | **eu** — se você fornecer os marcadores A/B/C como números |
| 3. **anotar movimento no vídeo** | **você** (ou um modelo com visão) |
| 4. parear transições | **eu** — com a sua anotação como entrada |
| 5. relatório + CSV | **eu** |

Ou seja: o trabalho se divide. Você anota; eu processo.

---

## 3. Protocolo para quando houver vídeo + anotação

Se você gravar e anotar, eu executo as etapas 2, 4 e 5. O que preciso receber:

### 3.1 Arquivos

```
[ ] captures/pilot-<data>.mp4              vídeo da sessão
[ ] native/pka_tap_<pid>.jsonl             JSONL da MESMA sessão (o tap já cobre 320 min)
[ ] analysis/lure-stop-rule/pilot-events.json    sua anotação (formato abaixo)
```

### 3.2 Formato da anotação

```json
{
  "session": "pilot-2026-11-XX",
  "videoFps": 60,
  "syncMarkers": [
    { "id": "A", "videoFrame": 120,  "logT": 50270000, "logLine": 17,
      "evidence": "menu do Shiba abriu" },
    { "id": "B", "videoFrame": 1800, "logT": 50298000, "logLine": 402,
      "evidence": "!autocombo no chat" },
    { "id": "C", "videoFrame": 3500, "logT": 50326000, "logLine": 811,
      "evidence": "menu do Shiba abriu" }
  ],
  "stopEvents": [
    { "videoFrameStart": 512, "videoFrameEnd": 640,
      "note": "parou; ficou no mesmo tile" }
  ],
  "resumeEvents": [
    { "videoFrameStart": 641, "note": "primeiro deslocamento" }
  ],
  "indeterminate": [
    { "videoFrameStart": 700, "videoFrameEnd": 760, "reason": "menu aberto" }
  ]
}
```

Campos obrigatórios:

| campo | significado |
| :--- | :--- |
| `videoFrame` / `videoFrameStart` | índice do frame no arquivo (0-based ou 1-based — declare qual) |
| `logT` | valor do campo `t` do `kind6` correspondente ao marcador |
| `logLine` | linha do JSONL que comprova o pareamento |
| `videoFps` | fps real do arquivo |

### 3.3 Critério de anotação (congelado antes de olhar `holding`)

Conforme a tarefa, para manter fixo:

- **Parada** = fim do último deslocamento entre tiles antes de um trecho em que
  o personagem permanece no mesmo tile.
- **Retomada** = primeiro deslocamento entre tiles após a parada.
- **Indeterminado** = oclusão, corte, travamento ou movimento de câmera que
  impeça identificar o evento.
- **Distinguir parada de intervalo normal entre passos:** um passo típico dura
  poucas centenas de ms; uma parada é quando o personagem permanece no mesmo
  tile por mais tempo que o intervalo entre passos consecutivos. **Declare o
  limiar que você usou** (por exemplo: "≥ 300 ms no mesmo tile") e mantenha fixo.

### 3.4 O que eu calculo a partir disso

1. **Alinhamento:** `offset = videoT(A) − logT(A)`; `deriva` de A→C; `erro_B`
   do marcador do meio. Limite: **2 frames**. Se exceder, reporto e sugiro
   trecho menor.
2. **Pareamento 1:1** por direção, mesmo episódio, tolerância **250 ms**.
   Ambiguidades sinalizadas, não forçadas.
3. **Δt** = primeira publicação do novo estado − evento visual.
   Positivo = publicação depois do movimento.
4. **Ordem indeterminada** quando o intervalo visual (com erro de sincronização)
   sobrepõe o intervalo da mudança de `holding`.
5. **Relatório + CSV** com uma linha por evento: pareado, sem par em cada lado,
   ou indeterminado.

### 3.5 Estimativa de cobertura

Com 60 s a 60 fps (3.600 frames) e o bot caçando, espero **8–15 paradas e
retomadas** na janela — suficiente para mediana e p90, insuficiente para
conclusão forte sobre p90. Para isso, 3–4 minutos seriam melhores.

---

## 4. O que permanece verdadeiro

Nada nesta rodada muda as conclusões anteriores:

| afirmação | estado |
| :--- | :--- |
| `holding` é internamente consistente | **válido** — 0 divergências contra `phase` em 24.011 frames |
| `holding` é pontual | **válido** — idade ≤ 281 ms |
| `count` não governa parada nem retomada | **válido** — 111/170 retomam abaixo do limiar |
| `kind5.position` não existe no lure ativo | **válido** — 0 de 33.577 frames novos |
| `holding` corresponde a parada **física** | **NÃO VERIFICADO** — falta vídeo + anotação |

---

## 5. Conclusão

**Paradas:** inconclusivo. Sem referência visual, não há como dizer se
`holding=true` corresponde a parada física.

**Retomadas:** inconclusivo. Mesmo motivo.

**O que bloqueia:** ausência de vídeo da mesma sessão **e** incapacidade deste
modelo de ler imagem. O primeiro você resolve gravando; o segundo exige que a
anotação seja feita por você ou por um modelo com visão.

**Próximo passo concreto:** grave 60–180 s com o Shiba caçando (não pausado),
com personagem e piso visíveis. Anote as paradas e retomadas por frame,
seguindo o critério da seção 3.3. Entregue o `.mp4`, o `.jsonl` e o
`pilot-events.json`. Eu executo alinhamento, pareamento, Δt e relatório.

Reproduzir os 97,9% históricos continua fora de escopo, assim como a causa da
parada e a geometria da box.
