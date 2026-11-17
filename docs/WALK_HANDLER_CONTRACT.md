# Handler de caminhada: contrato confirmado

Data: 2026-11-06. **Somente leitura** na imagem do cliente já aberto.
Nenhuma execução, chamada, injeção, alteração de foco ou movimento.

Origem: auditoria independente em
`C:\Users\yago\.t3\scratch\2026-11-05-you-are-silas-a-shadow-0ec3ee10\shiba-walk-audit`.
Reproduzida localmente: **17/17 assertions**, hashes conferidos.

---

## 1. Reprodução da auditoria

```
$ python analyze_shiba_walk.py --root "<repo oficial>" --out <tmp>
{"assertions_passed": 17, "walk_type_rva": "0xe51b8",
 "mappings": [{"profile":6,"row_rva":"0xe5590","key":"0x70d1d0",
               "client_handler_rva":"0x77f250", ...},
              {"profile":5,"row_rva":"0xe6b50","key":"0x70d1d0",
               "client_handler_rva":"0x720fe0", ...}],
 "existing_walk_trace_records": 0}
```

| âncora pedida | reproduzida |
| :--- | :--- |
| consumidor `payload+0xd4ac0` | sim — `movups xmm0,[rdi+0x178]` em `0xd4bae` |
| chamada ao consumidor `payload+0x14f35` | sim |
| chamada ao executor `payload+0x14f59` | sim |
| executor `payload+0x11cc0` | sim |
| ramo walk `payload+0x1210d` | sim — `movzx ebx,[rbx+8]`, `cmp bl,7` |
| descritor walk `payload+0xe51b8` | sim — chave `0x70d1d0` |
| perfil 6 → `exe+0x77f250` | sim |
| gate `payload+0x1dc20` = `GetCurrentThreadId` vs registrado | sim; thread gravada **31356** |

Divergência encontrada: **nenhuma**. Todos os endereços batem.

Único achado do próprio relatório que já estava correto e não mudou: o trace
`pka_dispatch_32036.jsonl` tem 20.000 registros e **zero** com `rcx` igual ao
descritor walk. Isso não prova ausência de walk; aquele arquivo simplesmente
não registra uma chamada.

---

## 2. LACUNA 1 — corpo do handler: CONFIRMADO

O relatório dizia "o corpo do handler não está nos dumps". **Está no cliente.**
O handler `exe+0x77f250` existe na build atual (`82eadedc…`), **no mesmo RVA**,
com o mesmo prólogo:

```
48895c2408 55 56 57 41 56 41 57 488d6c24c9 4881eca0000000
```

Assinatura encontrada 3× no módulo atual: `0x323290`, **`0x77f250`**, `0x8b5560`.
O de `0x77f250` referencia a string `[%i] Game::walk` (RVA `0x2020f60`) — é
o alvo certo, não um dos homônimos.

### Contrato do handler

```
RCX = this            (objeto Game; NÃO recarregado -> é o 1º argumento)
EDX = direção (movsxd rdi, edx)
R8B = flag de origem  (movzx r14d, r8b)
```

### O que ele verifica, em ordem

| RVA | verificação | efeito se falhar |
| :--- | :--- | :--- |
| `0x77f28b` | flag global `0x39c73a8` | `je` → sai |
| `0x77f298` | ponteiro global `0x39c7268` ≠ 0 | sai |
| `0x77f2a8` | `[rax+0xb0]` > 0 | sai |
| `0x77f2b5` | flag global `0x39c73aa` | sai |
| `0x77f2c2` | ponteiro global `0x39c72a8` ≠ 0 | sai |
| `0x77f2d2` | `call 0x88ec20(this)` | `test al,al` → sai se 0 |
| `0x77f49f` | `cmp edi, 7` | `ja` → sai |

`0x88ec20` (gate de estado) faz exatamente:
```
cmp qword [rcx+0x40], 0   ; precisa ser 0
cmp dword [rcx+0x24], 0   ; precisa ser 0
mov rax,[rcx+0x68]        ; precisa existir
cmp byte [rax+0x3d0], 0   ; precisa ser != 0
```

### O que ele faz com a direção

Tabela de saltos relativa em `0x77f824` (8 entradas, `dir*4`), cada uma leva a
um ramo que monta a mensagem:

| dir | RVA do ramo | opcode escrito | Tibia |
| :--- | :--- | :--- | :--- |
| 0 | `0x77f4c9` | `0x65` | North |
| 1 | `0x77f50c` | `0x66` | East |
| 2 | `0x77f54f` | `0x67` | South |
| 3 | `0x77f592` | `0x68` | West |
| 4 | `0x77f5d5` | `0x6A` | NE |
| 5 | `0x77f618` | `0x6B` | SE |
| 6 | `0x77f658` | `0x6C` | SW |
| 7 | `0x77f698` | `0x6D` | NW |

Cada ramo:
```
mov rbx, [rip+..]          ; objeto global 0x39c72a8
lea rcx, [rbp+7]           ; OutputMessage local
call 0x548c30              ; inicializa objeto
mov edx, 0x65+           ; <<< OPCODE DE DIRECAO
call 0x5410c0              ; append WORD no buffer
mov rax, [rbx]             ; vtable
mov rax, [rax+8]           ; slot de envio
call rax                   ; ENVIA
```

`0x5410c0` é `OutputMessage::addByte`-like:
```
mov r8d, [rcx+0x24]        ; tamanho atual
mov word [r8+rcx+0x2c], dx ; escreve o opcode
add qword [rcx+0x24], ...  ; incrementa
```
Tem até a checagem `OutputMessage max buffer size` (string em `0x2039eb0`).

**Conclusão:** o handler monta uma mensagem de saída com o opcode de direção e
a despacha pela vtable. É envio de pacote, não tecla.

### O que NÃO chama

No corpo inteiro: **zero** `PostMessage`, `SendInput`, `keybd_event`,
`GetAsyncKeyState`, `GetKeyboardState`. Isso não é inferência — os imports
dessas funções foram procurados na IAT em memória e no módulo do jogo, e não
existem lá.

### Ainda desconhecido

- **ABI de retorno** do handler (o dispatcher testa `al`, então retorna bool).
- **Semântica de `R8B`** (flag de origem). É copiada para `r14d` e passada a
  `0x9406d0`; não sei o que significa.
- **Identidade do objeto em `0x39c72a8`** (a vtable de envio). É global, mas
  não confirmei qual classe é.
- **`this`**: o handler usa `RCX` como veio do dispatcher. Não achei um slot
  global de `Game` que passe no gate `0x88ec20` — o candidato em `0x227cc88`
  era falso positivo (continha ASCII `"6414"`, não um ponteiro). O `this` vem
  da pilha do chamador, não de um global fixo que eu possa localizar
  estaticamente.

---

## 3. LACUNA 2 — contexto de execução: PARCIAL

### O que já está provado

O gate `payload+0x1dc20` faz:
```
mov ebx, [rip+0x20709a]     ; thread ID registrado
test ebx, ebx
je  <falha>
call [GetCurrentThreadId]   ; IAT slot 0xe40e8, KERNEL32
cmp eax, ebx                ; precisa ser IGUAL
jne <falha>
```

Thread gravada na captura: **31356**. Ou seja: **chamar de thread arbitrária é
recusado**. Possuir ABI x64 e alinhamento não basta.

### O que continua desconhecido

1. **Quem instala o callback** que consome o comando (`0x14f35`). O relatório
   registra o chamador mas não quem o agenda.
2. **Qual evento aciona essa thread** e se ela continua rodando sem foco ou
   minimizada.
3. Se a thread `31356` da captura é o render, a UI, ou uma thread própria do
   runtime. **Não presumo nenhuma das três.**

### Evidência exata que falta

Uma leitura do processo que responda:
- lista de threads do PID com start address dentro do módulo do jogo;
- qual delas tem ID igual ao valor em `[module+0x21xxxx]` no momento;
- se o handler é alcançável a partir do message loop dessa thread.

Isso é **uma** coleta de `Thread32First`/`Thread32Next` + `GetThreadStartAddress`,
sem ação no jogo. Não executei porque exige autorização e você pediu plano
específico antes.

---

## 4. O que isso muda na arquitetura

O caminho do Shiba fica claro e **não copiável**:

```
menu → kind 11 → DLL deles → send() → OutputMessage → socket → servidor
```

O que é reaproveitável é a **ideia**: montar a mensagem e entregá-la ao canal
do cliente, em vez de simular tecla.

Para o nosso bot, isso significa: o executor precisa, em vez de
`PostMessage`, **entregar um pacote de saída**. As duas opções honestas:

- **(a)** achar o mesmo ponto de envio (OutputMessage::send via vtable) e
  chamá-lo do contexto certo; exige resolver vtable + thread;
- **(b)** falar direto com o servidor, se o protocolo for reproduzível — mas
  há criptografia de sessão (XTEA é padrão em OTClient), o que é outro projeto.

Nenhuma das duas está pronta. A (a) é a continuação natural desta auditoria.

---

## 5. Menor próximo passo

**Uma** coleta, sem ação no jogo:

1. `Thread32First/Next` no PID → lista de thread IDs e start addresses;
2. ler o global de thread do módulo e comparar;
3. se bater, essa é a thread que o gate exige — e o próximo passo é verificar
   se ela sobrevive a minimização (observação passiva, sem comando).

Isso responde "qual thread" sem tocar em nada. O "se funciona em background"
continua exigindo uma tentativa real, depois.

---

## 6. Correções que devo ao registro

| afirmação anterior minha | correção |
| :--- | :--- |
| "o Shiba chama `LocalPlayer::walk` diretamente" | **não provado.** O handler em `0x77f250` referencia `[%i] Game::walk` e monta um OutputMessage. O nome da classe vem da string vizinha, não de RTTI do handler. `Game::walk`, não `LocalPlayer::walk`. |
| "in-process comprova funcionamento sem foco" | **não comprova.** In-process é localização de execução. O gate de thread mostra que contexto importa, e nada foi testado minimizado. |
| "o overshoot foi reproduzido localmente" | ordem correta: **observado no cliente primeiro** (01:24Z, 2 tiles), **depois** reproduzido em teste determinístico. |
| "testes determinísticos substituem" | **não substituem.** A correção do overshoot continua pendente de confirmação no cliente. São duas comprovações distintas. |
| "dias de trabalho / manutenção por build" | **estimativa sem base.** O mecanismo concreto ainda não foi analisado até o ponto de estimar. O que se sabe: RVA do handler é estável entre as builds testadas (`0x77f250` nas duas). |
