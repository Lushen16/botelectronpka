# Coleta CDB — procedimento fechado, cliente aguardando autorização

Data: 2026-11-07
Estado: **ensaio completo nos dois caminhos. Nada anexado ao PokeAlliance.**

---

## 1. A lacuna real: saída sem hit

**Ela estava aberta.** O ensaio anterior (alvo terminando em 4480 ms) não
demonstrava interrupção nem detach de processo vivo sem hit.

### Mecanismo: Ctrl+Break no console do cdb

`g` bloqueia o script. `CTRL_BREAK_EVENT` no processo do cdb interrompe o `g`
e o script **continua na linha seguinte**. Verificado:

```
=== STOP CLASSIFY ===
rip=00007ff9da183f40        <- ntdll!DbgBreakPoint
=== CLEANUP ===
bc *
=== DETACH ===
.detach
```

### Resultado medido

| item | valor |
| :--- | :--- |
| alvo | `walktrace_target.exe` mode 1 (função nunca chamada) |
| interrupção | `CTRL_BREAK_EVENT` aos 3,0 s |
| `r rip` após interrupção | `00007ff9da183f40` = `ntdll!DbgBreakPoint` |
| `bc *` | executou |
| `.detach` | executou |
| cdb morto à força? | **não** |
| alvo morto? | **não** |
| alvo vivo em t+1..t+4 s | **sim** (4/4) |
| alvo progredindo | `tick 5 → 6 → 7 → 8` |

**Isso não é timeout automático.** É interrupção operacional: alguém (ou o
wrapper) envia Ctrl+Break. Declarado como operação, não como timeout.

---

## 2. Distinção hit × interrupção — por RIP, não por código

Ambos chegam como `Break instruction exception - code 80000003`. O **código
não distingue**. A distinção é o RIP:

| parada | `r rip` |
| :--- | :--- |
| hit no alvo | `walktrace_target+0x1000` (`00007ff69a6d1000`) |
| interrupção manual | `ntdll!DbgBreakPoint` (`00007ff9da183f40`) |
| exceção inesperada | qualquer outro endereço |

O script registra `r rip` **depois** do `g` justamente para isso. Não se
interpreta retorno de `g` como hit válido.

---

## 3. Registro completo exigido

Script: `tools/cdb/walktrace-game.txt`

```
.printf "=== WALKTRACE BEGIN ===\n"
.time
bp pokealliance_dx+780c90 "r rip; r rdx; r r8; r rcx; kb"
g
.echo "=== STOP CLASSIFY ==="
r rip
.lastevent
.echo "=== CLEANUP ==="
bc *
.echo "=== DETACH ==="
.detach
```

| dado exigido | como é obtido | presente no log |
| :--- | :--- | :--- |
| timestamp | `.time` (início) + `.lastevent` (hora do evento) | sim |
| PID / TID do sistema | cabeçalho `(76c0.7314)` e `~.` | sim |
| RIP | `r rip` no bp e após `g` | sim |
| módulo+RVA | `kb` mostra `modulo+0xNNN` | sim |
| EDX / R8B | `r rdx` / `r r8`; `kb` mostra args | sim (registradores completos) |
| pilha | `kb` | sim |
| motivo da parada | `r rip` + `.lastevent` | sim |
| remoção do bp | `bc *` no log | sim |
| resultado do detach | `Detached` no log | sim |

Limitações de sintaxe descobertas no ensaio (e removidas do script):
`$pid`/`$tid` não resolvem dentro do `.printf` neste cdb; `.echo` dentro do
comando do bp quebra o parser; `g` dentro do bp prende o controle.

---

## 4. Correções de documentação (erros meus)

| afirmação anterior | correção |
| :--- | :--- |
| "mtime anterior ao processo prova que o hash descreve a imagem" | **falso.** Prova só que o arquivo não mudou no disco depois do início. A imagem em memória é evidência separada: bytes lidos do processo |
| "error 299 prova ASLR" | **não prova sozinho.** 299 = `ERROR_PARTIAL_COPY`. Causas possíveis: endereço não mapeado, base diferente, leitura cruzando página inválida. ASLR é a explicação mais provável dado o contexto, não a demonstração |
| "bp é leitura pura" | **falso.** `bp` grava `0xCC` no código do alvo e restaura no `bc`. Modifica temporariamente |
| "qd mata o alvo" | **errado.** Medição contaminada por eu fechar o notepad no mesmo teste. Refeito 4×: `qd` preserva, `q` mata, `.detach` preserva |

Evidências separadas a registrar:

- **hash em disco**: `48C41BD4…0AC2B`, size 30921776, mtime 16:56:53Z
- **bytes em memória**: `base+0x780c90` = `48895c2408555657` (lido do processo)
- **base do módulo**: `0x7ff7ce5d0000` (lida do loader, não presumida)

---

## 5. Saída com hit — validada

```
=== BEGIN ===
Debug session time: Sun Nov  8 00:17:05.131 2026
bp walktrace_target+1000 "r rip; r rdx; r r8; r rcx; kb"
g
rip=00007ff69a6d1000
rdx=0000000000000000
r8=000000c2e0bff7e8
rcx=0000000000000001
walktrace_target+0x1000
walktrace_target!WalkingTraceTargetEntry+0x57b
KERNEL32!BaseThreadInitThunk+0x17
ntdll!RtlUserThreadStart+0x2c
=== STOP CLASSIFY ===
r rip -> walktrace_target+0x1000  (hit)
=== CLEANUP ===
bc *
=== DETACH ===
Detached
```

Alvo após detach: `calls 22 → 36 → 50 → 70 → 86 → 98 → 120 → 134 → 148 → 170`,
vivo em t+4 s. (O `alive=False` de um ensaio anterior era eu encerrando o alvo
no fim do meu próprio script.)

Byte restaurado: `55` antes do bp, `55` depois do `bc *`.

---

## 6. Pré-checagem para o cliente (será refeita no momento)

Estado agora:

| item | valor |
| :--- | :--- |
| PID | 24800 (vivo) |
| criado | 2026-11-07T16:57:28Z |
| módulo | `pokealliance_dx.exe` base `0x7ff7ce5d0000` |
| bytes em `base+0x780c90` | `48895c2408555657` conferem |
| hash em disco | `48C41BD4…0AC2B` |
| módulos nossos no alvo | nenhum (79 módulos) |
| outros depuradores | nenhum |
| cdb | 10.0.29680.1004 |

**Será revalidado imediatamente antes de anexar** — PID, criação, base, bytes.
Nada será herdado deste documento.

---

## 7. Comando exato e prazo

```powershell
cd C:\Users\yago\Documents\Clone\RECONSTRUÇÃO OFICIAL\local-data\cdb-tests
cdb.exe -p <PID_VERIFICADO> -cf ..\..\tools\cdb\walktrace-game.txt
```

- **sem `-o`**
- **prazo**: 20 s de janela. Ao final, Ctrl+Break no console do cdb (ou o
  wrapper envia) → `bc *` → `.detach`. Não se mata o cdb nem o alvo.
- **um toque manual** de seta durante a janela.

---

## 8. Riscos

| risco | severidade | nota |
| :--- | :--- | :--- |
| pausa do cliente no attach | média | attach suspende threads por instantes |
| `0xCC` visível | média | janela de ~20 s, removido no `bc *` |
| cdb morre sem `.detach` | média | alvo morre |
| cliente encerra por anti-debug | **desconhecida** | não testado, não contornado |
| breakpoint não dispara | baixa | saída sem hit ensaiada |

---

## 9. Pedido de autorização

Autorização específica para **uma anexação** ao PID verificado e **um toque
manual**:

1. Você põe o personagem em área livre e o jogo em primeiro plano.
2. Eu revalido PID/instância/base/bytes e ausência de depurador concorrente.
3. `cdb -p <PID> -cf tools\cdb\walktrace-game.txt`
4. Você dá um toque breve de seta.
5. Capturo, `bc *`, `.detach`.
6. Confirmo: mesma instância viva, bytes restaurados, cliente retomando
   execução (não apenas PID existente).

Sem envio de teclas por mim. Sem captura de foco. Sem chamar funções do
cliente. Sem repetição automática.

---

## 10. Limites do resultado

Um hit prova que **aquela thread alcançou aquele endereço**. Não prova
scheduler, thread safety, executor nativo, background ou minimizado.

Identificar a thread **não** resolve como agendar uma chamada nela. Agendar
exige saber se aquela thread processa mensagens, se há fila, e se a chamada
seria segura de fora — nada disso é dado por um breakpoint na entrada.

Teste B do walker segue pendência independente: não precisa do executor
nativo, desde que o executor foreground seja compatível com `0x780c90`, que
confere hoje.
