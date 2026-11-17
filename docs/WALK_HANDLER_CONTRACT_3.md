# Contrato do executor nativo — rodada 16 (reprodução + caminho natural)

Data: 2026-11-06. Somente leitura. Nenhuma execução, chamada, injeção, hook,
suspensão, movimento ou alteração de foco.

Fonte: `native-walk-20261106/PROMPT_UNIFICADO_OPENCODE.md` + auditoria
independente. Reprodução feita neste repo.

---

## 1. Reprodução da evidência

### 1.1 Auditoria nova (28 assertions)

```
python shiba-walk-audit/analyze_native_walk.py \
  --capture .../capture-final.json --out .../opencode-recheck
-> assertions_passed: 28
   types: {session: .?AVLocalPlayer@@, object: .?AVProtocolGame@@, pair: .?AVTile@@}
   unknowns: []
```

Comparei o resultado novo com o `analysis.json` original:

| item | original | minha reprodução |
| :--- | :--- | :--- |
| assertions | 28 | **28** |
| handler_instructions | 366 | **366**, JSON idêntico |
| edges | 40 | **40** |
| gate_samples | 6 | **6** |
| types | LocalPlayer/ProtocolGame/Tile | **idêntico** |

### 1.2 Auditoria de referência (17 assertions)

```
analyze_shiba_walk.py -> assertions_passed: 17
walk_type_rva 0xe51b8 | key 0x70d1d0 | perfil 6 -> exe+0x77f250
```

**Reprodução exata. Nenhuma divergência.**

### 1.3 Medição própria no cliente (PID 21900, no mundo)

```
[base+0x39c7268] vtable 0x7ff6aa8717d0  .?AVLocalPlayer@@
[base+0x39c72a8] vtable 0x7ff6aa86aff8  .?AVProtocolGame@@
[LocalPlayer+0x9a8] vtable 0x7ff6aa869210  .?AVTile@@
[LocalPlayer+0x9a8] = 0x...ac50  [LocalPlayer+0x9b0] = 0x...ac40  (Δ16, refcount 3/2)
ProtocolGame: +0x40=0  +0x24=1963560364  +0x20=0  +0x68=0
gate (fluxo correto) -> true
LocalPlayer pos = (957,1404,6) hp=100
```

---

## 2. Correções incorporadas ao contrato

| # | premissa antiga | corrigido | evidência |
| :-- | :--- | :--- | :--- |
| 1 | "as globais estão zero na seleção" como estado atual | revalidado: **estão preenchidas** com o personagem no mundo | medição 1.3 |
| 2 | objeto é `Game` | `LocalPlayer` e `ProtocolGame` (RTTI) | 1.3 |
| 3 | gate = conjunção de 4 campos | tem **caminho alternativo**: se `+0x40` ou `+0x24` ≠ 0 → `+0x20 == 0` | recalculado: antigo=false, real=true |
| 4 | `+0x9a8/+0x9b0` = fila de pacotes | **par de `shared_ptr<Tile>`** (Δ16, refcount atômico) | 1.3 |
| 5 | procurar drenador naqueles campos | **suspenso** — sem evidência de fila | 1.3 |
| 6 | `R8B`/retorno | `R8B = 0` (único chamador zera `r9d`); retorno **desconhecido** | 1.1 + disasm |
| 7 | in-process = funciona sem foco | in-process só diz onde executa | — |
| 8 | teste A prova o transporte | prova **aquele caminho**, não todos os kinds | — |

---

## 3. Descoberta nova desta rodada: o caminho natural de execução

O prompt pedia para investigar `0x41a37c7` e `0x9406d0`. Fui além e localizei
**os chamadores reais** de `Game::walk`.

### 3.1 Quem chama `Game::walk` (0x77f250)

Busca por `call rel32` apontando para o handler, no módulo inteiro:

```
0x745ada   (contexto não decodifica — provável dado, não código)
0x7b47a1   ✓ chamador real
```

Referências absolutas (`qword`) ao handler: **0**.
Entrada em `.pdata`: **não há** (a tabela do módulo não cobre esses alvos).

### 3.2 O wrapper `0x7b4741` — caminho natural completo

```
0x7b4741 push rbx / sub rsp,0x20
0x7b4746 mov  r8d, [rcx+0xb4]        ; direção vinda do objeto
0x7b474d mov  rbx, rcx               ; this
0x7b4750 call 0x776000               ; validação → WORD em ax
0x7b4759 test r8w, r8w
0x7b475d je   0x7b47b2               ; inválido → sai
0x7b475f mov  rdx, [0x398cdd0]       ; relógio base
0x7b4775 imul (magic 0x20c49ba5e353f7cf)
0x7b4785 sar  rdi, 7                 ; rdi = agora (ms)
0x7b477b add  rax, [rbx+0xbf8]       ; último passo + ...
0x7b4793 cmp  rdi, rax
0x7b4796 jl   0x7b47ad               ; THROTTLE: cedo demais → sai
0x7b4798 mov  edx, [rbx+0xb4]        ; direção
0x7b479e xor  r8d, r8d               ; <<< R8B = 0 confirmado no chamador
0x7b47a1 call 0x77f250               ; Game::walk(dir, 0)
0x7b47a6 mov  [rbx+0xbf8], rdi       ; atualiza timestamp
```

**Isso responde três coisas de uma vez:**

1. **`R8B = 0`** não é escolha: o único chamador real zera explicitamente.
2. **Existe throttle no cliente**: `[this+0xbf8]` guarda o último passo. O
   cliente já limita a cadência. Não preciso inventar pacing.
3. **Há validação antes**: `0x776000` checa `word [rcx+0x164] >= 1` e
   `r8d == 8` (caso especial) antes de permitir.

### 3.3 O wrapper não tem referência estática

- `call rel32` para `0x7b4741`: **0**
- `jmp rel32`: **0**
- `qword == base+0x7b4741` em toda a imagem: **0**

**Conclusão:** o wrapper é invocado por ponteiro guardado em heap — é um
**callback registrado dinamicamente**, não uma chamada direta. Provavelmente
é o handler de input do cliente (o `this` tem `+0xb4` = direção e `+0xbf8` =
timestamp de passo).

Isso é coerente: no OTClient, o input de teclado chega por callback e chama a
camada que valida e então `Game::walk`.

### 3.4 `0x776000` compartilha a camada de tile

```
0x77600a cmp word [rcx+0x164], 1
0x776018 jb  <saida>
0x77601e cmp r8d, 8
0x776022 jne <caminho normal>
0x77603b mov rax, [rcx]
0x776046 mov rax, [rax+0x110]       ; vtable+0x110
0x77604d call [0x1a3a820]           ; MESMO thunk do handler
```

`vtable+0x110` de `LocalPlayer` = RVA `0x765230`. O mesmo thunk
`0x1a3a820` (`jmp rax`) usado no handler aparece aqui.

**Portanto existe uma camada comum**: obter o tile na direção → validar →
depois `walk`. O handler não é o único ponto; ele é o passo final.

---

## 4. `0x41a37c7` — o alvo virtual, reavaliado

Cadeia verificada ao vivo:

```
ProtocolGame vtable(0x1faaff8)+8
  -> 0x80f6b0  jmp
  -> 0x88ec50  jmp
  -> 0x41a37c7
```

Medições:

| métrica | `Game::walk` (normal) | `0x41a37c7` |
| :--- | :--- | :--- |
| entropia | 5.77 bits/byte | **6.20** |
| strings num raio 0x400 | — | **0** |
| `.pdata` | não coberto | **não coberto** |
| densidade `e9`/0x500 | — | **28** |

O trecho tem fluxo fragmentado (`jmp` para o meio de instruções) e nenhuma
entrada `.pdata`. **Não é decodificável por disassembly linear confiável.**

**Não declaro envio síncrono, enfileiramento, thread-safety ou dependência de
foco desse método.** Continua desconhecido.

---

## 5. Contrato consolidado

### CONFIRMADO

| item | valor | evidência |
| :--- | :--- | :--- |
| handler | `exe+0x77f250`, corpo `0x77f250..0x77f844` | RTTI + string `[%i] Game::walk` |
| assinatura | `RCX` ignorado; `EDX`=direção; `R8B`=0 | disasm + chamador |
| `this` | global `[base+0x39c72a8]` = `ProtocolGame` | RTTI |
| gate | `+0x40`/`+0x24` ≠0 → `+0x20==0`; senão `[[+0x68]+0x3d0]!=0` | recalculado |
| direção | 0..7, tabela `0x77f824`, opcodes `0x65..0x6D` | disasm |
| efeito | substitui par `shared_ptr<Tile>` em `LocalPlayer+0x9a8/+0x9b0` | Δ16 + refcount |
| chamador real | `0x7b4741` wrapper com throttle | `call rel32` |
| throttle | `[input+0xbf8]` vs relógio | disasm |
| validação prévia | `0x776000`, `word[+0x164]>=1` | disasm |

### DESCONHECIDO

| item | por quê |
| :--- | :--- |
| tipo de retorno do handler | sem `xor eax/eax` ou `mov al,1` claros; `.pdata` não cobre |
| o que `0x9406d0` faz | corpo lido (30 instruções) mas sem conclusão de efeito |
| quem registra o callback `0x7b4741` | sem referência estática; precisa de heap/registro |
| thread natural do callback | não demonstrada |
| comportamento de `0x41a37c7` | código ofuscado |
| se sobrevive a minimizar | não testado |

---

## 6. O elo que falta para integrar

Para chamar `Game::walk` da nossa DLL, é preciso:

1. `ProtocolGame` — **resolvido** (`[base+0x39c72a8]`).
2. `LocalPlayer` — **resolvido** (`[base+0x39c7268]`), e é o que o gate checa
   indiretamente via `+0xb0`.
3. Direção — **resolvido** (0..7).
4. `R8B = 0` — **resolvido**.
5. **Contexto de thread** — **NÃO resolvido**.

O item 5 é o único bloqueio real. E a descoberta desta rodada o torna mais
concreto: o caminho natural é *input callback → wrapper (throttle) → validação
→ Game::walk*. Se eu chamar `Game::walk` direto da thread do pipe, **pulo o
throttle e a validação**. Isso não é só inseguro — produziria comportamento
diferente do cliente.

---

## 7. Menor coleta que falta

**Pergunta:** qual thread executa `0x7b4741` e ele sobrevive a minimizar?

**Plano (requer autorização, não executado):**

| item | detalhe |
| :--- | :--- |
| ferramenta | (a) enumeração de threads + start address; se insuficiente, (b) hook de leitura em `0x7b4741` registrando `GetCurrentThreadId` |
| dados | thread ID que executa o wrapper; se é a mesma do message loop; se continua com a janela minimizada |
| duração | um passo manual de caminhada, observado |
| efeito de (b) | intromissão: patch de 5 bytes + original salvo. **Rollback obrigatório ao final.** |
| critério de parada | primeiro walk observado; ou 60 s sem walk |
| o que resolve | o contexto exigido e se existe caminho minimizado |

Começar por (a), que é inócuo. Só propor (b) se (a) não responder.

---

## 8. Arquitetura de integração (não implementada)

```
config → WalkerEngine → BotRuntime → CommandDispatcher   (inalterado)
  → Transport (pipe)                                      (inalterado)
    → pka_native.dll: execute_command(type 1)
      → [novo] chamar Game::walk(dir, 0)
           em thread do cliente, respeitando o throttle
```

Regras que o executor deve seguir, todas com base no que foi medido:

- resolver `ProtocolGame` e `LocalPlayer` em runtime (nunca RVA fixa);
- revalidar o gate com o **fluxo correto** (não a conjunção antiga);
- respeitar `[input+0xbf8]` (não emitir passo antes do throttle permitir);
- recusar explicitamente se sessão inválida (`LocalPlayer` nulo ou `hp<=0`);
- **não** cair para teclado em caso de falha.

---

## 9. Marcos preservados, separados e abertos

| marco | estado |
| :--- | :--- |
| Motor: `pendingStep` sem overshoot no cliente | **PENDENTE** — corrigido e testado localmente (120/120), nunca confirmado no cliente depois da correção |
| Executor nativo: caminhada sem foco | **NÃO IMPLEMENTADO** — contrato quase completo, contexto bloqueado |
| Teste A (teclado foreground) | VALIDADO NO CLIENTE 19:10Z — válido só para aquele caminho |
| Background / minimizado | **NÃO SUPORTADO**, sem evidência |
