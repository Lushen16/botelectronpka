# Canal nativo — ciclo de teste contra o jogo

Data: 2026-11-09
Status: **funcional**. Validado com o cliente vivo (PID 28500).

O pedido era: "criar uma DLL ou um pipe para validar testes contra o jogo,
como o Shiba faz". **A infra já existia** — `native/pka_native.c` já é
servidor de pipe + scanner + executor. O que estava quebrado era o build.
Esta rodada consertou e fechou o ciclo.

---

## 1. O que o canal faz

```
pka_native.dll (injetada no jogo)
  |
  +-- servidor do named pipe  \\.\pipe\pka-runtime-2-<pid>
  |     handshake HMAC-SHA256 (challenge/authenticate/welcome)
  |     kinds 4 state, 5 telemetry, 10 ack
  |
  +-- scanner (le a memoria do proprio processo)
  |     LocalPlayer por vtable/RTTI -> pos, hp, id, name, type
  |
  +-- executor
        walk/hotkey -> PostMessageW na janela do jogo
        attack/talk/combo -> status 3 (RVA do dispatcher nao recuperado)
```

O cliente (`botfinal`) conecta por `--transport=native`. É o mesmo desenho
do Shiba: a DLL é **servidor**, não cliente.

---

## 2. Os três bugs que quebravam o ciclo

### 2.1 Layout hardcoded do build antigo

`OFF_POS 0x30`, `OFF_NAME 0x80`, `OFF_HP 0xC0`, `OFF_TYPE 0x186` — fixos.
O build `48c41bd4` (2026-11-09) andou **tudo `-0x10`**:

| campo | antes | agora |
| :--- | :--- | :--- |
| pos | `0x30` | `0x20` |
| id | `0x5C` | `0x4C` |
| name | `0x80` | `0x70` |
| hp | `0xC0` | `0xB0` |
| type | `0x186` | `0x176` |
| **direction** | `0xB4` | **`0xB4`** (não andou) |
| **gate** | `0x164` | **`0x164`** (não andou) |

Com o layout errado, o scanner lia `pos=+0x30` = `1`, `name=+0x80` = `\x06`,
`hp=+0xC0` = lixo. `entity_is_player` rejeitava sempre.

**Correção:** `layout_detect()` escolhe o layout em runtime, testando os dois
candidatos contra a entidade real. Critérios de sanidade:

```
coords 1..65535      z <= 15        nome ASCII imprimível
hp <= 100            primeiro qword (vtable) dentro da imagem
```

Log real com o jogo vivo:

```
vtable do player pelo atalho RVA 0x1fb5660
layout DETECTADO: shifted -0x10 (pos=0x20 name=0x70 hp=0xb0 id=0x4c type=0x176) em 0x1f886460fb0
jogador via vtable em 0x1f886460fb0
```

### 2.2 `layout_detect` congelava a falha

Primeira versão marcava `g_layoutResolved = 1` **mesmo quando nenhum layout
passava**. A primeira entidade lida em geral é uma **cópia transiente do nome**
no heap (sem vtable válida), então a detecção falhava na primeira tentativa e
ficava travada no default para sempre.

**Correção:** só marca resolvido quando um layout passa. Falha tenta de novo
na próxima leitura.

### 2.3 `scanner_thread` nunca usava o vtable

O laço chamava `find_player()` (varredura por nome, último recurso) e nunca
`refresh_state()` (que tenta vtable → cadeia → nome). Resultado: o scanner
encontrava cópias transientes como `0x4ea98ff4d0`, não a entidade.

**Correção:** o laço agora chama só `refresh_state()`.

---

## 3. Injeção dupla — como eu quebrei o estado

Para não parar o jogo, `build_native.cjs` grava `pka_native_new.dll` quando o
arquivo original está travado (Windows não sobrescreve DLL mapeada). Eu injetei
os dois sem descarregar o primeiro:

```
pka_native.dll      base=0x7ffd91610000
pka_native_new.dll  base=0x7ffd9b4d0000
```

Duas cópias no mesmo processo: as duas abrem o mesmo pipe, escrevem no mesmo
log e disputam `g_playerVa`. **O estado observado deixa de ser confiável.**

O jogo caiu depois: a DLL descarregada era a **antiga**, sem shutdown limpo no
`DllMain` — `FreeLibrary` tirou o código com as threads ainda rodando.

### Correções

| problema | correção |
| :--- | :--- |
| duas instâncias no mesmo processo | `CreateMutexA("Local\\pka_native_singleton_<pid>")` no `init_once`; a segunda cópia fica inerte |
| `FreeLibrary` derruba o jogo | `shutdown_clean()` em `DLL_PROCESS_DETACH`: sinaliza `g_stop`, `DisconnectNamedPipe` destrava o servidor, espera as threads, só então descarrega |
| build trava com DLL mapeada | `tools/live-test.cjs` descarrega **antes** de buildar |
| injetar duplicado | `live-test.cjs` valida que sobrou exatamente 1 módulo `pka*` |

Novo binário: `native/pka_uninject.exe` (`--module <dll>` ou `--all-pka`).

> **Footgun:** `--unload` numa DLL de versão ANTERIOR a esta derruba o jogo,
> porque a antiga não tem `shutdown_clean`. Reinicie o jogo nesse caso. Daqui
> em diante o descarregamento é seguro.

---

## 4. O ciclo único

```cmd
node tools/live-test.cjs              :: build + injetar + probe
node tools/live-test.cjs --rebuild    :: forca recompilar
node tools/live-test.cjs --command walk --walk 2
node tools/live-test.cjs --unload     :: descarrega tudo
node tools/live-test.cjs --status     :: so mostra o estado
```

O script faz, em ordem:

1. acha o PID do `PokeAlliance_dx.exe`
2. **descarrega qualquer `pka*`** já carregada (senão o build trava)
3. compila (`build_native.cjs --only bot`)
4. escolhe a DLL mais recente (`pka_native.dll` ou `_new`)
5. injeta **uma vez**
6. confirma que existe exatamente 1 módulo `pka*`
7. roda o probe e, opcionalmente, um comando

---

## 5. Resultado medido (antes de eu derrubar o jogo)

```
[probe] autenticado     : true
[probe] state           : online=true hp=100 targets=0
[probe] telemetria      : tick=3 jogador="Usobot"
```

E a entidade lida direto do VA que a DLL escolheu:

```
VA = 0x1f886460fb0
  vtable  = 0x7ff78bed5660        (RVA 0x1fb5660 — o atalho do build novo)
  pos     = (3291, 2034, 7)       (antes era 3290, 2035 — o personagem andou)
  name    = "Usobot"
  hp      = 100
  id      = 268441953
  type    = 0                     (LocalPlayer)
```

**Não provado nesta rodada:** posição no telemetry saiu `{0,0,0}` no probe que
rodei *depois* que a segunda DLL entrou. Com uma instância só, `build_telemetry`
lê `g_playerVa` — que estava correto. Falta reconfirmar com o jogo reaberto.

---

## 6. O que não está implementado

| recurso | status |
| :--- | :--- |
| `walk` / `hotkey` | `PostMessageW` na janela. `status 0` = tecla entregue, **não** efeito |
| `attack` / `talk` / `combo` | `status 3` — RVA do dispatcher nativo não recuperado |
| criaturas | **implementado** — ver §6.1 |
| posição autoritativa | lê `g_playerVa`; confirmado ao vivo |

`status 0` significa **tecla entregue**, não que o jogo reagiu. `effectVerified`
continua `false`.

---

## 6.1 Criaturas — a vtable certa é `Monster`, não `Creature`

Medido em 2026-11-09 (PID 14296, build `48c41bd4`), RTTI resolvido no módulo:

| classe | vtable RVA | instâncias | resultado |
| :--- | :--- | :--- | :--- |
| `Creature` | `0x1fad788` | 285 | **todas lixo** (`pos=65535`, nome vazio) |
| **`Monster`** | **`0x1fb41b8`** | **7** | **todas reais** |
| `?$_Ref_count_obj2@VMonster@@@std` | `0x1fb2d98` | 3 | control blocks (não são entidades) |
| `?$_Ref_count_obj2@VCreature@@@std` | `0x1fb5050` | 286 | control blocks |
| `Item` | `0x1fb0bd0` | 4893 | objetos de chão |
| `Tile` | `0x1facfc8` | — | tiles |

**Por que `Creature` falha:** é a base da hierarquia. Os objetos derivados têm
vtable própria, então procurar pelo qword da vtable da base nunca casa — e o
que casou foi struct de outro tipo, com lixo nos offsets.

Leitura real que confirmou `Monster`:

```
Monster vtable=0x7ff78bed41b8  instancias=7
  0x1e49c78fe30  pos=(3297, 2027, 7)  hp=100  type=4  id=0x40700d6a  name='Charmeleon'
  0x1e49caeb980  pos=(3300, 2025, 7)  hp=100  type=4  id=0x406305aa  name='Marowak'
  0x1e4c376b1a0  pos=(65535,65535,255) hp=100 type=4  id=0x407059ee  name='Alakazam'
  ... (Fearow ×3, Leafeon)
```

`pos=(65535, 65535, 255)` = criatura existe na memória mas está **fora de
vista**. O filtro rejeita (`x/y > 65534`, `z > 15`).

**Layout:** idêntico ao `LocalPlayer` (subobjeto base) —
`+0x20 x,y`, `+0x28 z`, `+0x4C id`, `+0x70 name`, `+0xB0 hp`, `+0x176 type`.

**Validação do gerador em C** (harness isolado, sem o jogo):

```
geradas=64 bytes=6834
[{"id":1081085290,"name":"Charmeleon","type":4,"healthPercent":100,
  "canAttack":true,"pos":{"x":3297,"y":2027,"z":7}}, ...]
```

Decodificado pelo `decodeTelemetry` real:

```
DECODER OK  creatures=64
nome hostil preservado: "Pika\"chu\\x"
```

O escape JSON (`json_escape`) trata aspas, barra e caracteres de controle —
nome de criatura vem do servidor, não é confiável.

**Lacuna declarada:** `canAttack` sai `type == 4` porque **type 4 foi o único
valor observado** em selvagens. Não medi type de Pokémon próprio/pet na mesma
tabela. Se aparecer outro, corrigir `CREATURE_TYPE_WILD`.

---

## 6.2 Bugs de ciclo de vida encontrados nesta rodada

| bug | sintoma | correção |
| :--- | :--- | :--- |
| mutex do singleton nunca liberado | reinjetar após unload deixava a DLL **inerte** (`ERROR_ALREADY_EXISTS` permanente) | trocado por **sonda de pipe**: tenta conectar; se conectar, já há servidor vivo |
| `shutdown_clean` duplicado por edits | bloco `if (g_onceMutex)` repetido 6× | função reescrita inteira |
| guarda de instância usava nome do módulo errado | segunda cópia podia iniciar | sonda usa `pka-runtime-2-<pid>`, o mesmo nome do pipe real |
| **`DllMain` fazia trabalho pesado** | `LoadLibraryA` remoto voltava **`0xC0000005`** e derrubava o jogo | `DllMain` só cria `boot_thread`; `init_once` roda sem loader lock |
| `resolve_attack_handler` com `size_t` decrescente | underflow em `j==0`, laço infinito e leitura fora do buffer | índice **assinado** (`long`) com limite inferior explícito |
| `scan_creatures` zerava o global no início | telemetry piscava entre 5 e 0 criaturas | buffer local; publica só no fim; varredura vazia **não apaga** a lista anterior |

Por que sonda de pipe e não mutex: handle de mutex nomeado pertence ao
**processo**, não ao módulo. Um unload que não libera o handle deixa o nome
ocupado para sempre. O pipe nomeado desaparece quando o servidor morre.

Sobre o `0xC0000005`: `DllMain` roda com o loader lock tomado. `EnumWindows`,
`CreateFileA`, `malloc`, `VirtualQueryEx` e `CreateThread` sob esse lock
travam ou crasham — o exit code da thread remota materializa isso. Regra: em
`DLL_PROCESS_ATTACH` só se cria a thread de boot e se retorna.

---

## 6.3 Handler de attack — RVA muda, padrão sobrevive

O doc `research/shiba_tap/DISPATCH_LIVE.md` mediu em 2026-11-04:

```
handler attack = exe+0x783000
handler follow = exe+0x7831d0
dispatcher     = msftedit.dll+0x15280  (ecx=targetId, dl=0 attack/1 follow)
```

Neste build (2026-11-09, PID 13952) **os RVAs mudaram**. Varredura por padrão
de bytes no módulo em memória localizou:

```
discriminante  41 0f b6 f0 48 8b fa      movzx esi,r8b ; mov rdi,rdx
handler        exe+0x784ba0              (+0x1BA0 vs o doc)
dispatcher     msftedit+0x15280          (confirmado no dump, bytes idênticos)
```

Prólogo confirmado no handler novo:

```asm
0x784ba0  48 89 5c 24 18     mov [rsp+0x18], rbx
0x784ba5  48 89 74 24 20     mov [rsp+0x20], rsi
0x784baa  57                push rdi
0x784bab  48 83 ec 50        sub rsp, 0x50
0x784baf  48 8b 05 .. .. ..  mov rax, [rip+..]     ; __security_cookie
0x784bb6  48 33 c4           xor rax, rsp
0x784bb9  41 0f b6 f0        movzx esi, r8b
0x784bbd  48 8b fa           mov rdi, rdx
0x784bc0  80 b9 68 26 00 00 00  cmp byte [rcx+0x2668], 0
```

**`cmp byte [rcx+0x2668]`** é o gate de prontidão — o doc dizia `[rcx+0x2648]`.
Também mudou.

### Por que `attack` continua `status 4`

`msftedit.dll` **não está carregado** neste cliente (medido: 79 módulos, só
`libEGL/libGLESv2/d3dcompiler` além do exe). Sem ele não existe
`msftedit+0x15280`, e sem o dispatcher não há lookup `id -> entidade`.

Chamar o handler direto com o **id** está errado — ele espera o **ponteiro da
entidade** em `rdx` (o lookup anterior resolve). E o handler tem stack cookie
próprio, então chamada externa precisa respeitar a ABI inteira.

O comando `attack` agora faz o certo: resolve o handler por padrão, valida que
o alvo existe na lista observada, e reporta dry-run com RVA + alvo + HP + pos.
Chamada real fica atrás de `PKA_ATTACK_FIRE=1` e **ainda não é possível**
porque o dispatcher não está no processo.

---

## 6.4 Tabela de verdade dos campos medidos

| campo | offset | confirmação |
| :--- | :--- | :--- |
| x, y | `+0x20` | struct duplicada em `Tile+0x68`; delta-scan 877/972 com a seta |
| z | `+0x28` | mesmo, valores 1..9 |
| id | `+0x4C` | `0x10001f3e` no player, `0x40700d6a` em criatura |
| name | `+0x70` | `"Usobot"`, `"Charmeleon"`, `"Dugtrio"` |
| **hp** | **`+0xB0`** | cai de 100 para 99 num aliado ferido; handler checa `cmp byte [rax+0xB0],0` |
| type | `+0x176` | 0=player, 1=selvagem, 3=aliado, 4=fora de vista |
| direction | `+0xB4` | não andou com o build |

### `type` — a tabela real (medida, não inferida)

| type | leitura | evidência |
| :--- | :--- | :--- |
| 0 | player | `LocalPlayer` + 23 outros jogadores (`Mr Rocket`, `Leozinhogs`, `Undead`) |
| **1** | **selvagem atacável** | Bellsprout/Weepinbell/Magnemite, posição válida |
| **3** | **ALIADO do jogador** | **Dugtrio a 2 tiles acompanhando** — Aoid confirmou: é o que ele carrega |
| **4** | **fora de vista** | Marowak/Lunatone/Gengar sempre em `(65535,65535,255)` |

`canAttack = (type == 1 && hp > 0)`. `isOwnPokemon = (type == 3)`.

**Correção de interpretação:** o Dugtrio com `hp=99` que eu usei para "provar"
que `+0xB0` é HP era um **aliado ferido**, não um selvagem. O offset continua
certo (o byte cai), mas a leitura estava errada — aliado não é alvo. Hoje o
scanner separa `type==3` para `g_ownSummon` e publica `ownSummonId` +
`pokemonName` no telemetry, sem contaminar a lista de alvos.

---

## 6.5 Ciclo de vida — o que causou os dois crashes

### Crash 1 — `DllMain` fazia trabalho pesado

`DLL_PROCESS_ATTACH` chama `PkaStart` → `init_once` **sincronamente**. Sob
loader lock, `init_once` faz `EnumWindows`, `CreateFileA`, `malloc`,
`VirtualQueryEx`, `CreateThread`. `LoadLibraryA` remoto voltava `0xC0000005`.

**Correção:** `DllMain` só cria `boot_thread` e retorna.

### Crash 2 — `DETACH` esperava thread viva

`shutdown_clean` esperava 5 s por thread; se estourasse, `FreeLibrary`
liberava o código com thread rodando → `0xC0000005`.

Duas causas de thread presa:
- `scanner_thread` dormia `SCAN_INTERVAL_MS` (8 s) sem checar parada
- `ConnectNamedPipe(pipe, NULL)` bloqueia indefinidamente

**Correção:**
- `g_stopEvent` (evento manual) acorda as duas na hora
- `scanner_thread` usa `sleep_or_stop()` e checa dentro de `scan_creatures`
- `ConnectNamedPipe` roda em modo `PIPE_NOWAIT` com polling de 100 ms
- `DETACH` **só sinaliza e retorna** — não loga, não espera, não faz I/O

Resultado medido: jogo sobrevive ao unload. O módulo pode ficar residente (um
mapeamento vazado) se a thread atrasar — preferível a crashar.

### Crash 3 — RTTI de `Monster` falhava e `LocalPlayer` funcionava

`resolve_vtable_by_rtti` varria em chunks de 1 MB sem overlap. O nome
`.?AVMonster@@` caía na **fronteira** entre dois chunks e era cortado ao meio;
`.?AVLocalPlayer@@` caía inteiro por sorte de alinhamento. O mesmo algoritmo em
Python (lê a imagem toda de uma vez) sempre achava — foi o que denunciou o bug.

**Correção:** `OVERLAP = 64` bytes entre chunks nos três laços da RTTI, e
`i + nameLen <= CHUNK` (era `<`).

---

## 6.6 Estado verificado ao vivo (PID 7368)

```
[probe] autenticado : true
[probe] state       : online=true hp=100
[probe] telemetria  : pos={"x":3316,"y":2073,"z":7}
[probe] criaturas   : 6
```

Log da DLL:

```
resolve Monster: rtti devolveu vtable (base=0x7ff789f20000)
vtable do Monster por RTTI: rva 0x1fb41b8
scan_creatures: 8 selvagens, aliado=Dugtrio
```

---

## 7. Attack — a cadeia foi aberta, e o desenho mudou

O doc `research/shiba_tap/DISPATCH_LIVE.md` dizia que o caminho era
`msftedit.dll+0x15280(ecx=targetId, dl=mode)`. **Isso não existe neste
cliente.**

Varredura da memória inteira pela assinatura do dispatcher
(`48 89 5c 24 08 48 89 6c 24 10 56 57 41 56 48 83 ec 60 0f b6 ea 8b f9`):
**zero hits**. E `msftedit.dll` não está entre os 80 módulos carregados.
Fim da linha por ali.

### O caminho que existe

O handler de attack está no próprio exe. RVA mudou (o doc tinha `0x783000`),
mas o padrão de bytes sobreviveu:

```
prologo     48 89 5c 24 18 48 89 74 24 20 57 48 83 ec 50
cookie      48 8b 05 xx xx xx xx 48 33 c4
discrimin.  41 0f b6 f0 48 8b fa          movzx esi,r8b ; mov rdi,rdx

handler = exe+0x784be0   (no doc: +0x783000)
```

### O disasm revelou que a ABI é diferente do que parecia

Primeira leitura (errada): `rdx` seria o ponteiro da entidade.
**Não é.** Os três chamadores reais montam um `shared_ptr<Entity>` na pilha:

```asm
; chamador em exe+0x519ffd, imediatamente antes do call
+51a00b  48 85 db              test rbx, rbx
+51a00e  74 04                 je   +4
+51a010  f0 ff 43 08           lock inc dword [rbx+8]      ; refcount++
+51a014  0f 28 45 b7           movaps xmm0, [rbp-0x49]
+51a018  66 0f 7f 44 24 30     movdqa [rsp+0x30], xmm0     ; {obj, ctrl}
+51a01d  45 33 c0              xor  r8d, r8d               ; arg3 = 0
+51a020  48 8d 54 24 30        lea  rdx, [rsp+0x30]        ; &shared_ptr
+51a025  48 8d 0d .. .. .. ..  lea  rcx, [rip+...]         ; runtime
+51a02c  e8 .. .. .. ..        call handler
```

E o handler consome exatamente assim:

```asm
+0x22  48 8b fa               mov rdi, rdx          ; rdi = &shared_ptr
+0x80  48 8b 07               mov rax, [rdi]        ; rax = sp.obj
+0xc8  48 8b 4f 08            mov rcx, [rdi+8]      ; rcx = sp.ctrl
+0xd0  48 c7 47 08 00 00 00 00  mov qword [rdi+8], 0  ; move ownership
```

**Passar a entidade crua em `rdx` faz o handler tratar o endereço como `obj`
e o conteúdo como control block.** Foi o erro da primeira tentativa.

### O guard que anula a chamada

```asm
+0x3a  48 8b 91 28 25 00 00   mov rdx, [rcx+0x2528]   ; alvo atual do runtime
+0x4a  80 ba b0 00 00 00 00   cmp byte [rdx+0xb0], 0  ; HP do alvo
+0x64  48 8b 89 68 25 00 00   mov rcx, [rcx+0x2568]   ; self
+0x74  e8 a7 c9 10 00         call 0x10c9a0           ; valida self
+0x79  84 c0                  test al, al
+0x7b  0f 84 21 01 00 00      je   saida
+0x80  48 8b 07               mov rax, [rdi]          ; sp.obj
+0x83  48 3b c2               cmp rax, rdx            ; <<< sp.obj == alvo?
+0x86  0f 84 15 01 00 00      je   saida              ; se igual, NÃO ataca
+0x95  48 3b 83 48 25 00 00   cmp rax, [rbx+0x2548]
```

`cmp sp.obj, [runtime+0x2528]` / `je saida` — o handler **recusa** quando o
objeto passado é o mesmo que já está no slot de alvo. É um guard de
"não atacar o próprio alvo".

**Consequência:** escrever a criatura em `[runtime+0x2528]` **e** passá-la como
argumento faz o handler sair imediatamente — exatamente o que aconteceu na
tentativa anterior (chamada executada, sem efeito).

### A chamada correta

```
sp.obj        = criatura a atacar
sp.ctrl       = control block válido (refcount ++ / --)
[runtime+0x2528] = INALTERADO (o alvo que já estava)
handler(runtime, &sp, 0)
```

Como `sp.obj != [runtime+0x2528]`, o guard passa.

O control block emprestado vem do `shared_ptr<Tile>` do LocalPlayer
(`+0x9b0`) — o único control block vivo conhecido. Refcount incrementado
antes e decrementado depois, igual ao chamador real (`lock inc dword [ctrl+8]`).

---

```asm
+0x1e  41 0f b6 f0              movzx esi, r8b          ; mode
+0x22  48 8b fa                 mov rdi, rdx            ; guarda arg2
+0x25  48 8b d9                 mov rbx, rcx            ; runtime
+0x2d  80 b9 68 26 00 00 00     cmp byte [rcx+0x2668],0 ; gate
+0x3a  48 8b 91 28 25 00 00     mov rdx,[rcx+0x2528]    ; ← ALVO
+0x4a  80 ba b0 00 00 00 00     cmp byte [rdx+0xb0],0   ; HP do alvo
+0x57  80 b9 6a 26 00 00 00     cmp byte [rcx+0x266a],0 ; reentry
+0x64  48 8b 89 68 25 00 00     mov rcx,[rcx+0x2568]    ; self
```

**O handler não escolhe alvo pelo argumento — mas USA o argumento como
`shared_ptr`, não como entidade.** Ver a seção de ABI abaixo: `rdx` é
`&shared_ptr<Entity>`. A primeira tentativa passou a entidade crua ali e o
efeito foi nulo porque o handler leu o endereço como `obj`.

### O epílogo do handler — três achados que mudam tudo

Decodificado ao vivo (PID 21804, bytes de `exe+0x784be0..+0x1d0`):

```asm
+0x163  ff 83 a8 26 00 00     inc  dword [rbx+0x26a8]   ; contador++
+0x169  40 84 f6              test sil,sil              ; sil = mode
+0x16c  75 34                 jne  +0x1a2               ; mode!=0 -> pula acao
+0x16e  48 8b b3 68 25 00 00  mov  rsi,[rbx+0x2568]    ; self
+0x175  8b 9b a8 26 00 00     mov  ebx,[rbx+0x26a8]    ; contador
+0x17b  48 8b 0f              mov  rcx,[rdi]           ; sp.obj
+0x17e  48 85 c9              test rcx,rcx
+0x181  74 0f                 je   +0x192
+0x183  48 8b 01              mov  rax,[rcx]           ; vtable
+0x186  48 8b 40 18           mov  rax,[rax+0x18]      ; vtable[3]
+0x18a  ff 15 b0 9a 2b 01     call qword [rip+..]      ; GetId()
+0x194  44 8b c3              mov  r8d,ebx             ; arg3 = contador
+0x197  8b d0                 mov  edx,eax             ; arg2 = ID (u32!)
+0x199  48 8b ce              mov  rcx,rsi             ; arg1 = self
+0x19c  e8 df d7 08 00        call +0x8d7df            ; ACAO REAL
+0x1a2  48 8b 4f 08           mov  rcx,[rdi+8]         ; sp.ctrl
+0x1a6  48 85 c9              test rcx,rcx
+0x1a9  74 05                 je   +0x1b0
+0x1ab  e8 00 a8 b8 ff        call <destrutor>         ; DESTROI o shared_ptr
+0x1d0  c3                    ret                      ; eax = retorno da acao
```

**Ação real = `exe+0x812560`** (`+0x19c + 5 + 0x8d7df`).

| # | achado | consequência |
| :-- | :--- | :--- |
| 1 | a ação recebe **`id` (u32)**, não o ponteiro | o `shared_ptr` só serve para chamar `vtable[3]` = `GetId()`. A entidade é reduzida a um número antes de agir. |
| 2 | o handler **destrói o `shared_ptr`** em `+0x1ab` | ele **toma ownership** da cópia recebida |
| 3 | o retorno vem da ação, **não é booleano** | observados `6`, `5`, `16` em três chamadas |

### Por que o jogo morreu às 22:59

O código fazia:

```
++refcount (2→3)  →  handler -- (3→2)  →  --refcount meu (2→1)
                     = NET −1 por chamada
```

Três chamadas zeraram o refcount do control block do **Tile do LocalPlayer**
(emprestado de `+0x9b0`). O Tile foi liberado, e o cliente morreu ~9 minutos
depois — **sem log**, porque a corrupção é silenciosa.

**Correção:** `++` antes e **não** decrementar depois. O `++` apenas paga o
`--` que o handler fará. Total por chamada: 0.

Além disso: sem control block válido, aborta antes de chamar — o handler
desreferencia `[rdi+8]` e chamaria o destrutor em NULL.

### O que isso significa para o `sp.ctrl` (pendente)

O control block ainda é **emprestado do Tile do LocalPlayer**, não da
criatura. Depois da correção o balanço é zero, então não corrompe mais — mas
continua conceitualmente errado: `sp.obj` (criatura) e `sp.ctrl` (Tile) não
pertencem ao mesmo objeto.

Como a ação real recebe só o **id**, na prática o `ctrl` nunca é usado para
acessar a criatura — só para o destrutor. Por isso funciona. Mas é frágil:

- se o destrutor do control block do Tile tiver efeito colateral, ele roda
- se o Tile for trocado entre a leitura e a chamada, o `ctrl` fica pendurado

**Correção correta (não feita):** usar o control block real da criatura —
`?$_Ref_count_obj2@VMonster@@@std`, que tem 3 instâncias vivas.

---

```
runtime = exe + 0x39c9430     (objeto em .data, NÃO é ponteiro)

[runtime+0x2528] = LocalPlayer   validado: name="Usobot", pos correta
[runtime+0x2568] = pokemon ativo
[runtime+0x2668] = gate de prontidão  (1 = pronto)
[runtime+0x266a] = flag de reentrada  (deve ser 0)
```

Isso foi confirmado ao vivo: `[runtime+0x2528]` apontava exatamente para o
`LocalPlayer` da varredura.

### Caminho implementado (não validado com efeito)

```
1. resolve o handler por pattern
2. valida gate=1 e reentry=0
3. escreve o ponteiro da criatura em [runtime+0x2528]
4. chama handler(runtime, ponteiro, 0)
5. restaura [runtime+0x2528] ao valor anterior (sempre)
```

O passo 3 usa `write_mem`, que exige `PAGE_READWRITE`; se a página for
read-only ele aborta sem chamar nada.

**Não validado:** a chamada rodou (o log mostrou `attack FIRE`), o runtime
voltou ao normal (`gate=1`, `reentry=0`), o jogo **não caiu** — mas o ACK
expirou e o retorno não foi logado. Falta confirmar se o Bellsprout perdeu HP.

### Ferramenta

```cmd
node tools/attack-once.cjs --pid <pid> --first          :: dry-run, loga tudo
node tools/attack-once.cjs --pid <pid> --first --fire   :: chama de verdade
```

O disparo é controlado por **arquivo**, não env var:

```
native/pka_attack_fire.txt   conteudo "1" = dispara, qualquer outro = dry-run
```

Processo já em execução **não herda variável de ambiente nova** — foi por isso
que `set PKA_ATTACK_FIRE=1` no shell não teve efeito nenhum no jogo. Mesmo
padrão de `pka_player_name.txt` e `pka_channel_key.txt`.

---

## 7.1 Attack — FUNCIONA (2026-11-10)

```
alvo: id=1079654291 Bellsprout hp=100 pos=(3318,2074,7)
--- tentativa 1: hp=100
  ACK: {"type":2,"status":0,"message":"Comando enviado."}
  resultado: hp 100 -> 100
--- tentativa 2: hp=100
  ACK: {"type":2,"status":0,"message":"Comando enviado."}
  resultado: hp 100 -> 53        <<< O HP CAIU
```

**O ataque nativo funciona.** HP caiu de 100 para 53. O jogo sobreviveu.

### O que estava faltando: o control block certo

O handler recebe `&shared_ptr<Monster>` e **destrói** a cópia. O `ctrl` tem
que ser o control block da própria criatura.

Antes eu emprestava o do `shared_ptr<Tile>` do LocalPlayer (`+0x9b0`):
- pode estar **NULL** (ficou NULL com o personagem parado — PID 9452)
- é de outro tipo; o destrutor rodava sobre objeto alheio

**Descoberta:** `make_shared` coloca o control block **imediatamente antes**
do objeto, a `-0x10`. Validado em **20 de 20**:

```
criatura 0x2a593adbc30  ->  cb 0x2a593adbc20   vt_ok=True  back_ok=True
criatura 0x2a593adc7c0  ->  cb 0x2a593adc7b0   vt_ok=True  back_ok=True
... 20 de 20 com o mesmo delta -0x10
```

Validação em duas condições (não é chute de delta):
- vtable do cb == `?$_Ref_count_obj2@VMonster@@@std` (RVA `0x1fb2d98`)
- `cb+0x18` aponta de volta para a criatura

Custo: 2 leituras por criatura por scan. Sem varredura de memória.

### Balanço do refcount — verificado

| alvo dos 2 ataques | antes | depois |
| :--- | ---: | ---: |
| `0x2a593adbc30` | 8 | **8** |

Delta zero no alvo. O `++` do chamador paga o `--` que o handler faz.

**Controle sem atacar (20 s, 21 criaturas):** o próprio jogo muda refcounts
sozinho (`+2`, `−2`, `−6`) quando as criaturas se movem ou morrem. Então
variações em criaturas que você não atacou **não são vazamento meu**.

### Tabela final

| item | estado | evidência |
| :--- | :--- | :--- |
| handler localizado | **sim** | `exe+0x784be0`, por pattern |
| runtime localizado | **sim** | `exe+0x39c9430`, objeto estático |
| control block por criatura | **sim** | `criatura − 0x10`, 20/20 validados |
| ABI do 2º argumento | **confirmado** | `&shared_ptr{obj,ctrl}` |
| guard `sp.obj == [+0x2528]` | **confirmado** | `+0x83 cmp` / `+0x86 je` |
| refcount | **estável no alvo** | `8 → 8` |
| **HP cai** | **SIM** | `100 → 53` |
| retorno | código, não bool | `5`, `176` observados |

### Pendências que continuam

- **thread**: o handler roda na thread do pipe, não na do jogo. Não há lock
  protegendo `[runtime+0x2528]` nem `[runtime+0x26a8]`. Funcionou 2 vezes →
  não prova segurança, só ausência de crash imediato.
- **`status 0` ≠ acertou**: significa "a ação retornou não-zero". O efeito se
  mede pelo HP, e agora dá para medir.
- **retorno da ação**: valores como `5` e `176` não estão mapeados.

---

```
native/pka_native.c        layout runtime + singleton + shutdown limpo
                           + resolve_vtable_by_rtti v5 (varredura por regiao)
                           + attack com ABI de shared_ptr correta
native/pka_uninject.c      descarrega DLL do processo (precisa --force)
native/pka_inject.c        inalterado
tools/live-test.cjs        build/inject/probe — NAO descarrega mais
tools/game-loop.cjs        fecha, reabre, espera o mundo, injeta, testa
tools/attack-once.cjs      um attack com ACK, dry-run ou --fire
tools/attack-hunt.cjs      espera criatura, ataca, mede HP antes/depois
tools/attack-verify.cjs    mede efeito de um ataque especifico
tools/refcount_watch.py    le o refcount do control block do Tile
tools/refcount-watch.cjs   wrapper node do anterior
tools/build_native.cjs     + pka_uninject.exe no build
captures/channel-key-<pid>.json   chave no formato que o botfinal le
```

---

## 8. Como retomar

```cmd
node tools/game-loop.cjs --test probe
```

Fecha o jogo, reabre, espera o personagem entrar no mundo, compila e injeta.
Para no login se o cliente cair na tela de entrada.

Depois, o teste que decide:

```cmd
python tools/refcount_watch.py --pid <pid>      :: baseline (era 3)
node tools/attack-hunt.cjs --pid <pid> --fire
python tools/refcount_watch.py --pid <pid>      :: tem que ser o MESMO numero
```

Se o refcount cair → **não atacar mais**, o vazamento continua.
Se ficar igual → medir HP; é o último elo.
