# Análise da tentativa 02 — o que o log comprova

Data: 2026-11-08
Escopo: auditoria de artefatos existentes. Nenhum attach, nenhuma injeção.

---

## 1. Correção aplicada

`tools/cdb/walktrace-game-clean.txt` — script sem comentários e sem
não-ASCII, com `bl` adicionado:

```
.printf "=== WALKTRACE BEGIN ===\n"
.time
bp pokealliance_dx+780c90 "r rip; r rdx; r r8; r rcx; kb"
bl
g
.echo "=== STOP CLASSIFY ==="
r rip
.lastevent
.echo "=== CLEANUP ==="
bc *
.echo "=== DETACH ==="
.detach
```

`bl` **nunca foi executado** nas tentativas anteriores. Sem ele não há
prova do endereço efetivo. Isso é uma lacuna de procedimento, não do jogo.

---

## 2. O que o log efetivamente comprova

Arquivo: `local-data/cdb-tests/game-attempt-02/cdb-console.txt` (232 linhas).

| # | fato | linha |
| :--- | :--- | :--- |
| 1 | attach completou; 79 `ModLoad` do cliente | 42–120 |
| 2 | break inicial do depurador em `ntdll!DbgBreakPoint` | 121–123 |
| 3 | `.printf` executou → `=== WALKTRACE BEGIN ===` | 159–160 |
| 4 | `.time` executou; process uptime 29 min | 161–172 |
| 5 | `bp pokealliance_dx+780c90` aceito | 179 |
| 6 | **`breakpoint 0 redefined`** | 181 |
| 7 | **nenhuma mensagem de erro de símbolo** (`deferred`, `could not be resolved`, `not qualified`) | — |
| 8 | `g` executado | 186 |
| 9 | parada como `Break instruction exception - code 80000003` em `0x7ff9da183f40` | 187–189 |
| 10 | `r rip` → `00007ff9da183f40` | 200 |
| 11 | `.lastevent` → mesmo endereço | 202–206 |
| 12 | `bc *` executado | 213 |
| 13 | `.detach` → `Detached` | 216–217 |

### Sobre `breakpoint 0 redefined`

O cdb emite essa mensagem quando **já existe** um bp com o mesmo número.
Neste log há **apenas uma** invocação de `bp` (linha 179), mas o cdb manteve o
número 0 do break inicial interno. A mensagem **não prova defeito**, mas
também **não prova** que o endereço resolvido é o pretendido — porque nunca
listamos com `bl`.

Nos ensaios auxiliares que tiveram hit (`final-hit.log`), não houve
`redefined`, e o log mostrou explicitamente `Last event: Hit breakpoint 0`.

**No jogo: nunca apareceu `Hit breakpoint 0`.** Apareceu `Break instruction`.
Isso é consistente com parada por interrupção, não por breakpoint nosso.

### Ressalva honesta

Não há como afirmar pelo log se o bp apontava para `base+0x780c90`. O cdb não
imprimiu o endereço resolvido. `bl` teria resolvido isso em uma linha.

---

## 3. Movimento: não confirmado

Perguntei ao operador. Resposta: **"não prestei atenção / não lembro"**.

| registro | existe? |
| :--- | :--- |
| confirmação visual retrospectiva | nenhuma |
| movimento registrado com timestamp | **não foi coletado** |

Portanto: **movimento permanece não comprovado**. Não atribuo zero hits ao
endereço nem ao jogo.

---

## 4. Análise estática sobre o build atual (leitura de memória, sem attach)

Feita por `ReadProcessMemory` no PID 28308 ainda vivo.

### Chamadores de `Game::walk` (`0x780c90`) neste build

Exatamente **dois** `E8 rel32`:

| chamadora (RVA) | função | observação |
| :--- | :--- | :--- |
| `0x74742a` | `0x7463d0..0x74752c` (=0x115c B) | função grande, prosa de prólogo com 8 pushes |
| `0x7b6381` | `0x7b6346..0x7b6392` (76 B) | **wrapper de throttle** |

### O wrapper `0x7b6346`, íntegro

```
0x7b6346  mov  [rsp+30], rdi
0x7b634b  movabs rax, 0x20c49ba5e353f7cf     ; divisão por 1000 (relógio ms)
0x7b6355  imul rdx
0x7b6358  mov  eax, r8d                      ; delay
0x7b635b  add  rax, [rbx+0xbf8]              ; timestamp do último passo
0x7b6362  mov  rdi, rdx
0x7b6365  sar  rdi, 7
0x7b6369  mov  rcx, rdi
0x7b636c  shr  rcx, 0x3f
0x7b6370  add  rdi, rcx                      ; rdi = agora_ms
0x7b6373  cmp  rdi, rax
0x7b6376  jl   0x7b638d                      ; cedo demais -> sai
0x7b6378  mov  edx, [rbx+0xb4]               ; direção
0x7b637e  xor  r8d, r8d
0x7b6381  call 0x780c90                      ; Game::walk(dir, 0)
0x7b6386  mov  [rbx+0xbf8], rdi
0x7b638d  mov  rdi, [rsp+30]
0x7b6392  add  rsp, 0x20
0x7b6396  pop  rbx
0x7b6397  ret
```

Isso reproduz o wrapper documentado em `docs/WALK_CALLER_CONTEXT.md`, agora em
RVA `0x7b6346` (o antigo era `0x7b4740`; **não é o mesmo endereço**).

### O que isso estabelece e o que não estabelece

**Estabelece:** existe um wrapper neste build que (a) lê a direção de
`[rbx+0xb4]`, (b) aplica throttle por `[rbx+0xbf8]`, e (c) chama `0x780c90`.
Assinatura idêntica à documentada.

**Não estabelece:** que esse wrapper seja o caminho do teclado. Não há
referência direta (`call`/`jmp`) a `0x7b6346` no módulo — ele deve ser
chamado indiretamente (vtable, pointer, ou registrador). Não persegui isso,
porque está fora do escopo desta rodada.

**Correção de hipótese anterior:** eu disse que "o loop contínuo" seria um
caminho alternativo que evitaria o handler. Isso está **errado como
afirmação**. A análise anterior mostrava o loop **chamando** o handler. Não
apresento loop como alternativa comprovada.

**Prólogo coincidente não prova identidade funcional.** O wrapper tem a mesma
assinatura de instruções do antigo, mas isso é forte indício, não prova.

---

## 5. Hipótese prioritária

**H1 (prioritária): a coleta não confirmou movimento, e o breakpoint nunca
foi verificado com `bl`. Zero hits é compatível com "nada aconteceu na
janela", não com "a função não é usada".**

Sustentação: (a) movimento não confirmado pelo operador; (b) `bl` nunca
executado; (c) nenhuma mensagem `Hit breakpoint 0` no log; (d) o wrapper que
chama `0x780c90` existe e está íntegro, portanto a função **é** alcançável.

**H2 (secundária): o breakpoint não resolveu para o endereço pretendido.**
Sustentação: `breakpoint 0 redefined` sem `bl` para conferir. Não há evidência
de erro de símbolo, o que enfraquece H2, mas não a elimina.

**H3 (terciária): o caminho do teclado não passa por `0x780c90` neste build.**
Não testada. O wrapper existe, mas não provei que o input o alcança.

**Descartada:** anti-debug. A tentativa 01 morreu por caminho de script
inexistente; esta sobreviveu com o caminho correto.

---

## 6. Próxima ação discriminante

**Uma coleta sincronizada, com `bl` e confirmação de deslocamento.**

Diferenças em relação à tentativa 02:

1. Script `walktrace-game-clean.txt` com **`bl`** — imprime o endereço
   efetivo do breakpoint. Elimina H2 se mostrar `pokealliance_dx+0x780c90`.
2. **Sinal de pronto explícito** e confirmação sua de que o personagem
   **andou** durante a janela. Elimina H1.
3. **Um único toque**, sem aumentar para 1 s (evita múltiplos passos).

Matriz de resultados:

| `bl` mostra | movimento | conclusão |
| :--- | :--- | :--- |
| `+0x780c90` | sim | H1 e H2 eliminadas → H3: caminho não é `Game::walk`; investigar o wrapper e o dispatcher de input |
| `+0x780c90` | não | H1 confirma: problema é a tecla não gerar passo, não o endereço |
| outro endereço / não resolvido | — | H2 confirma: corrigir a expressão do bp |

Não executo sem nova autorização.

---

## 7. Preservado

- logs originais das tentativas 01 e 02, intocados
- tracer congelado `810A87FF…318B`
- `WalkerEngine` `2887A1E7…86864`, `pendingStep`, `native-step.cjs`
- 20/20
