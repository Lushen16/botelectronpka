# Coletor de contexto de execução — validação

Documento: `tools/trace_exec_context.cjs`
Data: 2026-11-07
Estado: **coletor validado; coleta no jogo PENDENTE**.

Este documento responde às cinco exigências antes de qualquer coleta no
cliente. Nada aqui valida nosso executor. Teste B e caminhada nativa própria
seguem pendentes.

---

## 1. Como o contexto das threads é obtido

Por thread, por amostra:

```
SuspendThread(tid)              <- thread PARA
GetThreadContext(tid, CONTEXT)  <- leitura
ResumeThread(tid)               <- thread VOLTA (finally incondicional)
```

### Duração medida, não estimada

Cada janela é cronometrada com `perf_counter_ns` e reportada em
`interference`:

| campo | significado |
| :--- | :--- |
| `calls` | quantas janelas |
| `totalSuspendedMs` | soma de todo tempo em que alguma thread ficou parada |
| `avgSuspendedUs` / `minSuspendedUs` / `maxSuspendedUs` | distribuição |
| `perThreadSuspendedMs` | quanto cada TID ficou parado |
| `maxSingleThreadMs` | pior janela única |

Medição real, 2 s, 74 threads: **11544 janelas, 354.78 ms suspensos,
avg 30.73 µs, max 931.4 µs**. Ou seja: a coleta suspendeu threads por ~18% do
tempo de parede *somado entre elas*. Não é "leitura sem interferência".

### Restauração em todos os caminhos

- `ResumeThread` está em `finally`, sempre.
- `SuspendThread` retornando `0xFFFFFFFF` → conta `suspendFailures`, não tenta
  retomar (nunca suspendemos).
- `ResumeThread` retornando `0xFFFFFFFF` → conta `resumeFailures`.
- Exceção, falha de leitura, Ctrl+C: o `finally` roda.
- `SuspendThread` devolve a contagem anterior. Valor > 0 significa que a thread
  já estava suspensa por outro motivo; nosso `ResumeThread` desfaz só a NOSSA
  suspensão, não a de terceiros.

### Risco residual (declarado, não escondido)

Se **este** processo morrer entre `SuspendThread` e `ResumeThread`, a thread
alvo fica suspensa e o jogo congela. Não há way de eliminar isso sem patch, e
patch é pior. Mitigação: janela de dezenas de µs, sem alocação entre suspender
e retomar, e processo vivo até o fim do loop.

---

## 2. O self-test: cinco verificações separadas

Antes de qualquer número do jogo, `--self-test` roda tudo localmente.

| # | verificação | o que exatamente prova |
| :--- | :--- | :--- |
| A | **leitura** | `GetThreadContext` retorna sucesso, `RIP != 0`, e a janela de suspensão é medida |
| B | **identidade** | o TID amostrado é o TID que `CreateThread` devolveu |
| C | **faixa conhecida** | todo RIP cai dentro de uma página própria com `jmp $`, cujo intervalo foi definido **antes** da amostragem |
| D | **controle negativo** | classificar contra `0x1000..0x2000` dá zero |
| E | **encanamento** | RIPs sintéticos caem nos baldes certos, com limite inferior inclusivo e superior exclusivo |

A separação importa: A pode passar com C falhando (lê lixo plausível), e B pode
passar com C falhando (lê a thread certa num endereço fora da faixa). O
relatório lista os cinco com PASS/FAIL independentes.

### Duas tentativas erradas, registradas

1. **Thread em `Sleep`, faixa = módulo de `Sleep`.** Falhou 0/40. Motivo real:
   `Sleep` leva a thread para `ntdll!NtDelayExecution` (syscall), então o RIP
   não está no módulo onde `Sleep` foi resolvido. Lição: a faixa não pode ser
   inferida de onde a função foi pega.
2. **Faixa derivada do min/max das próprias amostras.** Circular: sempre passa,
   não prova nada. Abandonada.

A versão válida usa página própria com `EB FE` (jmp $), alocada e escrita antes
de criar a thread. Todo RIP tem que ser `base+0`. É uma faixa externa à
amostragem.

Resultado atual: **A, B, C, D e E em PASS**, 40/40 amostras em `base+0`.

---

## 3. Contadores separados

`contextFailures === 0` **não** significa que o caminho foi observado. Significa
apenas que o mecanismo leu. Os baldes são distintos:

| contador | significado |
| :--- | :--- |
| `contextAttempts` | tentativas de `GetThreadContext` |
| `contextValid` | sucesso e `RIP != 0` |
| `contextFailures` | `GetThreadContext` retornou FALSE |
| `suspendFailures` / `resumeFailures` | `SuspendThread`/`ResumeThread` = `0xFFFFFFFF` |
| `openFailures` | `OpenThread` falhou |
| `ripOutsideModule` | RIP fora da imagem do jogo (ntdll, GPU, driver, ...) |
| `ripInModuleOutsideRanges` | RIP na imagem, em **nenhuma** faixa observada |
| **`ripInRanges`** | **RIP numa faixa observada — o único que conta** |

O balde vem de uma função única, `bucket(rip, base, size, ranges)`, usada pela
coleta **e** pelo self-test. Sem isso, [E] validaria uma cópia e não o caminho
de produção.

Verificação de ponta a ponta contra um processo não-jogo (notepad, `--force`,
1 s): 6000 tentativas, 6000 válidas, 0 falhas, **6000 em `ripOutsideModule`,
0 em `ripInRanges`** — exatamente o esperado, e é o que a saída chamou de
INCONCLUSIVO em vez de negativo.

---

## 4. Identidade antes de coletar

`--run` sempre executa o bloco de identidade primeiro:

| campo | fonte |
| :--- | :--- |
| PID, caminho do módulo | `Toolhelp32Snapshot` |
| arquitetura | `IsWow64Process` — WOW64 **aborta** (RVAs x64 não se aplicam) |
| base, tamanho | loader, **relidos a cada execução** |
| PE `TimeDateStamp` | cabeçalho PE na memória |
| PE `SizeOfImage`, `magic`, `checksum` | cabeçalho PE na memória |
| hash dos primeiros 1 KB | sha256 truncado |
| 8 bytes de cada faixa | RPM no RVA |

Byte divergente do build de referência (`REFERENCE_BUILD`, gravado a partir de
`local-data/trace-exec-2026-11-06T15-13-57-599Z.json`) → **RECUSA** com a lista
de faixas divergentes, código 5, a menos que `--force`.

Nenhum PID e nenhum endereço absoluto da sessão anterior são reaproveitados. Só
os **RVAs** são fixos, e mesmo eles são reconferidos byte a byte.

Build mudou → a evidência antiga não vale; isso é dito explicitamente, não
silenciado.

---

## 5. TIDs × windowThreads

O JSON traz `windowThreads` (threads donas de janela visível do processo).

| observação | leitura permitida |
| :--- | :--- |
| tid com hit **==** windowThread | "o caminho **pode** rodar no message loop" |
| tid com hit **!=** windowThread | "o despacho precisaria de uma fila" |
| sem hit | nada sobre isso |

Coincidência **não prova scheduler** nem exclui outro caminho de execução.
Divergência **não é erro** — é informação sobre onde postar o comando.

---

## 6. Coleta curta — procedimento

Pré-requisito: cliente aberto, personagem no mundo.

```
node tools/trace_exec_context.cjs --self-test
node tools/trace_exec_context.cjs --pid <PID> --verify-ranges
node tools/trace_exec_context.cjs --pid <PID> --run --seconds 20
```

**Ação manual durante o terceiro comando:** clicar na janela do jogo e andar
digitando as setas do teclado — 3 a 4 rajadas de ~2 s, com ~1 s de pausa. O
coletor não envia tecla, não captura foco, não instala hook. Sem a ação manual,
zero hits não significa nada.

Limite: 20 s por padrão, teto 120 s. Amostragem a cada 10 ms por thread.

---

## 7. Como ler o resultado

| resultado | conclusão |
| :--- | :--- |
| `selfTest` não 100% | coletor quebrado; nada abaixo é interpretável |
| `contextFailures > 0` ou `suspendFailures > 0` | INCONCLUSIVO, não negativo |
| `ripInRanges > 0` | houve observação; ver `summary` (tid, faixa, RIP, horário) |
| `ripInRanges == 0`, contadores limpos | **INCONCLUSIVO** — amostragem pode perder função curta |
| `ripOutsideModule` alto | normal: a maior parte do tempo as threads estão em ntdll/GPU |
| build divergente | recusa; re-derivar os RVAs antes |

**Zero hit nunca vira "não executa".** Vira "não observado nesta amostragem".

---

## 8. O que este teste NÃO faz

- não valida nosso executor;
- não prova que funciona sem foco ou minimizado;
- não prova equivalência com o throttle nativo;
- não decide arquitetura de despacho;
- não instala patch, hook, nem escreve no processo.

Só responde: **qual thread, em que endereço, que horas.** O resto continua
pendente.
