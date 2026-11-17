# Coleta de contexto — 5 s, rodada 1

Preparado: 2026-11-07
Estado: **PRONTA, aguardando confirmação do operador.**
Não executada automaticamente. Sem envio de tecla, sem captura de foco,
sem repetição automática.

---

## 0. Situação do build (verificada automaticamente)

O cliente foi atualizado hoje **13:56:52**. As 8 faixas de referência divergem
8/8; 7 dos 8 RVAs antigos nem são início de função no `.pdata` novo.

Reancorado **apenas `Game::walk`** → `0x780c90..0x781284`.
As outras 7 estão `verified: false` e **não classificam hit**.

Arquivo: `botfinal/config/ranges/pokealliance-2026-11-07.json`

O coletor compara sozinho, a cada execução:

| checagem | fonte |
| :--- | :--- |
| PID existe e abre | `OpenProcess` |
| arquitetura | `IsWow64Process` — WOW64 aborta |
| instância | `GetProcessTimes` → `processCreatedIso` + `uptimeSeconds` |
| base/tamanho do módulo | loader, relido sempre |
| PE `TimeDateStamp`, `SizeOfImage`, `magic`, `checksum` | cabeçalho em memória |
| sha256 e mtime do exe | arquivo em disco, com `onDiskAfterStart` |
| bytes das faixas | RPM no RVA |

Build divergente do manifesto → **RECUSA** (exit 5) antes de coletar.
Não depende de ninguém lembrar qual PID ou qual build era o atual.

---

## 1. Reancoragem de `Game::walk` — registro preservado

| evidência | resultado |
| :--- | :--- |
| início de função em `.pdata` (72405 entradas) | `0x780c90` **é** início |
| tamanho da função | **1524 B**, idêntico ao de referência |
| prólogo | `48895c2408555657` **idêntico** |
| tabela de saltos (`0x77f824` → `0x781264`) | 8/8 entradas idênticas |
| opcodes de direção (8 ramos) | 8/8 batem: `0x65,0x66,0x67,0x68,0x6A,0x6B,0x6C,0x6D` |
| epílogo (`0x77f6d6` → `0x781116`) | instrução a instrução idêntico |
| par `shared_ptr` `+0x9a8/+0x9b0` | 4/4 pontos batem byte a byte |
| `ret` (`0x77f821` → `0x781261`) | idêntico |

Delta observado: **`+0x1a40`**.

### O delta NÃO é aplicado automaticamente

Testei aplicar `+0x1a40` às outras funções: só `Game::walk` bate. E o gate
`0x88ec20` com esse delta cai em `0x890660`, que **não é início de função** —
é meio de instrução. Por isso o delta ficou registrado como observação
específica de `Game::walk`, nunca como regra de deslocamento do módulo.

As 7 outras faixas permanecem `verified: false`.

| faixa | tamanho | funções do mesmo tamanho | prólogo igual |
| :--- | ---: | ---: | --- |
| wrapper-setWalkActive | 119 | 153 | 4 (não confirmados) |
| lambda-autowalk-tick | 240 | 97 | **0** |
| startAutoWalkLoop | 648 | 11 | **0** |
| stopAutoWalk | 163 | 88 | 4 (não confirmados) |
| setDirection-and-call | 124 | 158 | 4 (não confirmados) |
| input-direction-calc | 202 | 71 | **0** |
| input-apply-dir | 256 | 63 | 1 (não confirmado) |

---

## 2. Frequência efetiva e orçamento (medidos em 2 s no cliente)

| métrica | valor |
| :--- | :--- |
| sweeps | 165 (nominal 200) |
| leituras válidas | 10890 |
| falhas de contexto | 0 |
| falhas de suspend/resume | 0 |
| `ripOutsideModule` | 10884 |
| `ripInModuleOutsideRanges` | **6** ← RIPs do jogo classificados |
| `ripInRanges` | 0 |
| frequência efetiva | **82.1 Hz** por thread (alvo 100) |
| janela média / pior | 19.8 µs / 470.3 µs |
| total suspenso | 215.61 ms (10.7%) |

Em 5 s: expectativa de ~410 amostras por thread.

**Chance de função curta:** período de ~12.2 ms por thread. Função de 1 ms →
**~8%** por ocorrência.

---

## 3. Critérios de interrupção (separados)

Testados no self-test [F] contra `decide()`, a mesma função que a coleta usa.

| condição | ação | justificativa |
| :--- | :--- | :--- |
| `ResumeThread` falha | **para na primeira** | é o único caso em que uma thread pode ter ficado suspensa. O TID, o erro e a contagem anterior são registrados. **Sem retentativa** — `SuspendThread` devolve a contagem anterior e um `ResumeThread` extra decrementaria a suspensão de terceiros |
| `SuspendThread` falha | conta até 5, depois para | nada foi suspenso, não há retomada pendente; 5 é o teto antes de considerar o alvo inconsistente |
| `GetThreadContext` falha | **só conta**, nunca para | a retomada já ocorreu; é leitura ruim, não estado do alvo |
| janela > `--max-suspend-us` (2000 µs) | para | **orçamento de janela declarado**. Não é "1 frame": a 60 Hz um frame dura ~16,67 ms. 2 ms é só o teto aceito por amostra; pior medido: 931 µs |

Interrupção: para na hora, grava `stopReason`, exit 6, não repete.

---

## 4. Recuperação em morte abrupta

**`finally` não é garantia.** `TerminateProcess`, `kill`, crash do interpretador
ou queda de energia não executam o `finally`; a thread alvo pode ficar suspensa.

O registro que sobrevive é o journal, gravado a cada 5 sweeps:

```
local-data/trace-exec-partial-<ISO>.json
```

Verificado matando o Python no meio de uma coleta: 282 sweeps preservados,
20868 leituras, `startedAtIso` preenchido.

Procedimento:

1. Sintoma: janela do jogo não responde, CPU alta.
2. Ação: fechar o processo do jogo. Nada fica gravado; reiniciar desfaz.
3. Journal corrompido? Pode haver `.json.tmp`; o `.json` anterior é o último bom.
4. Nenhum código nosso fica no alvo: sem patch, sem `VirtualAlloc`, sem hook.
   A única herança possível é uma thread suspensa.

---

## 5. Procedimento

```
node tools/trace_exec_context.cjs --self-test
node tools/trace_exec_context.cjs --pid <PID> --verify-ranges \
  --ranges botfinal/config/ranges/pokealliance-2026-11-07.json
node tools/trace_exec_context.cjs --pid <PID> --run --seconds 5 \
  --ranges botfinal/config/ranges/pokealliance-2026-11-07.json
```

Entre o segundo e o terceiro: **o operador confirma que está no mundo, em área
livre.** Só então rodo.

Durante os 5 s: movimentos manuais breves — toques curtos de seta, com pausa.
Sem rajada longa. O coletor não envia tecla nem captura foco.

---

## 6. Leitura do resultado

| resultado | conclusão permitida |
| :--- | :--- |
| hit em `Game::walk` | "a thread TID X executou `Game::walk` em RIP R, às H". **Só isso** |
| `ripInRanges == 0` com contadores limpos | **inconclusivo** — chance de pegar 1 ms é ~8% |
| `resumeFailures > 0` | interrompido; ver `resumeFatal` |
| `contextFailures > 0` | medição quebrada, não negativo |
| TID coincide com `windowThreads` | registro de coincidência. **Não prova message loop** |
| TID diverge | registro de divergência. **Não prova necessidade de fila** |

Hits são evidência de execução da faixa. Não provam scheduler nem
funcionamento em background. Teste B e executor nativo seguem pendentes.
