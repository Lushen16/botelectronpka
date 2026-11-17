# Tentativa de coleta no jogo — 01

Data: 2026-11-08
Resultado: **FALHA — cliente encerrou durante a anexação, antes de o script executar.**

---

## 1. Pré-checagem (feita imediatamente antes do attach)

| item | valor |
| :--- | :--- |
| instância | **única** (`Get-Process` retornou 1) |
| PID | **6744** |
| criado | **2026-11-08T19:12:13Z** |
| módulo | `pokealliance_dx.exe`, base **0x7ff6437d0000**, size 103645184 |
| bytes `base+0x780c90` | `48895c2408555657` — **MATCH** |
| prólogo 16 B | `48895c240855565741564157488d6c24` — confere com a referência |
| hash em disco | `48C41BD4…0AC2B` |
| exe bitness | `0x8664` (x64), magic `0x20b` |
| módulos nossos no alvo | **nenhum** (79 módulos) |
| depurador concorrente | **nenhum** |
| bot ativo | não |

A identidade da função conferiu. A anexação prosseguiu legitimamente.

---

## 2. O que aconteceu

```
19:16:28Z  driver inicia
19:16:29Z  cdb -p 6744 -cf walktrace-game.txt
           "*** wait with pending attach"
           ModLoad: ... (79 módulos do cliente)
           (1a58.24ec): Break instruction exception - code 80000003
           ntdll!DbgBreakPoint:
           00007ff9`da183f40 cc    int 3
           <NATVIS unloaded ...>
           cdb encerra com 0x8007001E
```

- `1a58` = **6744** = o próprio cliente. O attach chegou ao break inicial.
- O script **nunca executou**: nenhum `.logopen`, `.printf`, `bp`, `bc` ou
  `.detach` aparece no log.
- O cliente **encerrou** durante a janela de attach.
- Nenhum breakpoint nosso foi instalado → nenhum byte foi alterado.
- Nenhum cdb ficou vivo. Nenhum processo órfão.

---

## 3. Código de saída

`2147942430` = `0x8007001E` = `HRESULT_FROM_WIN32(ERROR_BAD_COMMAND)`.

O cdb encerrou com falha de comunicação com o alvo — consistente com o alvo
ter terminado enquanto o depurador o inicializava.

---

## 4. Causa: não determinada

Duas hipóteses, **nenhuma confirmada**:

1. **Encerramento por detecção de depurador.** O cliente detecta attach e
   chama `TerminateProcess`. Não há confirmação; não há evento no log de
   Aplicação nem crash dump.
2. **Falha do próprio cliente ao ser suspenso.** O attach suspende todas as
   threads; se houver watchdog interno com timeout curto, ele pode encerrar.

O que **não** foi observado:

- nenhum `EXCEPTION_DEBUG_EVENT` além do break inicial;
- nenhuma mensagem do cliente no console do cdb;
- nenhum crash dump em `%LOCALAPPDATA%\CrashDumps`;
- nenhum evento 1000/1001/1026 no log de Aplicação nos últimos 20 minutos.

**Não vou afirmar anti-debug.** A evidência não sustenta essa conclusão — só
sustenta "encerrou durante o attach, motivo desconhecido".

---

## 5. Estado após o experimento

| item | estado |
| :--- | :--- |
| cliente | **encerrado** (não por mim — não havia `q`/`qd` no script, e o script nem rodou) |
| launcher | também não está rodando |
| cdb | não está rodando |
| exe em disco | presente, **não modificado** (`48C41BD4…0AC2B`, mtime 16:56:53Z) |
| breakpoints | **nenhum instalado** — o script nunca executou |
| bytes do cliente | **não tocados** |

Não houve limpeza a fazer porque nada foi instalado.

---

## 6. Autorização consumida

A autorização era para **uma** tentativa na instância revalidada. A tentativa
foi feita e falhou. **Não repeti automaticamente** e não vou repetir sem nova
autorização.

---

## 7. Próxima ação mínima sustentada pela evidência

A evidência não sustenta concluir anti-debug, então a próxima ação mais
econômica é **distinguir as duas hipóteses com um teste que não toca o
cliente**:

Rodar o mesmo procedimento cdb **no `walktrace_target.exe`**, mas desta vez
com o alvo já em execução por ≥60 s antes do attach — imitando a condição do
jogo (processo maduro, com estado) em vez do auxiliar recém-iniciado. Se o
auxiliar também morrer, o problema é do attach a processo maduro nesta
máquina, não do cliente. Se sobreviver, a diferença é específica do cliente.

Isso é um teste auxiliar, não uma coleta no jogo — e **não foi executado**
nesta rodada porque você pediu explicitamente para não repetir testes
auxiliares.

**Alternativa sem depurador**, para o objetivo declarado (thread + pilha):
reabrir a questão com a DLL congelada, que não depende de attach para
observar. Mas ela tem as limitações já documentadas (atribuição por `Dr0`,
gate de pendência nunca exercitado).

Decisão sua.

---

## 8. Evidência

```
local-data/cdb-tests/game-attempt-01/
  cdb-console.txt      log completo (134 linhas; attach e encerramento)
  driver-state.json    fases do driver: not_ready
  driver-out.txt       NOT_READY
  drive.py             script do driver usado
```

---

## 9. O que permanece intocado

- tracer congelado (`810A87FF…318B`)
- `WalkerEngine` (`2887A1E7…86864`), `native-step.cjs`, `pendingStep`
- 20/20 testes
- Teste B do walker segue pendência independente
