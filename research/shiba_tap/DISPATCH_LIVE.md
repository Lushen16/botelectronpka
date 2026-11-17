# Dispatcher nativo — build LIVE (v3.3.1, 2026-11-04)

## RESOLVIDO: cadeia completa do ataque

```
1. entrada        0x15280        (dl = 0 attack / 1 follow, ecx = targetId)
2. resolve tipo   0x284b0        lookup(typeinfo) -> offset do handler
3. lookup alvo    0x7bc2f0       std::map<id, entidade>, chave = r8 (targetId)
4. dispatch final 0x1db40        chamado 2x: 1o resolve, 2o executa
5. handler attack exe+0x783000   rdx = ponteiro da entidade resolvida
   handler follow exe+0x7831d0
```

### A estrutura de typeinfo escolhe attack vs follow

```
0xe50b8  ->  chave 0x7105e0  ->  handler exe+0x783000   ATTACK
0xe50d8  ->  chave 0x7107e0  ->  handler exe+0x7831d0   FOLLOW
```

E o código em `0x153df..0x15416` decide:

```
0x153df  test bpl, bpl              ; bpl = dl original (0=attack, 1=follow)
0x153e2  lea rax, [0xe50d8]         ; follow
0x153e9  lea rcx, [0xe50b8]         ; attack
0x153f3  cmovne rcx, rax            ; se dl != 0, usa follow
0x153f0  mov rdx, r14               ; r14 = ponteiro da entidade
0x15416  call 0x1db40               ; dispatch
```

## Prova em execução

O handler de attack (`exe+0x783000`) apareceu **14 vezes, 100% em combate**:

```
r8=0  rdx=656576275504  r9=0  type=6
r8=0  rdx=656576275856  r9=0  type=6
r8=0  rdx=656576275504  r9=0  type=6
...
```

`rdx` alterna entre dois valores — são **dois alvos distintos** (o ponteiro da
entidade resolvida pelo lookup anterior). `r8 = 0` porque no estágio final o
id já foi consumido pelo lookup.

E o lookup (`exe+0x7bc2f0`) recebeu **36 targetIds distintos** em 244 chamadas:

```
1082733237, 1082739878, 1082731977, 1082744246, 1082709863,
1082750322, 1082743678, 1082743680, 1082755916, ...
```

O dispatcher **varre** os alvos no lookup e só chama o handler de attack para
o escolhido.

## Assinatura final

```
0x15280(ecx = targetId, dl = modo)
  modo 0 = attack  ->  0xe50b8  ->  exe+0x783000
  modo 1 = follow  ->  0xe50d8  ->  exe+0x7831d0
  retorno al: 1 despachado, 0 falhou
```

## Handler de attack — prólogo

```
+0x783000  mov [rsp+0x18], rbx
+0x783005  mov [rsp+0x20], rsi
+0x78300a  push rdi
+0x78300b  sub rsp, 0x50
+0x78300f  mov rax, [exe+0x226f040]     ; stack cookie
+0x783016  xor rax, rsp
+0x78301e  movzx esi, r8b               ; flag extra
+0x783022  mov rdi, rdx                 ; ponteiro da entidade
+0x783028  mov [rsp+0x40], rdx
+0x78302d  cmp byte [rcx+0x2648], 0      ; gate de prontidão
+0x78303a  mov rdx, [rcx+0x2508]
+0x78304a  cmp byte [rdx+0xb0], 0        ; tem alvo?
+0x783057  cmp byte [rcx+0x264a], 0
+0x783064  mov rcx, [rcx+0x2548]
```

Tem stack cookie (`__security_cookie`), então não adianta chamar de fora sem
respeitar o alinhamento de pilha.

## O que isso habilita no nosso bot

O nosso `pka_native.c` responde `status 3` para `attack` porque "não existe
tecla". Está correto — **não existe tecla**. O caminho real é:

```
chamar 0x15280 com (targetId, modo)
```

Mas isso exige executar dentro do processo do jogo, e o handler tem stack
cookie. As opções:

1. **chamar `0x15280`** de dentro do jogo (CreateRemoteThread) — respeitando a
   convenção de pilha
2. **hookar o dispatch** e injetar o comando no fluxo do próprio runtime

A opção 2 é mais segura: o runtime já está no contexto certo, com pilha válida
e cookie correto. A gente só fornece o `targetId`.

## A tabela, medida em execução

| alvo (exe+) | chamadas | entrada | comportamento |
| :--- | ---: | :--- | :--- |
| `0x7bbd80` | 19.976 | `0xe5430` | tick/loop |
| `0x784ba0` | 202 | `0xe53d0` | lure |
| `0x77f250` | 48 | `0xe5590` | travel |
| `0x782d50` | 35 | `0xe5510` | `rdx=3453` fixo |
| `0x30f080` | 41 | `0xe53b0` | misto |
| `0x7bc2f0` | 244 | `0xe5530` | lookup por `r8` = targetId |
| **`0x783000`** | 14 | `0xe5490` | **ATTACK** (100% combate) |
| `0x783470` | 7 | `0xe5570` | dispatch por slot |
| `0x784060` | 5 | `0xe54f0` | 100% combate |
| +6 outros | 1-3 | vários | 100% combate |

## Chamada externa — TESTADA NO JOGO

`native/pka_call_attack.dll` chama o dispatcher de dentro do processo do jogo.

### Dry-run (validação sem efeito)

```
estado: ready=1 reentry=0 base=0x7ff790cc0000 type=6
dispatcher = 0x7ffcfdd95280 (msftedit.dll+0x15280)
dry-run: tudo valido, mas fire=0 targetId=0. Nada chamado.
```

Valida antes de qualquer coisa: módulo carregado, `ready != 0`, `reentry == 0`,
base de dispatch não nula, dispatcher legível/executável.

### Chamada real

```
estado: ready=1 reentry=0 base=0x7ff790cc0000 type=6
CHAMANDO dispatcher(targetId=1082733237, mode=0)
resultado: 0 (falhou)
```

**0 = falhou** era o esperado: o id veio de uma captura anterior e a criatura
já não existe mais. O `std::map` não achou a chave e o dispatch devolveu 0 —
sem crash, sem efeito colateral. **O jogo continuou vivo e o bot operando.**

Isso prova três coisas:

1. a chamada externa **funciona** (não crashou, retornou corretamente)
2. o caminho de validação (`ready`/`reentry`/base) está correto
3. retorno 0 é distinguível de sucesso — dá para detectar falha

### Config

`native/pka_attack_config.txt`:

```
module=msftedit.dll
dispatcher_rva=15280
fire=0              # 1 = chama de verdade
target_id=0         # id da criatura
mode=0              # 0 attack, 1 follow
```

### Como usar

```cmd
:: 1. com o jogo e o bot rodando
native\pka_inject.exe --pid <pid> --dll native\pka_call_attack.dll

:: 2. ler o resultado
type %TEMP%\pka_call_attack.log
```

`resultado: 1` = despachado. `resultado: 0` = alvo inválido / runtime não pronto.

### Ressalvas

- **A DLL só executa uma vez por processo.** O export `PkaCallAttack` tem guard
  `InterlockedExchange(&started, 1)`. Para chamar de novo, injete uma cópia com
  outro nome (`pka_call_attack_2.dll`, `_3.dll`, ...).
- **O handler tem stack cookie** (`__security_cookie` em `exe+0x226f040`).
  Chamar pelo dispatcher é seguro porque ele roda no contexto do runtime. Chamar
  `exe+0x783000` direto é arriscado.
- `mode=1` (follow) usa `0xe50d8` → `exe+0x7831d0`, nunca observado em execução
  nas capturas (o bot nunca usou follow).

### O problema do id obsoleto

O `targetId` tem que ser de uma criatura **viva na tela naquele instante**. O
jeito correto: ler a telemetria (`creatures[]`), pegar um `id` com
`canAttack: true`, e usar imediatamente. Id de captura antiga retorna 0.

---

## Histórico da investigação

## Fonte

---

## Histórico da investigação

## Fonte

```
dumps/msftedit_live_32036.bin     imagem crua, 0x328000 bytes
dumps/msftedit_live_32036.json    metadados (base, pid, sha256)
sha256  0e27ea776e99de84ced78a940385f32a6b177c6eca6bb6e2945cec8a8efc9ec0
```

Sem header PE (module stomping): os offsets são de **imagem**, não de arquivo.
Os scripts `tap_*` já trabalham por offset de imagem.

## Comparação entre builds

| | dump 22/10 | live 04/11 |
| :--- | :--- | :--- |
| tamanho | 3.309.568 (0x328000) | 3.309.568 (0x328000) |
| sha256 (imagem) | `1c8116e520bf1bc0…` | `0e27ea776e99de84…` |
| blocos 4 KB iguais | — | 205 / 808 (25,4%) |
| blocos diferentes | — | 603 / 808 (74,6%) |

Mesmo tamanho, conteúdo majoritariamente diferente. O reloc mudou tudo de
lugar; é build nova, não a mesma com páginas trocadas.

## Strings do dispatcher (build live)

```
0xe83e0   [native] Client profile %s verified (%zu functions); Game RVA %llX, dispatcher RVA %llX.
0xe8918   [native] Resolving %s target %u.
0xe8940   [native] Dispatching %s target %u.
```

Referências (via `lea reg,[rip+disp]`):

```
0x16908  -> profile
0x152ea  -> resolving
0x15345  -> resolving
0x153d3  -> dispatching
```

## Função do dispatcher: RVA 0x15280

Desmonte com strings resolvidas:

```
0x15280  mov [rsp+8], rbx
0x15285  mov [rsp+0x10], rbp
0x1528a  push rsi
0x1528b  push rdi
0x1528c  push r14
0x1528e  sub rsp, 0x60
0x15292  movzx ebp, dl              ; bpl = modo (0=attack, 1=follow)
0x15295  mov edi, ecx               ; edi = targetId
0x15297  call 0x1dc20               ; valida runtime pronto
0x1529c  test al, al
0x1529e  je 0x153a2                 ; nao pronto -> retorna 0
0x152a4  mov r14, [rip+0x20fa05]    ; r14 = base da tabela (RVA 0x224cb0)
0x152ab  lea edx, [rbp+0x253]       ; indice = modo + 0x253
0x152b1  shl edx, 4                 ; * 16
0x152b4  mov rcx, r14
0x152b7  call 0x1f470               ; resolve entrada
0x152bc  mov rcx, rax
0x152bf  xor edx, edx
0x152c1  call 0x4e80                ; <<< RESOLVE O ALVO
0x152c6  mov rdx, rax
0x152c9  test rax, rax
0x152cc  jne 0x152fb
0x152d2  test bpl, bpl
0x152d5  lea rax, [rip+0xd3628]     ; "follow"
0x152dc  lea rsi, [rip+0xd3629]     ; "attack"
0x152e6  cmovne rsi, rax
0x152ea  lea rcx, [rip+0xd3627]     ; "[native] Resolving %s target %u."
0x152f4  call 0x12190               ; log
0x153d3  lea rcx, [rip+0xd3566]     ; "[native] Dispatching %s target %u."
0x153da  call 0x12190               ; log
0x15384  call 0x1db40               ; <<< DISPATCH FINAL
```

## Assinatura de identidade

A função começa com:

```
48 89 5c 24 08 48 89 6c 24 10 56 57 41 56 48 83
```

Procurar essa sequência em qualquer build futura localiza o dispatcher sem
depender de RVA fixo.

## Diferenças vs build antiga

| item | dump 22/10 | live 04/11 |
| :--- | :--- | :--- |
| dispatcher | `0x12c40` | **`0x15280`** |
| tabela (ponteiro) | `[rip+0x210a95]` | **`[rip+0x20fa05]`** |
| slot da tabela | RVA `0x223700` | **RVA `0x224cb0`** |
| resolve entrada | `0x4dc0` | **`0x1f470`** |
| resolve alvo | `0x4c60` | **`0x4e80`** |
| dispatch final | `0x19b20` | **`0x1db40`** |
| log | `0xfcf0` | **`0x12190`** |
| validar pronto | `0x19c30` | **`0x1dc20`** |

A **estrutura é a mesma**: carrega tabela, indexa com `(modo + 0x253) << 4`,
resolve, chama. Só os endereços mudaram.

## Assinatura de chamada

```
ecx = targetId   (o id da criatura)
 dl = modo       0 = attack, 1 = follow
retorno: al      1 = despachado, 0 = falhou
```

Confirmado por `movzx ebp, dl` e `mov edi, ecx` no prólogo, e por
`cmovne rsi, rax` escolhendo a string "follow" quando `bpl != 0`.

## O que ainda falta

1. ~~Valor do ponteiro em runtime.~~ **RESOLVIDO** — ver abaixo.
2. ~~O que `0x1db40` faz.~~ **RESOLVIDO** — ver abaixo.
3. Como chamar daqui.

## Cadeia completa do dispatch (resolvida)

`0x1db40` não é o dispatch final — é o **trampolim genérico**. Desmonte:

```
0x1db4e  mov r15, r9                    ; arg5
0x1db51  mov r12, r8                    ; arg4
0x1db54  mov r13, rdx                   ; arg3
0x1db57  mov rsi, rcx                   ; arg2 (ponteiro para a entrada de tipo)
0x1db5a  mov rbx, [rsp+0xb0]            ; arg7 (flag de retorno)
0x1db6a  cmp byte [0x22474f], 0         ; runtime pronto?
0x1db71  je 0x1dc08                     ; não -> retorna 0
0x1db77  cmp byte [0x224a32], 0         ; reentrância?
0x1db7e  jne 0x1dc08
0x1db84  mov edi, [0x224d10]            ; guarda o offset anterior
0x1db94  mov ecx, [0x224d14]            ; ecx = TIPO
0x1db9a  call 0x284b0                   ; lookup(tipo) -> rax
0x1db9f  mov edx, [rax]                 ; edx = OFFSET do handler
0x1dba1  mov [0x224d10], edx            ; grava o offset usado
0x1dbaa  call 0x284b0                   ; segundo lookup
0x1dbb5  mov r10d, [rax]
0x1dbb8  add r10, [0x224cd0]            ; + BASE  (= base do exe do jogo)
0x1dbdd  call r10                       ; <<< CHAMADA FINAL
0x1dbe8  mov [0x224d10], edi            ; RESTAURA o offset anterior
```

Dois detalhes que enganam:

- **`[0x224d10]` é restaurado** depois da chamada. Ler esse endereço de fora
  quase sempre devolve 0. Ele só tem o offset durante a chamada.
- **`[0x224cd0]` é a base do `PokeAlliance_dx.exe`**, não do msftedit.
  Confirmado no processo vivo: `0x7ff790cc0000` = exe base + 0x0.

## A tabela (0xe53b0) — decodificada

Entradas de **0x20 bytes**, cada uma `{dword tipo?, dword handler_rva}`. Os
handlers são RVAs **dentro do `PokeAlliance_dx.exe`** e apontam para funções
reais (prólogo válido):

```
0x0e53b0  0x0030f080   48 89 5c 24 08 57 48 83 ec 20   push rbx; push rdi; sub rsp,0x20
0x0e53d0  0x00784ba0   48 83 ec 28 80 b9 48 26 00 00   sub rsp,0x28; cmp byte [rcx+0x2648],0
0x0e53f0  0x00810350   53 41 52 e8 ab 54 b3 03         push rbx; push r9; push r10
0x0e5410  0x0067c790   40 55 53 56 57 41 54 41 55      push rbp..r13
0x0e5430  0x007bbd80   48 89 5c 24 08 44 8b 1a 48 8b   mov [rsp+8],rbx; mov r11d,[rdx]
```

Todas as 28 entradas da faixa primária têm handler legível. As faixas
`0xe5990` e `0xe6970` seguem o mesmo formato (mais 10+ entradas).

`0x284b0` é o **lookup por tipo**: compara `[rdx]` (o dword de tipo da
estrutura recebida) contra o primeiro dword de cada entrada, em três faixas,
e devolve `entrada + 4` (o offset) quando casa.

## Cadeia completa — RESOLVIDA e VERIFICADA

Medido no processo vivo (pid 32036, bot rodando). O caminho do dispatch é:

```
estrutura de tipo     msftedit RVA 0xe5158
  └─ 1º dword        0x7496e0        (typeinfo — é a CHAVE da tabela)
  └─ busca em        0x284b0         (lookup: compara [rdx] com o 1º dword)
  └─ entrada         0xe5530  (índice 12 na faixa 0xe53b0, stride 0x20)
      └─ handler RVA 0x7bc2f0        (DENTRO do PokeAlliance_dx.exe)
      └─ handler VA  0x7ff79147c2f0
      └─ código      48 89 54 24 10 48 83 ec 18 48 89 54 24 08
```

O handler resolve para código real:

```
0x7bc2f0  mov [rsp+0x10], rdx
0x7bc2f5  sub rsp, 0x18
0x7bc2f9  mov [rsp+8], rdx
0x7bc2fe  xor r10d, r10d
0x7bc301  mov [rsp], r10d
0x7bc305  mov r9, [0x39c8e00]      ; global do exe
0x7bc30c  mov rax, [r9+8]
```

## Cadeia completa — RESOLVIDA, VERIFICADA NO JOGO

Medido no processo vivo (pid 32036, personagem caçando). O caminho inteiro:

```
msftedit+0x1db40        trampolim (entrada)
  rsi = rcx             estrutura de tipo
  edi = [0x224d10]      offset anterior (salvo)
  ecx = [0x224d14]      tipo
  call 0x284b0          lookup(tipo) -> rax
  edx = [rax]           OFFSET do handler
  [0x224d10] = edx      grava durante a chamada
  call 0x284b0          segundo lookup
  r10d = [rax]
  r10 += [0x224cd0]     += base do exe
  call r10              <<< ALVO FINAL (msftedit+0x1dbdd)
  [0x224d10] = edi      RESTAURA
```

### Alvos observados durante caça real

20.000 eventos em 4,94 s (4.051/s). Nove alvos distintos, todos casando com
entradas da tabela em `0xe53b0`:

| alvo (exe+) | chamadas | entrada da tabela |
| :--- | ---: | :--- |
| `0x7bbd80` | 19.976 | `0xe5430` |
| `0x784ba0` | 14 | `0xe53d0` |
| `0x783470` | 3 | `0xe5570` |
| `0x77f250` | 2 | `0xe5590` |
| `0x7bc2f0` | 1 | `0xe5530` |
| `0x30f080` | 1 | `0xe53b0` |
| `0x782d50` | 1 | `0xe5510` |
| `0x406b20` | 1 | `0xe55f0` |
| `0x406d30` | 1 | `0xe5610` |

**Todos os 9 batem.** Não é coincidência: a tabela que eu mapeei por leitura
passiva é a tabela que o jogo usa em execução.

### O alvo dominante

`exe+0x7bbd80` recebe 99,88% das chamadas. É o handler de tick/loop — o
runtime chama ele a cada ciclo. Os outros 8 são ações pontuais.

## O erro que custou duas rodadas

Quebrei na **entrada** (`0x1db40`) e li `[0x224d10]` — que naquele instante
ainda tem o valor **restaurado** (0). Resultado: 20.000 eventos com
`offset=0`, parecendo que nada acontecia.

O ponto certo é **`0x1dbdd`** (`41 ff d2` = `call r10`). Ali o `r10` já contém
o alvo final calculado. Foi o que revelou os 9 alvos.

## Como reancorar em build nova

O trampolim **não** tem assinatura de prólogo única (7 cópias da sequência
`48895c2408...` no módulo). O jeito confiável é achar por referência:

1. procurar `call r10` (`41 ff d2`) cujo bloco próximo tenha
   `cmp byte [rip+X],0` duas vezes seguidas (ready + reentry)
2. ou procurar as strings do dispatcher e achar quem as referencia:
   `[native] Dispatching %s target %u.` / `[native] Resolving %s target %u.`

Na build v3.3.1 (04/11): `0x11cc0` e `0x15280` são chamadores com a mesma
sequência de prólogo. O trampolim é `0x1db40`, chamado de `0x15280`.

## Ferramentas

```
native/pka_dispatch_trace.c   tracer que quebra na ENTRADA (offset sempre 0)
native/pka_dispatch_target.c  tracer que quebra em `call r10` (o util)
tools/tap_dispatch_report.cjs  agrupa eventos por alvo/tipo
tools/tap_trace_test.cjs       12 testes do mecanismo
tools/tap_check_dr.py          confere DR0/DR7 ao vivo
tools/tap_same_build.py        confere se o dump e' da sessao atual
```

```
0x22474f  ready    = 1   (sempre, com o bot ativo)
0x224a32  reentry  = 0
0x224cd0  base     = 0x7ff790cc0000  (= base do exe, exe+0)
0x224d14  tipo     = 6
```

Monitorado por 10 s contínuos: `ready` ficou **1** o tempo todo. O runtime está
armado. **Chamar `0x1db40` é viável.**

## Por que `[0x224d10]` sempre lê 0

```
0x1db84  mov edi, [0x224d10]     ; salva o anterior
0x1dba1  mov [0x224d10], edx     ; grava durante a chamada
0x1dbdd  call r10
0x1dbe8  mov [0x224d10], edi     ; RESTAURA
```

O offset só existe durante a chamada. Ler de fora devolve sempre o valor
restaurado (0). Foi isso que me fez errar antes.

## O bloqueio real restante

A cadeia tem **dois** estágios, não um:

```
0x15384  call 0x1db40     ; ESTÁGIO 1 — resolve a entidade pelo tipo
0x15416  call 0x1db40     ; ESTÁGIO 2 — dispatch de verdade
```

O primeiro `call` foi enganoso. O `0x1db40` é chamado **duas vezes** no fluxo
e não é o ataque — ele é o trampolim que resolve/copia a struct de retorno.

O estágio 1 resolve para o handler `exe+0x7bc2f0`. Desmontando ele:

```
0x7bc2f0  mov [rsp+0x10], rdx
0x7bc2f5  sub rsp, 0x18
0x7bc305  mov r9, [exe+0x39c8500]      ; global
0x7bc30c  mov rax, [r9+8]
0x7bc313  cmp byte [rax+0x19], r10b    ; cor (árvore rubro-negra!)
0x7bc320  cmp [rax+0x20], r8d          ; compara CHAVE
0x7bc326  add rax, 0x10                ; desce à esquerda
0x7bc32c  mov rcx, rax                 ; desce à direita
0x7bc32f  mov rax, [rax]               ; filho
0x7bc338  cmp byte [rcx+0x19], r10b
0x7bc34a  mov [rdx+8], r10
0x7bc355  mov rax, [rcx+0x30]          ; valor do nó
0x7bc362  mov rax, [rcx+0x28]
0x7bc366  mov [rdx], rax               ; escreve o resultado
```

É um **`std::map` lookup** — árvore rubro-negra com byte de cor em `+0x19`,
chave em `+0x20`, valor em `+0x28/+0x30`. Ou seja: isso **busca uma entidade
por id**, não ataca.

## Veredito do item B

O que está provado:

| etapa | status |
| :--- | :--- |
| dump da build correta | feito — `dumps/msftedit_live_32036.bin` |
| dispatcher localizado | feito — `0x15280`, assinatura registrada |
| flags de prontidão | **`ready = 1`** com o bot ativo |
| base em `[0x224cd0]` | **= base do exe**, confirmado |
| tabela | 66 entradas, handlers reais, **estática em runtime** |
| handler do tipo corrente | `exe+0x7bc2f0` = **lookup de entidade por id** |
| estágio 2 do dispatch | não desmontado |

O que falta: o **segundo** `call 0x1db40` (em `0x15416`) usa outro tipo, e é
esse que dispara a ação. A tabela é estática — medido com o bot em combate
(`core.phase=combat`, `movementOwner=target`) por 25 s e nada mudou.

## Por que não deu para fechar

A tabela não muda, então não há como descobrir o índice do "attack" observando
o estado. O caminho é: hookar `0x1db40` e registrar o `ecx`/`edx` de cada call
durante um ataque real. Isso exige inserir código no msftedit, o que é o
próximo passo natural mas não é leitura passiva.

## Ferramentas

```
tools/tap_ready_flags.py         mede ready/reentry/base/tipo ao vivo
tools/tap_watch_combat.py        observa se a tabela muda em combate (não muda)
tools/tap_handler_disasm.py      desmonta um handler e resolve referências
tools/tap_classify_entries.py    lista as 66 entradas com código do handler
tools/tap_table_live.py          lê a tabela do processo vivo
tools/tap_dispatch_measured.py   prova que [0x224d10] é temporário
tools/tap_dump_live.py           dumpa a imagem da build atual
tools/tap_find_dispatch_live.py  localiza o dispatcher por assinatura
tools/tap_dump_vs_live.py        mostra que o dump antigo é outra build
```

