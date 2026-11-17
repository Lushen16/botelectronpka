# Tentativa de coleta no jogo — 02

Data: 2026-11-08
Resultado: **SEM HIT. Cliente sobreviveu, bytes restaurados, desanexado.**
Causa do zero hits: **indeterminada** — o toque manual não produziu passo.

---

## 1. Pré-checagem (antes do attach)

| item | valor |
| :--- | :--- |
| instância | única |
| PID | **28308** |
| criado | **2026-11-08T19:50:39Z** |
| base | `0x7ff6437d0000`, size 103645184 |
| bytes `+0x780c90` (8 B) | `48895c2408555657` — **MATCH** |
| bytes `+0x780c90` (16 B) | `48895c240855565741564157488d6c24` — confere |
| hash em disco | `48C41BD4…0AC2B` |
| módulos nossos | nenhum (79) |
| depurador concorrente | nenhum |
| script | `walktrace-game-ascii.txt`, `Test-Path` → **True**, 0 bytes não-ASCII |

---

## 2. Sequência

| momento (UTC) | evento |
| :--- | :--- |
| 20:19:47 | driver inicia |
| 20:19:48 | **ARMED** (`state.json`), `READY_FOR_TAP` |
| 20:19:48–20:20:08 | janela de 20 s para o toque |
| 20:20:08 | `NO_HIT_20S_CTRL_BREAK` — interrupção operacional |
| 20:20:08 | `r rip` = `00007ff9da183f40` = `ntdll!DbgBreakPoint` → **interrupção, não hit** |
| 20:20:08 | `bc *` → `.detach` → `Detached` |
| 20:20:08+ | cliente vivo, 67 threads |

O breakpoint foi instalado: `breakpoint 0 redefined` (linha 179 do console).

---

## 3. Classificação da parada

`r rip` = `0x7ff9da183f40` = `ntdll!DbgBreakPoint`.
`Game::walk` está em `base+0x780c90` = `0x7ff6437d0000+0x780c90` = `0x7ff64af50c90`.
**Não coincide.** Portanto: **sem hit**, parada por interrupção operacional. Não
interpretei retorno de `g` como sucesso.

---

## 4. Limpeza e continuidade — verificadas

| verificação | resultado |
| :--- | :--- |
| bytes após o detach | `48895c240855565741564157488d6c24` — **RESTAURADO** (igual ao pré-attach) |
| cliente vivo | **sim**, PID 28308 (mesma instância, criada 19:50:39Z) |
| threads | 67 ativas |
| cdb | encerrado, nenhum órfão |
| breakpoints | removidos (`bc *` + detach) |

O `0xCC` não persistiu. O cliente retomou execução (67 threads vivas 20 s depois).

---

## 5. Por que zero hits — indeterminado

Não há evidência suficiente para afirmar a causa. Possibilidades, sem hierarquia:

1. O toque de seta não gerou passo (fora de área livre, tecla engolida pelo
   jogo em primeiro plano, ou janela sem foco no momento).
2. O caminho da tecla não passa por `Game::walk` naquele RVA neste build.
3. O passo foi processado antes de o breakpoint estar ativo, ou depois da
   janela.
4. O jogo usou o loop contínuo (`0x7b4740`/`lambda-autowalk-tick`) em vez de
   uma chamada única a `Game::walk`.

Nenhuma dessas foi testada. **Não classifico como "a função não é chamada".**

---

## 6. Defeito de procedimento remanescente (menor)

O script usado (`walktrace-game-ascii.txt`) tem 0 bytes não-ASCII, mas ainda
contém linhas `//` — e o cdb emite `Syntax error in '//'` para cada uma,
poluindo o log. Não impede a execução (os comandos rodaram), mas o ideal é
remover comentários do arquivo executado.

Isso **não** afetou o resultado: `WALKTRACE BEGIN`, `bp`, `g`, `STOP CLASSIFY`,
`r rip`, `bc *`, `.detach` todos executaram.

---

## 7. Evidência

```
local-data/cdb-tests/game-attempt-02/
  cdb-console.txt              232 linhas, tentativa completa
  state.json                   fases do driver
  driver-out.txt               READY_FOR_TAP / NO_HIT_20S_CTRL_BREAK / CDB_EXIT
  drive.py                     driver usado
  walktrace-game-ascii.txt     script executado
```

---

## 8. Próxima ação mínima

Nenhuma nova infraestrutura. A hipótese mais barata de descartar é a **1**
(toque não gerou passo):

- confirmar que o personagem realmente se moveu durante a janela (você viu
  deslocamento na tela?);
- se não se moveu, repetir com um toque mais longo (ex.: 1 s de seta
  pressionada) em vez de um toque breve.

Se o personagem **se moveu** e ainda assim não houve hit, a hipótese 2 ganha
peso: o caminho não é `Game::walk` nesse build, e o próximo passo seria
investigar `0x7b4740` (wrapper) e o loop contínuo — que já estão mapeados.

Precisa de nova autorização para uma segunda anexação.

---

## 9. Não validado

Hit não ocorreu, então nada foi provado sobre:
scheduler, thread safety, executor nativo, background, minimizado.
Nem que `Game::walk` é o caminho usado pelo teclado neste build.
