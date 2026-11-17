# Diagnóstico da tentativa 01 — conclusão

Data: 2026-11-08
Escopo: diagnóstico por evidência existente. Nenhum attach, nenhuma injeção.

---

## 1. Fatos e sequência temporal

Artefatos preservados em `local-data/cdb-tests/game-attempt-01/`:
`cdb-console.txt` (134 linhas), `driver-state.json`, `driver-out.txt`, `drive.py`.

| momento | evento | evidência |
| :--- | :--- | :--- |
| 19:16:28Z | driver inicia | `state.json` → `phase:"starting"` |
| 19:16:2x | cdb inicia com `-p 6744 -cf <SCRIPT>` | `state.json` → `cdb_pid:7008` |
| — | `*** wait with pending attach` | console linha 25 |
| — | 79 `ModLoad:` do cliente | linhas 26–120 |
| — | `(1a58.24ec): Break instruction exception - code 80000003` | linha 121 |
| — | `ntdll!DbgBreakPoint` `0x7ff9da183f40` | linhas 122–123 |
| — | prompt `0:068>` aparece | linha 124 |
| — | NATVIS unloaded; processo encerra | linhas 124–134 |
| 19:16:30Z | driver registra `not_ready`, exit `2147942430` | `state.json` |
| 19:19:0x | ausência do cliente confirmada | `Get-Process` vazio |

`1a58` = **6744** = o próprio cliente. O attach chegou ao break inicial.
**Nenhum comando do script executou** — não há `.printf`, `.time`, `bp`,
`bc` nem `.detach` no console.

---

## 2. Causa identificada

**O caminho passado ao `-cf` não existe.**

```
drive.py:  SCRIPT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇÃO OFICIAL\tools\cdb\walktrace-game.txt"
real:              C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\tools\cdb\walktrace-game.txt
                                        ^^^^^^^^^^^^^^^^^^^^   ^^^^^^
```

`Test-Path` do caminho usado no `drive.py` → **False**. Do caminho real → **True**.

O diretório real é `RECONSTRUÇAO OFIcial`; o script apontou para
`RECONSTRUÇÃO OFICIAL` — três divergências: `Ç`→`C`, `AO`→`ÃO`, `cial`→`CIAL`.

### Reprodução

Rodando o mesmo cdb com o mesmo `-cf` apontando para o caminho inexistente,
no auxiliar:

```
ModLoad: ... walktrace_target.exe
(86f8.3e6c): Break instruction exception - code 80000003
ntdll!DbgBreakPoint:
0:004> <NATVIS unloaded>          <- nenhum comando do script
exit = 0x8007001E
```

Comportamento **idêntico** ao do jogo: attach funciona, break inicial ocorre,
script silenciosamente não roda, cdb sai com `0x8007001E`.

### Correção do meu erro anterior

`0x8007001E` = `HRESULT_FROM_WIN32(30)` = **`ERROR_READ_FAULT`** ("The system
cannot read from the specified device"), **não** `ERROR_BAD_COMMAND` (22) como
escrevi no relatório anterior. Consistente com falha ao **ler** o arquivo de
script.

---

## 3. Classificação A / B / C

| categoria | veredito | base |
| :--- | :--- | :--- |
| **A. falha do cdb/procedimento** | **CONFIRMADA** | `-cf` com caminho inexistente; reproduzido no auxiliar |
| **B. encerramento do cliente** | **CONFIRMADO que ocorreu**, mas **consequência de A** | o cliente morreu porque o cdb saiu sem `.detach`; matar o depurador mata o alvo (já medido: `Stop-Job` → alvo morto) |
| **C. anti-debug / watchdog** | **INDETERMINADO, agora desnecessário** | não há evidência; o caminho A explica tudo |

**Não houve anti-debug.** A explicação mais simples e reproduzível é: script
não carregou → cdb encerrou sem `.detach` → cliente morreu com o depurador.

---

## 4. Correções ao relatório anterior

| afirmação | correção |
| :--- | :--- |
| "nenhum breakpoint nosso confirmado" | **correto**, e agora com motivo: o script nunca rodou |
| "attach produziu interferência e breakpoint inicial" | **correto**: `ModLoad` ×79, `code 80000003`, `ntdll!DbgBreakPoint` |
| "integridade do arquivo em disco" | **não prova integridade da memória.** Disco e memória são evidências distintas |
| "0x8007001E = ERROR_BAD_COMMAND" | **errado.** É `ERROR_READ_FAULT` (30) |
| "causa: anti-debug ou watchdog" | **errado.** Causa: caminho de script inexistente |

---

## 5. Erros concretos do procedimento

1. **Caminho hardcoded com acentos errados** no `drive.py`. Deveria ter sido
   derivado de `__file__`, não digitado.
2. **`-cf` falha silenciosamente.** O cdb não imprime erro quando o arquivo
   de script não existe — apenas segue para o loop interativo e sai. Não
   validei `Test-Path` antes de passar o caminho.
3. **Sem `.detach` executado**, o cliente morre com o depurador. Isso já era
   sabido e não foi mitigado por uma verificação de existência do script.

---

## 6. Próximo passo mínimo

**Reduz a incerteza?** Sim, e de forma barata: corrigir o caminho e validar
com `Test-Path` antes de anexar. Não é uma nova hipótese — é o mesmo
procedimento, com o único defeito identificado corrigido.

Para uma nova tentativa (separadamente autorizada), bastaria:

```powershell
$SCRIPT = "C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\tools\cdb\walktrace-game.txt"
if (-not (Test-Path -LiteralPath $SCRIPT)) { throw "script ausente: $SCRIPT" }
cdb.exe -p <PID> -cf $SCRIPT
```

Nenhuma ferramenta nova. Nenhum attach agora.

**Se não houver autorização**, esta investigação encerra aqui: causa
identificada, reproduzida, e nenhuma incerteza relevante sobrevive sobre o
jogo em si — o cliente não demonstrou anti-debug; ele morreu porque o
depurador saiu sem desanexar.

---

## 7. Pendência funcional — Teste B do walker

Preparado, **não executado**. O executor foreground existe e não depende do
executor nativo.

Cadeia já implementada em `botfinal/index.cjs:125` (`runWalk`):

```
CLI --walk=north --walk-steps=1
  -> NativeSession (attach ao transporte)
  -> waitForSnapshot(5000)
  -> CommandDispatcher.send('walk', dir, {verify:'position', verifyTimeoutMs:1200})
  -> transport -> pka_native.dll -> PostMessageW(seta)
  -> telemetria -> posicao observada
```

Comando:
```
node botfinal/index.cjs --walk=north --walk-steps=1 --walk-verify-ms=1200
```

**O que falta para uma tentativa separadamente autorizada:**

| requisito | estado |
| :--- | :--- |
| cliente aberto e no mundo | precisa |
| `pka_native.dll` carregada no cliente | precisa (não está) |
| build compatível | `0x780c90` confirmado hoje |
| autorização | separada desta |

Critério de aprovação (já definido): delta exato de 1 tile, `z` intacto,
mesma entidade, zero despacho tardio. Sem mudança de posição → "efeito não
confirmado", nunca "funcionou".

Não executo sem autorização própria para esse teste.
