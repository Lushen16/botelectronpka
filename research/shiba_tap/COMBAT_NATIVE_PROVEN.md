# Combate nativo — o que o dump prova (2026-11-03)

Fonte: `dumps/payload_reconstructed.dll` (msftedit.dll stomped, 3.293.184 bytes,
SHA-256 conferido em `native-payload-audit.json`). Tudo abaixo é **estático**:
nenhuma execução, nenhum processo, nenhum pipe, nenhuma credencial.

Ferramentas: `tools/pka_re_map.py`, `tools/pka_combat_disasm.py`,\n`tools/pka_cmd_vocab.py` (todos na raiz de `tools/`, mas de uso exclusivo deste modulo). Sem Ghidra — o `.pdata` do PE dá os limites exatos das
7074 funções, e o capstone resolve as referências RIP-relative para string e
double inline.

## O achado que importa

`attack` **não é tecla**. É chamada nativa.

```
[native] Client profile %s verified (%zu functions); Game RVA %llX, dispatcher RVA %llX.
[native] Resolving %s target %u.
[native] Dispatching %s target %u.
```

Essas três strings existem no payload (RVA `0xe4340`, `0xe45f0`, `0xe4618`) e são
usadas pela função `0x12884..0x137c8`. O despacho vai para
`0x19b20` com `rcx` alternando entre dois ponteiros resolvidos por
`cmovne` — `attack` ou `follow`, e o alvo vem de
`mov r14, [rip+0x210a95]` (ponteiro de módulo) `+ ((mode + 0x253) << 4)`.

Ou seja: **o fornecedor chama função dentro do jogo**. O `send` por pipe
(`0x84340`) é só o canal de comando; o combate em si é chamada direta com RVA
resolvido em runtime.

Isso explica três coisas de uma vez:

1. por que `attack` sempre devolveu `status 3` no nosso pipe — não existe
   tecla que faça "attack no id 12345";
2. por que o reg guard de identidade existe (`attackTargetId` no `talk`):
   a chamada leva o **id da criatura**, não uma tecla;
3. por que o bot deles precisa da DLL: sem código dentro do processo não há
   chamada nativa.

## O caminho de envio (provado)

`send` em **RVA 0x84340**. Assinatura observada:

```
rcx = instância do runtime
rdx = json do comando      (nlohmann::json, montado por 0x5a80)
r8  = json convertido      (retorno de 0x2cbe0 / 0x3a740)
r9  = [rbp+8]  (contexto)
[rsp+0x40] = 0x12c  (300)  -> timeout/espera em 50 dos 61 call-sites
[rsp+0x38] = 0
[rsp+0x30] = 0
[rsp+0x28] = 0
[rsp+0x20] = &[rbp+0xc8]   (struct de retorno)
```

**61 call-sites** de `send`, todos com o mesmo prólogo.

## Vocabulário real de comandos

Extraído dos literais em `0xe4434..0xea588`. Todos batem com o nosso
`protocol.cjs` **exceto quatro**:

| comando | nosso `protocol.cjs` | payload |
| :--- | :--- | :--- |
| `attack` | 2 | presente, com `creature.id` |
| `talk` | 6 | presente |
| `combo` | 7 | presente |
| `walk` | 1 | presente, campos `step` + `direction` |
| `turn` | 17 | presente |
| `fight` | 11 | presente |
| `chase` | 19 | presente |
| `order` / `orderGround` | 16 / 21 | presente |
| `switchPokemon` | 8 | presente |
| `refreshCombo` | 18 | presente |
| `useWith` | 14 | presente |
| `hotkey` | 20 | presente |
| `revive` | 13 | presente |
| `potion` | — | **o deles tem `potion` como comando** |
| `action` | 9 | presente |
| `stop` | 4 | presente |
| `guildDaily` | 25 | presente |
| **`talkPrivate`** | **AUSENTE** | RVA `0xe7928`, usado em `site 0xb7e90` |

`talkPrivate` é canal de chat privado, não combate. Fica documentado como
lacuna conhecida; não inventamos opcode.

## Divergências estruturais confirmadas

### 1. `attack` leva o id, não uma tecla

`site 0xa963b` (dentro de `tickHoenn`, função `0x9e7a4..0xa1f9f`):

```
lea rdx, [rip+..]   ; 'creature'
lea rcx, [rbp+0x128]
call 0x2cc40
...
lea rdx, [rip+..]   ; 'id'
call 0x63260
...
mov r8d, 6          ; tamanho 6 da string 'attack'
lea rdx, 'attack'
call 0x5a80         ; monta json {"attack": <id>}
mov [rsp+0x40], 0x12c
call 0x84340        ; send
```

Nosso `pka_native.c` responde `status 3` para `type == 2` porque procura uma
tecla. **Não existe tecla.** Precisa do dispatcher nativo em `0x12c40`.

### 2. `walk` tem dois campos

`site 0xacf46`:

```
lea rdx, 'direction'   ; campo lido antes
...
mov ecx, 'walk'
mov [rsp+0x40], 0x12c
call 0x84340
```

Nosso `protocol.cjs` manda `walk` como parâmetro numérico simples (offset 8).
O deles monta json com `step` e `direction`. Funciona igual em direção 0..7,
mas o formato é diferente — e isso explica por que nosso `walk` retorna 0 no
alvo de teste e 3 no jogo: a janela recebe tecla, mas o clique/seta do jogo
não é o mesmo caminho.

### 3. `hotkey` usa ação explícita

Nosso encoder emite `uuidHash` em 12 e `expectedAction` em 16. O payload
confirma (`site 0x68dbb`, `0x9ab48`) — a estrutura de 24 bytes fixos + texto
em 24 está correta. **Esse foi o bug que o DeepSeek achou e eu confirmei.**

## O dispatcher nativo (0x12c40)

```
0x12c40  mov  [rsp+8], rbx
0x12c57  call 0x19c30              ; valida se o jogo está pronto
0x12c5e  je   0x12d50              ; não pronto -> retorna 0
0x12c64  mov  r14, [rip+0x210a95]  ; ponteiro de módulo (base do vtable)
0x12c6b  lea  rcx, [rbp+0x253]
0x12c72  shl  rcx, 4               ; índice de 16 bytes
0x12c78  add  rcx, r14
0x12c7b  call 0x4dc0               ; resolve
0x12c8c  test bpl, bpl
0x12c8f  lea  rax, 'follow'
0x12c96  lea  rsi, 'attack'
0x12ca0  cmovne rsi, rax           ; mode != 0 -> follow
0x12ca4  lea  rcx, '[native] Resolving %s target %u.\n'
0x12cae  call 0xfcf0               ; log
0x12d73  ...
0x12d81  lea  rcx, '[native] Dispatching %s target %u.\n'
0x12dc4  call 0x19b20              ; <<< a chamada de verdade
```

Chamadores: `0xf2d4` (4 sites), `0x109b8`, `0x11038`. O primeiro é o
`comboTick`/`leadTarget` (confere com os nomes RTTI
`?AV<lambda_1>@?1???R0?1??comboTick@Runtime@bot@pka@@...`).

## O que ainda não está provado

- **Não executei** o dispatcher. Sei que ele existe, onde está, e que recebe
  `(ecx = targetId, dl = mode/0=attack 1=follow)`, mas **não sei** o que ele
  faz internamente em `0x19b20`.
- O ponteiro em `[rip+0x210a95]` (`0x2264c0`-ish) é preenchido em runtime —
  precisa de dump vivo para resolver o valor.
- `talkPrivate` sem opcode nosso.
- Nenhum `effectVerified`.

## Regras de decisão (já estavam certas)

Confirmadas por âncora byte-exata, sem mudança:

| regra | predicado | âncora |
| :--- | :--- | :--- |
| medicine gate | `elapsed >= 1000.0` | `0x57fe8` `comisd` |
| deploy gate | `now - deployStableSince > max(pokeReadyTimeoutMs, 1000)` | `0x9d2c3` `comisd` |
| best tile | timeout 2500, retry 700, range 4 | `0x936ae`, `0x930e2`, `0x93a24` |
| next team | `index % slotCount`, 6 slots | `0x9b6c9` `idiv` |

Essas o DeepSeek acertou antes de mim e o dump confirma.

## Como reproduzir

```cmd
python tools\pka_re_map.py combat
python tools\pka_combat_disasm.py --grep attack
python tools\pka_combat_disasm.py 0x12c40
python tools\pka_cmd_vocab.py
python tools\pka_cmd_coverage.py
```

Tudo estático. Nenhum deles abre processo, pipe ou credencial.

