# Tarefa — GPT / Codex: resolver o destino do `!autocombo`

Data: 2026-11-10
Executor no cliente: **DeepSeek** (único autorizado a injetar e controlar o jogo)
Seu escopo: **só análise estática dos artefatos deste repositório.**

---

## Regras

- **Não** editar `native/`, `tools/`, `botfinal/`, `reconstruction/`.
- **Não** injetar, não reiniciar, não tocar no cliente.
- **Não** afirmar "resolvido" sem endereço + assinatura de bytes + evidência.
- Se um dado não estava no dump, escreva "não estava no dump".
- O arquivo de saída se chama `COMBO_RESOLUCAO_DESTINO.md` — **não**
  `..._RESOLVIDO.md`, porque ainda não está.

---

## Artefato

```
dumps/payload_reconstructed.dll
size    3293184 (0x324000)
sha256  0fce980b4d478e21ef751e1cce9d40b22220a4014d83711818cf4796887e8a70
```

Imagem crua, sem header PE (module stomping). Offsets são de **imagem**.
Confirmado pelo DeepSeek: o SHA256 confere.

---

## O que eu já descobri (valide, não redescubra)

### Cadeia do comando

```
payload+0x10fe5  cmp qword [rcx+0x10], 0x0b        ; len == 11 = len("!autocombo ")
payload+0x10feb  lea rdx,[rip+0xd3686] -> 0xe4678  ; "!autocombo"
payload+0x11022  lea rcx,[rip+0xd1e7f] -> 0xe2ea8  ; descritor
payload+0x11029  call 0x19b20                       ; despachante
```

Strings confirmadas por busca de bytes:
- `0xe4678` = `"!autocombo\0"` (sem espaço)
- `0xe4650` = `"!autocombo "` (com espaço, 11 bytes)

### O despachante `0x19b20`

```
+0x19b20  40 53 56 57 41 56 48 83 ec 48     push rbx/rsi/rdi/r14 ; sub rsp,0x48
+0x19b46  80 3d .. .. 00                  cmp byte [rip+global],0
+0x19b53  80 3d .. .. 00                  cmp byte [rip+global2],0
+0x19b60  8b 3d .. .. ..                  mov edi,[rip+global3]
+0x19b6d  8b 15 .. .. ..                  mov edx,[rip+global4]
+0x19b78  48 8d 05 21 9a 0c 00            lea rax,[rip+0xc9a21] -> 0xe35a0  ; TABELA
+0x19b83  39 08                            cmp [rax],ecx        ; compara CHAVE
+0x19b8b  48 83 c0 20                     add rax,0x20         ; STRIDE 0x20
+0x19bc6  8b 00                            mov eax,[rax]        ; pega valor
+0x19bcf  89 05 .. .. ..                  mov [rip+global5],eax
+0x19bea  ff d0                            call rax             ; chamada indireta
```

### A tabela em `0xe35a0`, stride `0x20`

Cada entrada tem **dois dwords de endereço** seguidos de **bytes de código**:

```
[0] @0xe35a0  d0=0x0070d1a0  d1=0x007037d0  +8: 48 83 ec 28 80 3d 35 77  (código)
[1] @0xe35c0  d0=0x0070c350  d1=0x00702990  +8: 48 89 5c 24 10 48 89 74  (prólogo)
[2] @0xe35e0  d0=0x00715570  d1=0x0070c6f0  +8: 48 89 5c 24 08 48 89 6c  (prólogo)
[3] @0xe3600  d0=0x0070e520  d1=0x00704c20  +8: 40 53 56 57 41 56 48 83  (prólogo)
[4] @0xe3620  d0=0x003a6cc0  d1=0x003a2250  +8: 44 0f b6 c1 49 ba b3 01
[5] @0xe3640  d0=0x003027c0  d1=0x00300080  +8: 48 89 5c 24 08 57 48 83  (prólogo)
[7] @0xe3680  d0=0x00639ba0  d1=0x006325b0
```

### Correlação que já encontrei

O descritor passado ao despachante (`0xe2ea8`) contém o dword `0x639ba0`:

```
0xe2ea8: a0 9b 63 00 | 40 55 53 56 57 41 54 41 55 41 56 41 57 ...
         ^^^^^^^^^ dword = 0x639ba0
```

E `0x639ba0` **é exatamente a chave da entrada [7]** da tabela.

**Minha leitura:** `d0` = chave de tipo, `d1` = RVA do handler. Logo o handler do
`!autocombo` seria **`0x6325b0`** (o `d1` da entrada [7]).

**Não está provado.** É onde você entra.

---

## As três coisas que você precisa fechar

### A. Confirmar qual dword é o destinatário

`+0x19bc6  mov eax,[rax]` — `rax` aqui aponta para `entrada + 0`, então lê
`d0`, **não** `d1`. Mas antes do `lea rax,[0xe35a0]` há dois `cmp [rax],ecx` e
um `add rax,0x20`. Refaça o fluxo **instrução por instrução** de `0x19b20` a
`0x19bf1` e diga, com certeza:

- qual dword da entrada vira o destino de `call rax`
- se o loop avança em `0x20` comparando `d0` e chamando `d1`, ou o contrário
- em que ponto o valor é gravado no global `[rip+...]` (o `mov [rip+global5],eax`
  em `+0x19bcf`) e o que esse global guarda

### B. Provar que `0x6325b0` é o handler certo — se for

Se a leitura acima estiver correta:

1. desmonte `payload+0x6325b0` e mostre o prólogo
2. verifique se ele **lê a string com espaço** (`!autocombo` + args separados por
   vírgula), o que casaria com o `cmp [rcx+0x10], 0x0b` do chamador
3. procure ali o tratamento de vírgula (`0x2c`) e do prefixo de 11 bytes

**Se `0x6325b0` não fizer sentido**, diga qual entrada/valor faz e por quê.

### C. Dizer onde esse handler vive no build atual

`0x6325b0` está dentro de `payload` (0x324000 bytes). Mas o payload é um dump
de `msftedit.dll` stomped — os RVAs podem ser **da imagem original do jogo**,
não do payload. Então:

1. pegue os primeiros 32 bytes em `payload+0x6325b0`
2. procure essa sequência no `PokeAlliance_dx.exe` em memória (base
   `0x7ff65a1d0000` no PID 27416, tamanho `0x62d8000`) — **se o executável não
   estiver acessível, diga que não está**
3. se achar, informe **RVA do exe** e a assinatura de 32 bytes para reancorar
4. se não achar, informe se é código que só existe no payload (plugin) ou
   se a busca falhou por outro motivo

**Alternativa sem o jogo vivo:** você pode buscar a sequência no
`dumps/payload_reconstructed.dll` e comparar com os RVAs que eu já validei no
exe vivo (`0x780c90` = `Game::walk`, `0x784be0` = handler de attack). Se os
padrões de codegen (prólogos, uso de cookie) forem compatíveis, os RVAs são do
mesmo binário.

---

## Saída obrigatória

Arquivo: **`docs/COMBO_RESOLUCAO_DESTINO.md`**

```markdown
## Veredito
Uma linha: qual dword é o destino, e o RVA do handler do !autocombo.

## Fluxo do despachante (instrução por instrução)
0x19b20..0x19bf1, com a origem de cada registrador.

## Handler
- RVA no payload
- prólogo (hex)
- evidência de que trata "!autocombo <args separados por vírgula>"

## Onde vive no build atual
- RVA no exe, OU
- "só existe no payload" com a razão

## Assinatura para reancorar
32 bytes que sobrevivem a mudança de build.

## O que NÃO foi provado
Lista explícita.

## Contrato para o DeepSeek
- RVA do handler
- assinatura
- registradores na entrada (para eu montar a ABI)
- pré-condições observáveis (objetos/flags)
- se depende de estado de combate ativo
```

---

## Contexto do lado do DeepSeek (não precisa investigar)

| item | estado |
| --- | --- |
| ataque nativo | **funciona**, HP 100→53 e 100→77, sem foco |
| handler de attack | `exe+0x784be0`, ABI `(runtime, &shared_ptr, mode)` |
| control block | `criatura - 0x10`, validado 20/20 |
| telemetria | 16 criaturas, `ownPokemon`/`ownSummonId` |
| walk nativo | implementado (`exe+0x780c90`), aguardando teste |
| **combo** | **bloqueado — é o seu alvo** |

Não repito nada disso na sua tarefa. O que preciso de você é só o destino do
handler de combo, porque o dump do payload está fora do meu alcance (o `.pdata`
do exe é inválido: 71.433 de 71.459 entradas impossíveis — qualquer conclusão
baseada nele é nula).

---

## Critério de aceite

Seu documento passa se:

1. o fluxo `0x19b20..0x19bf1` estiver decodificado sem lacunas
2. o dword do destino estiver identificado **com a instrução que o lê**
3. o RVA do handler vier com prólogo em hex
4. existir assinatura de 32 bytes para reancorar
5. a seção "O que NÃO foi provado" não estiver vazia

Falha se: disser "provavelmente" sem instrução, ou apresentar endereço sem
verificar se o byte naquele local é código.
