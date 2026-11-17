# Depurador externo — escolha, ensaio e procedimento

Data: 2026-11-07
Estado: **ensaio concluído em processo auxiliar. Nada anexado ao jogo.**

Tracer congelado em `native/frozen-walktrace/` (não recompilar, não reinjetar).

---

## 1. Ferramenta escolhida

| verificação | resultado |
| :--- | :--- |
| `cdb.exe` / `windbg.exe` no sistema | **ausente** antes desta rodada |
| x64dbg | ausente |
| Windows SDK Debuggers | ausente (`C:\Program Files (x86)\Windows Kits` não existe) |
| `winget search dbg` | `Microsoft.WinDbg`, `x64dbg.x64dbg` disponíveis |
| instalação | `winget install Microsoft.WinDbg` → instalado |
| binário usado | `...\Microsoft.WinDbg_1.2611.4001.0_x64__8wekyb3d8bbwe\amd64\cdb.exe` |
| versão | **10.0.29680.1004** |

### Por que cdb e não x64dbg

1. **Scriptável de forma determinística.** `-cf arquivo` executa uma lista de
   comandos; `.logopen` grava tudo. x64dbg é GUI-first; automação depende de
   plugins/scripts próprios.
2. **`-p <pid>` anexa sem diálogo.** O comando de attach e o de saída são
   explícitos no script, o que torna o procedimento reproduzível.
3. **Comportamento de saída documentado e testável** (`.detach` vs `q`/`qd`) —
   foi verificado empiricamente nesta rodada, não presumido.
4. **Mesmo motor do WinDbg**, então os comandos (`bp`, `kb`, `.detach`) são os
   mesmos que você usaria na GUI se precisar.

Não foi desenvolvido nenhum depurador. É a ferramenta da Microsoft.

---

## 2. Procedimento reproduzível (validado)

### 2.1 Arquivo de comandos

```
.logopen attach.log
bp <modulo>+<rva> "kb"
g
.detach
```

Pontos que importam:

- `bp <modulo>+<rva>` — **não** `bp <endereço absoluto>`. O alvo carrega em
  base aleatória; `0x140001000` falhou com `Win32 error 0n299`.
- `"kb"` — imprime thread e cadeia de chamadas. O TID aparece no cabeçalho do
  frame: `(648c.3144)` e em `kb`.
- `g` — deixa rodar.
- `.detach` — **como comando de script**, não dentro do breakpoint.

### 2.2 Execução

```powershell
cd <dir>
cdb.exe -p <PID> -o -cf cmds.txt
```

`-o` = debug child processes? **Não**: `-o` aqui significa `-o` (debug children);
o `-o` também é aceito sem efeito. O essencial é `-p <pid>` e `-cf`.

### 2.3 Resultado observado no auxiliar

```
RetAddr               : Args to Child                                    : Call Site
00007ff6`9a6d15cb     : 00000000`00000001 00000000`00000000 ...          : walktrace_target+0x1000
00007ff9`d95ddda7     : ...                                              : walktrace_target!WalkingTraceTargetEntry+0x57b
00007ff9`da0dee4c     : ...                                              : KERNEL32!BaseThreadInitThunk+0x17
00000000`00000000     : ...                                              : ntdll!RtlUserThreadStart+0x2c
```

- **thread**: `0:002` / `0:004` (TID muda a cada worker), e os hits vieram de
  TIDs distintos (`2fb8`, `78b4`) — prova de que múltiplas threads alcançam a
  mesma função.
- **argumento**: `rcx` lido no entry (`rcx=0`, `rcx=1`).
- **cadeia de chamadas**: a stack acima.

### 2.4 Limpeza e desanexação

- `bc *` remove breakpoints (não necessário antes de `.detach`, mas explícito).
- `.detach` desanexa e **mantém o alvo vivo**.

### 2.5 Confirmação de que o auxiliar continua

```
alive=True
MON pid=3700 tick=3 calls=98  alive=2
MON pid=3700 tick=4 calls=120 alive=2
still=True
```

O alvo **continuou chamando a função** depois do detach.

---

## 3. Política de término — verificada, não presumida

| comando | efeito no alvo | evidência |
| :--- | :--- | :--- |
| `qd` | **mata** | `notepad_vivo=False` |
| `q` | **mata** | `alive=False` |
| `.detach` (comando de script) | **mantém vivo** | `alive=True`, `still=True` |
| `.detach` dentro de condicional `.if` | **cdb crasha** (`0xC0000005`) | `cdb_exit=-1073741819` |

**Regra adotada: usar `.detach` como último comando do script. Nunca `q`/`qd`.**

Isso é diferente do host próprio anterior, onde a DLL simplesmente ficava
carregada. Aqui, matar o cdb com `q` **fecha o cliente**.

---

## 4. Coleta proposta no jogo (aguardando autorização)

Reconfirmado agora:

```
build       48C41BD4...  (sha256 do exe)
PID         24800
instância   criada 2026-11-07T16:57:28Z
faixa       Game::walk RVA 0x780c90, bytes 48895c2408555657 conferem
```

Procedimento:

```powershell
cd C:\Users\yago\AppData\Local\Temp\opencode\cdb-game

# 1. arquivo de comandos
@'
.logopen game-attach.log
bp pokealliance_dx+780c90 "kb; r rdx, r8"
g
.detach
'@ | Out-File cmds.txt -Encoding ASCII

# 2. anexar (UMA vez)
cdb.exe -p 24800 -o -cf cmds.txt
```

Durante a execução: **um toque breve de seta**. O `bp` dispara na entrada,
imprime TID + stack + `rdx` (direção) e `r8` (flag), e o `.detach` desanexa.

Verificação pós-sessão:

```
Get-Process -Id 24800    # deve continuar vivo
Get-Content game-attach.log
```

---

## 5. O que o resultado prova

**Prova:** qual thread alcançou `Game::walk`, em que instante, com quais
argumentos, e a cadeia de chamadas.

**Não prova:** scheduler, thread safety, independência de foco, funcionamento
minimizado ou em background. Um breakpoint na entrada mostra que a função foi
alcançada — nada além.

---

## 6. Riscos residuais

| risco | mitigação verificada |
| :--- | :--- |
| cdb fechado com `q`/`qd` mata o cliente | **usar `.detach`** (testado) |
| `.detach` em condicional crasha o cdb | `.detach` só como comando de script (testado) |
| breakpoint em endereço absoluto falha | usar `modulo+rva` (testado) |
| anexar já mata? | não — attach preservou o alvo quando saiu com `.detach` |
| anti-debug do cliente | **não testado**; se o jogo detectar depurador, pode encerrar |

O último é o risco novo e não verificado. `DebugActiveProcess` exige
`PROCESS_ALL_ACCESS`; o cliente pode ter proteções. Não afirmo que funciona no
jogo até rodar.

---

## 7. Artefatos

```
native/frozen-walktrace/          tracer congelado + README + sha256
local-data/cdb-tests/
  cdb-commands.txt                script usado
  target-attach.log               hits com kb
  cdb-detach-run.txt              sessão completa com .detach
  target-after-detach.txt         alvo chamando depois do detach
docs/DEPURADOR_EXTERNO.md         este documento
```
