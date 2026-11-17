# CHECKPOINT — 2026-11-07

Retomada após erro de tamanho de mensagem na sessão anterior.
Nenhuma ação no cliente: sem injeção, sem hook, sem foco, sem movimento.

---

## 1. O que estava salvo (verificado, não presumido)

| item | estado |
| :--- | :--- |
| `botfinal/core/native-step.cjs` | existia, 226 L, **com a corrida aberta** |
| `botfinal/tests/native_step.test.cjs` | existia, 14 testes, todos passando |
| `tools/trace_exec_context.cjs` | existia, **falso negativo silencioso** |
| `docs/NATIVE_EXECUTOR_CONTRACT.md` | existia, contrato com 4 estados |
| `pendingStep` (`walker-engine.cjs`) | intacto, não tocado |
| `local-data/walk-testB-armed-*.json` | preservados |
| `local-data/trace-exec-2026-11-06T15-13-57-599Z.json` | preservado |

`botfinal/` é untracked no git — nenhum commit o contém. Não commitei nada.

---

## 2. A corrida em `native-step.cjs` — corrigida

**Problema real (não hipótese):** não existia estado entre `SCHEDULED` e
`EXECUTED`. Consequência: `cancel()` respondia `cancelled` **depois** da
chamada nativa já ter começado. A máquina mentia.

**Correção:**

- estado novo `EXECUTING`;
- `beginExecution()` é o ponto de não-retorno: valida `SCHEDULED`, revalida o
  TTL, incrementa `claim` monotônico, devolve `{ ok, claim }`;
- `markExecuted(claim)` só promove se o claim bater; claim velho →
  `stale-claim`, registrado, sem efeito no estado atual;
- `markExecuted()` depois do TTL → `UNKNOWN` (`confirmed-after-ttl`), nunca
  `EXECUTED`;
- `cancel()` agora só vale em `ACCEPTED`/`SCHEDULED`;
- `markUnknown(reason, claim)` exige claim em `EXECUTING`;
- `retryAllowed` exposto: `false` em `EXECUTING`/`EXECUTED`/`UNKNOWN`.

**Testes:** 14 → 20. Novos cobrem: cancelamento concorrente com o início,
claim velho não promove passo novo, relatório atrasado não envenena passo novo,
TTL na execução, confirmação tardia vira UNKNOWN, `beginExecution` só uma vez.

`botfinal` completo: **140/140**.

---

## 3. O coletor — "450 amostras, 0 hits" não provava nada

Dois bugs que produziam falha silenciosa em **todo** `GetThreadContext`:

1. struct `CONTEXT` truncada em ~256 B; kernel x64 espera **1232 B**;
2. alinhamento de 16 B exigido pelo kernel, `ctypes.Structure` entrega 8 B.

Cada falha era contada como "amostra sem hit". Zero hits era o resultado
garantido, não uma medição.

**Validado nesta rodada** (detalhe completo em `docs/EXEC_CONTEXT_COLLECTOR.md`):

- buffer de 1232 B alinhado em 16 B;
- `SuspendThread`/`GetThreadContext`/`ResumeThread` com `ResumeThread` em
  `finally`, janela medida (`avg 30.73 µs`, `max 931 µs`, `total 354 ms` em 2 s
  com 74 threads) e `perThreadSuspendedMs` — **não é leitura sem interferência**;
- self-test com **5 verificações separadas**: A leitura, B identidade da thread,
  C RIP em faixa definida antes da amostragem (página própria `jmp $`, 40/40 em
  `base+0`), D controle negativo, E encanamento dos contadores;
- contadores separados: `contextValid`, `contextFailures`, `suspendFailures`,
  `resumeFailures`, `openFailures`, `ripOutsideModule`,
  `ripInModuleOutsideRanges`, `ripInRanges`;
- identidade do alvo antes de coletar: PID, WOW64 aborta, base relida do loader,
  PE timestamp/SizeOfImage/checksum, 8 bytes de cada faixa; divergência →
  **RECUSA** (código 5);
- `bucket()` é fonte única usada pela coleta e pelo self-test [E].

Duas tentativas erradas do self-test ficam registradas no doc: thread em `Sleep`
(RIP vai para `ntdll!NtDelayExecution`, não para o módulo de `Sleep`) e faixa
derivada do min/max das amostras (circular, sempre passa).

Testado de ponta a ponta contra notepad com `--force`: 6000 amostras, 0 falhas,
6000 em `ripOutsideModule`, 0 em `ripInRanges`. Evidências de teste removidas de
`local-data`.

**`ripInRanges == 0` com contadores limpos é INCONCLUSIVO, não negativo.**

---

## 4. Próximo teste concreto

Pré-requisito: cliente aberto, personagem no mundo.

```
node tools/trace_exec_context.cjs --self-test
node tools/trace_exec_context.cjs --pid <PID> --verify-ranges
node tools/trace_exec_context.cjs --pid <PID> --run --seconds 20
```

Durante o terceiro: clicar no jogo e andar **digitando as setas** — 3–4 rajadas
de ~2 s com ~1 s de pausa. O coletor não envia tecla nem captura foco.

Critério: `selfTest` 100%, `contextFailures === 0`, e comparar `summary[].tid`
com `windowThreads`. Coincidência é hipótese de message loop; divergência é
informação, não erro. Sem ação manual, zero hits não significa nada.

---

## 5. Pendências (inalteradas)
| marco | estado |
| :--- | :--- |
| Teste B (motor sem overshoot no cliente) | **PENDENTE** |
| Executor nativo background | **NÃO IMPLEMENTADO** — bloqueio: thread + estado compartilhado sem sync |
| Teste de contexto de execução no cliente | **PRONTO PARA RODAR**, não rodou |
| `pendingStep` | intacto |
| `native-step.cjs` integração na walker | **NÃO FEITA** — a máquina existe e está testada, a walker ainda usa `pendingStep` puro |

Veredito de funcionamento continua **não emitido**. Só vale no cliente real com
o nosso bot.

---

## 6. Arquivos tocados nesta retomada

```
botfinal/core/native-step.cjs          (corrigido: EXECUTING + claim)
botfinal/tests/native_step.test.cjs    (14 -> 20 testes)
tools/trace_exec_context.cjs           (reescrito e validado A..E)
docs/NATIVE_EXECUTOR_CONTRACT.md       (secoes 5.1, 5.2, 7)
docs/EXEC_CONTEXT_COLLECTOR.md         (novo: validacao do coletor)
CHECKPOINT_2026-11-07.md               (este)
local-data/native_step.test.cjs.pre-race-fix.bak  (backup do teste antigo)
```

---

## 7. Rodada 2 — preparacao da coleta de 5 s (2026-11-07)

Detalhe completo: `docs/COLETA_5S_RODADA1.md`.

**Build mudou.** Cliente atualizado 13:56:52 (PID 24800). As 8 faixas de
referencia divergem 8/8; os RVAs antigos nao sao mais inicios de funcao no
`.pdata` do build novo.

Reancorado **so Game::walk** -> `0x780c90..0x781284`, por quatro vias:
inicio de `.pdata`, tamanho 1524 B identico, prologo identico, e os 4 pontos
do par `+0x9a8/+0x9b0` com delta `+0x1a40`. As outras 7 estao
`verified: false` no arquivo de faixas e **nao geram hit**.

Arquivo: `botfinal/config/ranges/pokealliance-2026-11-07.json`.

**Encanamento provado no cliente** (1 s, autorizado): 5610 leituras, 0 falhas,
`ripInModuleOutsideRanges=20`, 84.1 Hz efetivo, pior janela 374.5 us.
Inconclusivo quanto a hits, como esperado sem movimento.

**Novo no coletor:** journal incremental (sobrevive a kill — testado matando o
Python: 282 sweeps preservados), criterios de interrupcao
(`--max-suspend-us 2000`, `--max-failures 5`, exit 6), frequencia efetiva e
orcamento por thread na saida, `--ranges` para faixas por build,
`--module` para alvo nao-jogo.

**Pendente:** coleta de 5 s aguardando o operador confirmar area livre.
Teste B e executor nativo inalterados.

---

## 8. Rodada 3 — correcoes antes da coleta de 5 s

**Correcao de 60 Hz.** 60 Hz = ~16,67 ms por frame. Os 2 ms viraram
"orcamento de janela declarado", sem qualquer equivalencia a frame. Corrigido
no codigo e em `docs/COLETA_5S_RODADA1.md`.

**Criterios separados.** `decide()` e fonte unica, usada pela coleta e pelo
self-test [F]:
- `ResumeThread` falhou -> para na PRIMEIRA, registra TID/erro/contagem
  anterior, NAO retenta (retomada extra mexeria na suspensao de terceiros);
- `SuspendThread` falhou -> acumula ate 5, nada a recuperar;
- `GetThreadContext` falhou -> so conta, a retomada ja ocorreu.

**Identidade automatica.** GetProcessTimes (instancia + uptime), sha256 e mtime
do exe em disco com flag `onDiskAfterStart`, comparacao com o manifesto do
arquivo de faixas. Divergencia -> exit 5 sem coletar. Testado com sha falso.

**Reancoragem de Game::walk preservada e ampliada.** Alem das 4 vias anteriores,
conferidos: tabela de saltos 8/8, opcodes de direcao 8/8 (0x65..0x6D), epilogo,
`ret` em 0x781261. O delta +0x1a40 NAO e global: o gate 0x88ec20 com esse
delta cai em 0x890660, que nao e inicio de funcao. As 7 outras faixas seguem
`verified: false`.

**Self-test agora A..F.** 41 checagens no total, todas PASS.

**Encanamento 2 s no cliente:** 10890 leituras, 0 falhas,
`ripInModuleOutsideRanges=6`, 82.1 Hz, pior janela 470 us.

**Coleta de 5 s pronta**, aguardando confirmacao de area livre.

Script: `tools/trace_exec_context.cjs` (snapshot em
`validation-logs/trace_exec_context.cjs.snapshot`).
Faixas: `botfinal/config/ranges/pokealliance-2026-11-07.json`.
Doc: `docs/COLETA_5S_RODADA1.md`.
