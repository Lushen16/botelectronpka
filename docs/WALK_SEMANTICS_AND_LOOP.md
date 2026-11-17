# Semântica de DL, loop de caminhada e relógio — rodada 18

Data: 2026-11-06. Somente leitura passiva. Nenhum hook, patch, movimento ou foco.

Sessão: **PID 11596**, base `0x7ff73fc00000`. RVAs reconferidos nesta sessão.

---

## 1. DL e `+0xcf6`: o que é confirmado

### Assinatura real de `0x7b6ed0`

```
0x7b6ed0  mov [rsp+8], rbx
0x7b6ed5  push rdi / sub rsp,0x30
0x7b6eda  movzx edi, dl              ; dl -> edi (preservado)
0x7b6edd  mov  rbx, rcx              ; this
0x7b6ee0  cmp  byte [rcx+0xcf6], dl  ; mesmo byte de antes?
0x7b6ee6  je   0x7b6f42              ; sim -> NO-OP
0x7b6ee8  mov  byte [rcx+0xcf6], dl  ; grava
0x7b6eee  test dl, dl
0x7b6ef0  je   0x7b6f0c              ; dl==0 -> 0x7b4a50 (STOP)
0x7b6ef2  mov  qword [rcx+0xbf8], 0  ; ZERA throttle
0x7b6efd  call 0x7b4740              ; anda
0x7b6f02  mov  rcx, rbx
0x7b6f05  call 0x7b47c0              ; startAutoWalkLoop
0x7b6f0a  jmp  0x7b6f11
0x7b6f0c  call 0x7b4a50              ; stop
```

### Por que "zero leva à parada" e `Game::walk` usa zero para norte

**São parâmetros diferentes de funções diferentes.** Não há contradição.

| função | registrador | significado |
| :--- | :--- | :--- |
| `0x7b6ed0` | `dl` | **estado de caminhada ativa** (0 = parar) |
| `0x77f250` (`Game::walk`) | `edx` | **direção 0..7** (0 = norte) |

A direção nunca é passada por `dl` em `0x7b6ed0`. Ela vem de `[this+0xb4]`:

```
0x7b4746  mov r8d, [rcx+0xb4]    ; dentro do wrapper
0x7b4798  mov edx, [rbx+0xb4]    ; antes de Game::walk
```

**Confirmado.** `+0xcf6` guarda o último byte de `dl` (estado), não a direção.
A direção vive em `+0xb4`.

**Não confirmado:** se `dl` aceita 1..7 como direção. O `test dl,dl` mostra que
só o zero tem significado especial. O chamador real (`0x7e1f71`) passa `dil`,
cujo valor ainda não determinei. Não declaro `dl == direção`.

### Quem escreve `+0xb4`

Busca por escritas com `disp32 == 0xb4` no módulo: **208 candidatos**. É offset
comum em muitas classes — ruído, não resposta.

**Não resolvido.** Para achar o escritor real seria preciso filtrar por classe
(vtable de `LocalPlayer`), o que exige análise por referência de objeto, não
varredura de bytes.

### Quem escreve `+0xcf6` — resolvido

Busca por `mov r/m8, r8` com `disp32 == 0xcf6`:

```
0x7b0ed3  escritor no construtor (zera: mov byte [rsi+0xcf6], bpl com bpl=0)
0x7b6ee8  o próprio 0x7b6ed0
0x77defa  terceiro (disassembly desincronizado — não confirmado)
```

Ou seja: `+0xcf6` é escrito **essencialmente só** por `0x7b6ed0`. É estado
privado dele.

---

## 2. Caminhada contínua: SIM, existe

### A descoberta que fecha a questão

A vtable usada em `0x7b4910` é `RVA 0x1fae340`, e o RTTI dela é:

```
.?AV?$_Func_impl_no_alloc@V<lambda_1>@?1??startAutoWalkLoop@LocalPlayer@@IEAAXXZ@
```

**`LocalPlayer::startAutoWalkLoop`, função membro privada.**

`0x7b47c0` cria um `std::function` a partir dessa lambda e instala em
`[this+0xbe8]`:

```
0x7b47e9  cmp qword [rdi], 0        ; já existe? (rdi = &this+0xbe8)
0x7b47ec  jne 0x7b4a2d              ; sim -> sai
0x7b4910  lea rdx, [0x1fae340]      ; vtable da lambda_1
0x7b4978  call 0x840330             ; factory do std::function
0x7b4984  call 0x3134d0             ; instala em [this+0xbe8]
```

### O tick do loop

A lambda invocada é `0x996b10` (slot `[2]` da vtable):

```
0x996b34  call 0x341050             ; obtém shared_ptr<LocalPlayer>
0x996b44  cmp  byte [rcx+0xcf6], 0
0x996b4b  jne  0x996b54
0x996b4d  call 0x7b4a50             ; direção inativa -> STOP
0x996b54  call 0x7b4740             ; direção ativa -> continua andando
```

**Este é o loop de caminhada contínua.** Enquanto `[+0xcf6] != 0`, cada tick
chama o wrapper, que respeita throttle e valida tile.

### Como termina — `0x7b4a50`

```
0x7b4a5d  mov rbx, [rcx+0xbe8]      ; o std::function do loop
0x7b4a67  je  0x7b4af3              ; nulo -> só retorna
0x7b4a6d  mov byte [rbx+0x80], 1    ; marca "cancelado"
0x7b4a74  mov rcx, [rbx+0x78]
0x7b4a8e  call [0x1a3a820]          ; vtable+0x20 do alvo
0x7b4a94  mov qword [rbx+0x78], 0
0x7b4aba  mov rax, [rdi+0xbe8]
0x7b4ac6  mov qword [rdi+0xbe8], 0  ; DESINSTALA o loop
0x7b4ad1  mov rcx, [rdi+0xbf0]
0x7b4add  mov qword [rdi+0xbf0], 0
```

`0x7b4a50` **cancela e desinstala** o loop. Não é um "stop de um passo": é o
término da caminhada contínua.

### Ligação com o tick

```
0x7b6ed0(dir!=0)  ->  [Fire]  ->  instala loop em +0xbe8
                                  |
                      tick do loop (0x996b10) repete enquanto +0xcf6 != 0
                                  |
0x7b6ed0(0)       ->  0x7b4a50 -> cancela + desinstala o loop
```

**Consequência direta:** chamar `0x7b6ed0` com `dl != 0` **inicia caminhada
contínua**, não um passo. Nossa DLL não pode usar esse caminho para o contrato
`pendingStep` de um comando por passo.

---

## 3. Identidade do objeto e origem do relógio

### Relógio: minha análise anterior estava errada

Eu disse "divisão por 1000 = milissegundos" **sem provar a unidade**. Medi agora:

```
amostra 1: 3599623598
amostra 2: 3601625426
delta:       2001828  em 2.001 s
=> 1.000.494 ticks/segundo
```

**O relógio é em microssegundos.**

A magia `0x20c49ba5e353f7cf` com `sar 7` converte µs → ms:

```
clock = 3617759182 µs
imul + sar 7 = 3617759
clock/1000   = 3617759    <- idêntico
```

Portanto a comparação do throttle é:

```
agora_ms >= [this+0xbf8] + delay_ms
```

com `agora_ms` = `clock_us / 1000`. **Confirmado por medição, não por
inferência da divisão.**

### Identidade do objeto

| evidência | resultado |
| :--- | :--- |
| RTTI da lambda | `startAutoWalkLoop@LocalPlayer@@` |
| `0x341050` retorna | `shared_ptr<LocalPlayer>` |
| `[rbx+0x1a0]` no chamador | passado como `this` a `0x7b6ed0` |
| campos `+0xb4`, `+0xbf8`, `+0xcf6`, `+0xa20/24/28` | coerentes com o mesmo objeto |

**Confirmado por RTTI:** o objeto do loop é `LocalPlayer`.

**Não confirmado:** que `[0x39c7268]` (o global que usamos como `LocalPlayer`)
seja exatamente a mesma instância. Os campos coincidem, mas não li o ponteiro
do loop contra o global.

### O chamador de `0x7b6ed0`

Único `call rel32`:

```
0x7e1f71  call 0x7b6ed0
```

Contexto:

```
0x7e1f58  mov rax, [rbx+0x1a0]      ; LocalPlayer
0x7e1f5f  mov byte [rax+0xcf0], bpl
0x7e1f66  movzx edx, dil            ; dl = dil
0x7e1f6a  mov rcx, [rbx+0x1a0]
0x7e1f71  call 0x7b6ed0
```

`rbx` é um objeto controlador com `[+0x1a0]` apontando para `LocalPlayer`.
`dil` vem do estado de input. **É o caminho de input do cliente.**

Não localizei a entrada dessa função (provável handler de teclado), mas o
encadeamento `input → 0x7e1f71 → 0x7b6ed0` está claro.

---

## 4. Comparação: `Game::walk` vs caminhada contínua

| aspecto | `Game::walk(0x77f250)` | `0x7b6ed0` (ativa) |
| :--- | :--- | :--- |
| parâmetro | direção 0..7 | estado ativo (0 = parar) |
| efeito | **um passo** | instala loop contínuo |
| throttle interno | **não** | **sim** (`+0xbf8`) |
| valida tile | **não** | **sim** (`0x776000`) |
| estado residual | nenhum | `+0xbe8`, `+0xcf6`, `+0xbf8` |
| precisa desarmar | não | **sim** (`0x7b4a50`) |
| preserva `pendingStep` | **sim** | **não** |

### Recomendação

**`Game::walk` é o candidato correto para o nosso contrato de um comando por
passo.**

Motivos:

1. Um comando = um passo, sem estado residual para limpar.
2. Não instala loop nem timer — não há continuação assíncrona para invalidar.
3. `pendingStep` já controla a cadência; o throttle interno do cliente
   (`+0xbf8`) é um **segundo** controle que não precisamos e que atrasaria
   nossa confirmação.

O que `Game::walk` **não** faz e o wrapper faz, e que devemos replicar:

- validar o tile de destino (faixa, andar);
- respeitar o atraso mínimo.

Isso pode ser feito **no nosso lado**, com a nossa reconciliação por
`telemetry.tick` — que já existe.

Custo de escolher `Game::walk`: o cliente tem proteção contra passo em cima de
passo (`+0xbf8` só é escrito pelo wrapper). Chamando direto, **ignoramos essa
proteção** — e é exatamente o nosso `pendingStep` que deve ocupar esse papel.

**Não integro nada nesta rodada.** Falta a resposta do contexto de thread.

---

## 5. Lacunas que permanecem

| lacuna | coleta necessária |
| :--- | :--- |
| thread que executa o loop/input | hook de leitura em `0x7b4740` (5 bytes, rollback) ou no tick `0x996b10` |
| valor de `dil` em `0x7e1f66` | mesma coleta; ou achar a entrada da função de input |
| `[0x39c7268]` == instância do loop? | ler `[loop_obj]` e comparar com o global, com o jogo no mundo |
| quem agenda `0x996b10` | rastrear o scheduler do `std::function` |

A última é passiva: basta ler `[LocalPlayer+0xbe8]` e o objeto por trás, com o
jogo no mundo, e comparar com `[0x39c7268]`. **Não fiz porque o jogo está na
seleção agora.**

---

## 6. Estado das pendências

| marco | estado |
| :--- | :--- |
| Motor sem overshoot no cliente | **PENDENTE** |
| Executor nativo background | **NÃO IMPLEMENTADO** — `Game::walk` escolhido, contexto aberto |
| Teste A foreground | VALIDADO 19:10Z (sessão anterior) |
| `pendingStep` | intacto, 120/120 |

Testes locais não substituem validação no cliente.
