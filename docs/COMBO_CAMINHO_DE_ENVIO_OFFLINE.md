# Combo: caminho da sequência montada até o próximo consumidor

Data: 2026-11-10. Continuação estática da tarefa 2, sem acesso ao cliente e sem mudanças em executores.

## Resultado utilizável

Na captura anterior do exe, o candidato 0x67fbf0 monta texto com prefixo `!autocombo ` e encaminha-o para **0x785050**, que repassa a string a **0x812240**. Há gates de sessão em ambos os níveis.

Isso identifica uma interface interna concreta de texto, mas NÃO comprova envio de rede, execução de skill, equivalência ao handler histórico do Shiba nem segurança para chamada própria. Não contornar gates ou substituir os campos globais.

Fontes: text.bin e rdata.bin indicados em COMBO_CANDIDATO_EXE_OFFLINE.md, capturados anteriormente. SHA256 da text conferido: cece83475ea5fa2a90c8ff5cbee190a658c2f4bce6119e26a25f55be9b2d3a78. Nenhum uso de .pdata. Endereços abaixo são RVAs dessa captura, não endereços atuais certificados.

## 1. Texto final

Após obter/normalizar os elementos, 0x6801ea inicia a montagem de string. Em 0x680425..0x680453:

```asm
680425 mov [rsp+0x38],rdi       ; tamanho da string
68042a mov [rsp+0x40],r13       ; capacidade
68042f movsd xmm0,[rip+...]     ; 0x201bf98: !autocombo<espaço>
680437 movsd [rbx],xmm0
68043b mov eax,[rip+...]        ; 0x201bf9f: últimos bytes do prefixo
680441 mov [rbx+7],eax
680444 lea rcx,[rbx+0xb]
680448 mov r8,rsi              ; tamanho do texto concatenado
68044b mov rdx,r14             ; origem do texto concatenado
68044e call 0x1934dd0
680453 mov byte [rbx+rdi],0
```

O espaço é parte do prefixo. No ramo exato `!autocombo`, a função anterior 0x40a920 preenche coleção de elementos; não foi estabelecido nesta rodada de onde vem cada configuração nem se configurações vazias são válidas.

## 2. Gates antes do encaminhamento

```text
680460 byte [exe+0x39cba98] != 0
680469 objeto = qword [exe+0x39cb958], não nulo
680475 byte [objeto+0xb0] > 0
68047e byte [exe+0x39cba9a] == 0
680487 rcx = qword [exe+0x39cb998], não nulo
680493 call 0x891600, AL != 0
68049c tamanho da string [rsp+0x38] != 0
```

Falha em qualquer condição converge para limpeza em 0x6804b6 sem essa chamada de envio. Não atribuir nomes de classes aos globais somente pelos offsets.

## 3. Chamada ao consumidor de texto

```asm
6804a4 lea r9,[rsp+0x28]    ; objeto string, não char*
6804a9 xor r8d,r8d         ; 0
6804ac mov edx,1           ; 1
6804b1 call 0x785050
```

RCX não é preparado novamente depois do helper 0x891600. O consumidor 0x785050 não depende do RCX de entrada no corpo observado: recarrega os objetos de globais. Isso NÃO é uma licença para inventar uma declaração C e chamá-lo fora do contexto.

Dentro de 0x785050:

```asm
785062 mov rdi,r9
785065 mov esi,r8d
785068 mov ebp,edx
...                       ; gates de sessão equivalentes
7850c2 cmp qword [r9+0x10],0
7850cd mov rax,[r10]
7850d0 xor r8d,r8d
7850d3 lea rdx,[rsp+0x60]
7850d8 mov rcx,r10
7850db mov rax,[rax+0x20]
7850df call qword [rip+...] ; slot em 0x1a3e820, alvo indireto não resolvido
...                       ; inicializa string local vazia
78510d mov [rsp+0x20],rdi  ; quinto argumento: string original
785112 lea r9,[rsp+0x40]   ; quarto argumento: string local vazia
785117 mov r8d,esi         ; terceiro argumento preservado, 0 neste caminho
78511a mov edx,ebp         ; segundo argumento preservado, 1 neste caminho
78511c mov rcx,rbx         ; objeto obtido de [exe+0x39cb998]
78511f call 0x812240
```

Após retorno há destruição da string local e retorno sem status explícito. A string original é liberada pelo chamador depois que 0x785050 retorna. Isso demonstra o lifetime local no caminho original, mas não estabelece se todos os consumidores copiam conteúdo ou retêm ponteiros.

## 4. Limite real da captura

0x812240 começa com manipulação de pilha/flags e constantes extensas, seguida de call 0x4304e8a em 0x81226c. O padrão é compatível com código ofuscado. Não interpretar a desmontagem linear subsequente como fluxo de alto nível certificado.

A captura text.bin cobre [0x1000,0x1a3c00c). **0x4304e8a não estava nessa captura.** Isso não significa que o endereço esteja fora da imagem inteira do jogo. A continuação não pode ser fechada com os intervalos de text/rdata usados aqui.

Não houve tentativa de leitura remota, dump adicional, emulação ou desvio da proteção. Não é necessário reinventar um protocolo de rede com base nesses dados.

## 5. Assinaturas de 32 bytes

0x785050 — uma ocorrência exata na captura text.bin:

```text
48 89 5c 24 08 48 89 6c 24 18 56 57 41 56 48 83
ec 70 49 8b f9 41 8b f0 8b ea 80 3d 27 6a 24 03
```

0x812240 — uma ocorrência exata na mesma captura:

```text
41 56 49 be b9 02 17 25 37 2b 32 b8 41 55 9c 49
bd b1 46 be f8 89 b4 86 52 4c 8b 74 24 10 48 c7
```

Unicidade é local à captura. Não garante estabilidade entre builds nem segurança de chamada. A assinatura do consumidor contém deslocamento RIP-relative.

## 6. Handoff e condição de integração

DeepSeek pode reaproveitar o mapa para distinguir chamada de texto e simulação de chat. Não deve chamar 0x785050/0x67fbf0 apenas porque temos prólogo e argumentos parciais.

Pendências antes de integrar: instância/build atuais, contexto de execução, ownership e ABI completa da string, serialização/cancelamento do executor e confirmação de efeito. Uma chamada normal retornando não confirma skill ou sucesso no servidor.

Não precisamos abrir uma investigação ampla agora: o contrato local de 0x67fbf0 -> 0x785050 está identificado e a fronteira seguinte está localizada. A tarefa de movimento e o problema de timeout/fallback continuam com OpenCode. Nenhuma alteração no código dele foi feita.
