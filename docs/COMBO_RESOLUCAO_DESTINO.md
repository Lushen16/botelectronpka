# Combo: resolução do destino do Shiba

## Veredito

**Resolvida a seleção do destino no dump histórico; NÃO resolvido o endereço executável no cliente atual. Não usar os RVAs históricos como autorização para chamada.**

Análise estática em 2026-11-10. Nenhum processo aberto, nenhuma injeção, reinício ou chamada no jogo. Nenhum arquivo de native/, tools/, botfinal/ ou reconstruction/ alterado.

Artefato principal: dumps/payload_reconstructed.dll, 3.293.184 bytes (0x324000), SHA256 0fce980b4d478e21ef751e1cce9d40b22220a4014d83711818cf4796887e8a70, conferido.
Correção do enunciado: este arquivo tem cabeçalho MZ/PE reconstruído; SizeOfImage=0x328000. Nos intervalos citados, RVA e offset físico coincidem (verificado por pefile), mas isso não é regra geral. Não usei .pdata para limites.

Resultado inequívoco:
- d0 é comparado com o DWORD inicial do descritor.
- Havendo correspondência, **0x19b97: add rax,4** seleciona d1.
- **0x19bc3: mov eax,[rax]** lê d1 nessa rota, não d0.
- **0x19bc5** guarda o RVA selecionado em payload+0x22371c; esse DWORD NÃO é o ponteiro chamado.
- **0x19bce: call 0x16010** resolve novamente descritor/perfil e devolve o endereço completo.
- No resolvedor, **0x16077: lea rcx,[rax+4]**, **0x1607b: mov eax,[rcx]**, **0x1607d: add rax,[payload+0x223720]** produzem base externa + d1.
- **0x19bf1: call rax** chama esse resultado.

Para o descritor payload+0xe2ea8:
| Perfil em +0x223768 | Seleção | RVA externo |
|---|---|---|
| 3 | tabela 0xe35a0, entrada 7 em 0xe3680 | 0x6325b0 |
| 2 | tabela 0xe3220, entrada 9 em 0xe3340 | 0x63a0e0 |
| demais / sem correspondência | DWORD do próprio descritor | 0x639ba0 |

Estado salvo no dump: perfil=3; base em +0x223720=0x7ff6e3290000; flags +0x22319e=1 e +0x22319f=0. Aplicando esses dados, destino histórico calculado=0x7ff6e38c25b0. Isso NÃO comprova execução nem bytes naquele VA.

**0x6325b0 > 0x328000 > 0x324000.** Portanto não está dentro do payload, ao contrário do enunciado. Seu corpo completo **não estava no dump** fornecido. B e C não podem ser certificados como solicitados usando apenas esse arquivo.

## Fluxo do despachante (instrução por instrução)

Desmontagem Capstone x86-64 contígua a partir de 0x19b20. Os endereços 0x19b83, 0x19b8b, 0x19bc6, 0x19bcf e 0x19bea do enunciado não são os endereços corretos das instruções descritas neste hash.

```asm
00019b20  4053                     push rbx
00019b22  56                       push rsi
00019b23  57                       push rdi
00019b24  4156                     push r14
00019b26  4883ec48                 sub rsp, 0x48
00019b2a  4d8bd9                   mov r11, r9
00019b2d  498bf0                   mov rsi, r8
00019b30  4c8bf2                   mov r14, rdx
00019b33  4c8bd1                   mov r10, rcx
00019b36  488b9c24a0000000         mov rbx, qword ptr [rsp + 0xa0]
00019b3e  4885db                   test rbx, rbx
00019b41  7403                     je 0x19b46
00019b43  c60300                   mov byte ptr [rbx], 0
00019b46  803d5196200000           cmp byte ptr [rip + 0x209651], 0
00019b4d  0f84c8000000             je 0x19c1b
00019b53  803d4596200000           cmp byte ptr [rip + 0x209645], 0
00019b5a  0f85bb000000             jne 0x19c1b
00019b60  8b3db69b2000             mov edi, dword ptr [rip + 0x209bb6]
00019b66  89bc24a0000000           mov dword ptr [rsp + 0xa0], edi
00019b6d  8b15f59b2000             mov edx, dword ptr [rip + 0x209bf5]
00019b73  83fa03                   cmp edx, 3
00019b76  7525                     jne 0x19b9d
00019b78  488d05219a0c00           lea rax, [rip + 0xc9a21]
00019b7f  8b09                     mov ecx, dword ptr [rcx]
00019b81  4c8d05989d0c00           lea r8, [rip + 0xc9d98]
00019b88  3908                     cmp dword ptr [rax], ecx
00019b8a  740b                     je 0x19b97
00019b8c  4883c020                 add rax, 0x20
00019b90  493bc0                   cmp rax, r8
00019b93  75f3                     jne 0x19b88
00019b95  eb06                     jmp 0x19b9d
00019b97  4883c004                 add rax, 4
00019b9b  eb26                     jmp 0x19bc3
00019b9d  83fa02                   cmp edx, 2
00019ba0  751e                     jne 0x19bc0
00019ba2  488d0577960c00           lea rax, [rip + 0xc9677]
00019ba9  418b0a                   mov ecx, dword ptr [r10]
00019bac  488d15ed990c00           lea rdx, [rip + 0xc99ed]
00019bb3  3908                     cmp dword ptr [rax], ecx
00019bb5  74e0                     je 0x19b97
00019bb7  4883c020                 add rax, 0x20
00019bbb  483bc2                   cmp rax, rdx
00019bbe  75f3                     jne 0x19bb3
00019bc0  498bc2                   mov rax, r10
00019bc3  8b00                     mov eax, dword ptr [rax]
00019bc5  8905519b2000             mov dword ptr [rip + 0x209b51], eax
00019bcb  498bca                   mov rcx, r10
00019bce  e83dc4ffff               call 0x16010
00019bd3  488b8c2498000000         mov rcx, qword ptr [rsp + 0x98]
00019bdb  48894c2420               mov qword ptr [rsp + 0x20], rcx
00019be0  4c8b8c2490000000         mov r9, qword ptr [rsp + 0x90]
00019be8  4d8bc3                   mov r8, r11
00019beb  488bd6                   mov rdx, rsi
00019bee  498bce                   mov rcx, r14
00019bf1  ffd0                     call rax
00019bf3  4885db                   test rbx, rbx
00019bf6  7403                     je 0x19bfb
00019bf8  c60301                   mov byte ptr [rbx], 1
00019bfb  893d1b9b2000             mov dword ptr [rip + 0x209b1b], edi
00019c01  eb1a                     jmp 0x19c1d
00019c03  c6059595200001           mov byte ptr [rip + 0x209595], 1
00019c0a  8b8424a0000000           mov eax, dword ptr [rsp + 0xa0]
00019c11  8905059b2000             mov dword ptr [rip + 0x209b05], eax
00019c17  33c0                     xor eax, eax
00019c19  eb02                     jmp 0x19c1d
00019c1b  33c0                     xor eax, eax
00019c1d  4883c448                 add rsp, 0x48
00019c21  415e                     pop r14
00019c23  5f                       pop rdi
00019c24  5e                       pop rsi
00019c25  5b                       pop rbx
00019c26  c3                       ret 
```

### Origem dos registradores e pilha

Sejam D=RCX de entrada (descritor), A1=RDX, A2=R8, A3=R9. RSP de entrada=S.
Após quatro pushes e sub rsp,0x48, RSP=S-0x68.
- R10=D, R14=A1, RSI=A2, R11=A3.
- RBX=[S+0x38], argumento 7: ponteiro opcional de flag de conclusão, zerado antes dos gates.
- [rsp+0x90]=[S+0x28], argumento 5.
- [rsp+0x98]=[S+0x30], argumento 6.
- EDI recebe o DWORD anterior de +0x22371c, também salvo em [rsp+0xa0] após RBX já ter recebido o ponteiro.
- EDX recebe perfil de +0x223768, e ECX recebe a chave DWORD de D nas buscas.
- Perfil 3: busca [0xe35a0,0xe3920), stride 0x20. Perfil 2: [0xe3220,0xe35a0), stride 0x20.
- Match: RAX passa a apontar para entrada+4. Sem match: RAX=D.
- Depois da leitura, EAX contém RVA selecionado (a escrita em EAX zera a metade alta de RAX).
- 0x19bcb restaura RCX=D antes de chamar o resolvedor.
- O corpo verificado de 0x16010 não modifica R11; assim A3 sobrevive nesse caminho concreto, embora R11 seja volátil pela ABI geral.
- Na chamada final: RCX=A1, RDX=A2, R8=A3, R9=argumento 5, [rsp+0x20]=argumento 6.
- Após retorno normal, flag opcional vira 1 e +0x22371c é restaurado de EDI. Não há validação semântica do efeito no jogo.
- 0x19c03 é bloco separado que marca +0x22319f=1 e restaura o DWORD salvo; não há salto direto para ele no fluxo normal listado. Seu vínculo com tratamento de exceção não foi reconstruído.

O global +0x22371c guarda temporariamente **o RVA selecionado**, não a chave original quando houve remapeamento, nem o retorno da função. Seu uso além de guardar/restaurar não foi estabelecido.

### Resolvedor 0x16010, completo

```asm
00016010  8b0552d72000             mov eax, dword ptr [rip + 0x20d752]
00016016  83f803                   cmp eax, 3
00016019  752c                     jne 0x16047
0001601b  8b11                     mov edx, dword ptr [rcx]
0001601d  488d057cd50c00           lea rax, [rip + 0xcd57c]
00016024  4c8d05f5d80c00           lea r8, [rip + 0xcd8f5]
0001602b  0f1f440000               nop dword ptr [rax + rax]
00016030  3910                     cmp dword ptr [rax], edx
00016032  7443                     je 0x16077
00016034  4883c020                 add rax, 0x20
00016038  493bc0                   cmp rax, r8
0001603b  75f3                     jne 0x16030
0001603d  8b01                     mov eax, dword ptr [rcx]
0001603f  480305dad62000           add rax, qword ptr [rip + 0x20d6da]
00016046  c3                       ret 
00016047  83f802                   cmp eax, 2
0001604a  752f                     jne 0x1607b
0001604c  8b11                     mov edx, dword ptr [rcx]
0001604e  488d05cbd10c00           lea rax, [rip + 0xcd1cb]
00016055  4c8d0544d50c00           lea r8, [rip + 0xcd544]
0001605c  0f1f4000                 nop dword ptr [rax]
00016060  3910                     cmp dword ptr [rax], edx
00016062  7413                     je 0x16077
00016064  4883c020                 add rax, 0x20
00016068  493bc0                   cmp rax, r8
0001606b  75f3                     jne 0x16060
0001606d  8b01                     mov eax, dword ptr [rcx]
0001606f  480305aad62000           add rax, qword ptr [rip + 0x20d6aa]
00016076  c3                       ret 
00016077  488d4804                 lea rcx, [rax + 4]
0001607b  8b01                     mov eax, dword ptr [rcx]
0001607d  4803059cd62000           add rax, qword ptr [rip + 0x20d69c]
00016084  c3                       ret 
```

Ele lê o perfil novamente. A equivalência entre o RVA registrado pelo despachante e o endereço chamado pressupõe que perfil/base/tabelas não mudem entre as duas leituras. Não há sincronização visível nesses dois trechos.

## Handler (RVA, prólogo hex, evidência do tratamento de vírgula)

É preciso separar **parser dentro do payload** de **destino externo chamado para o comando sem argumentos**.

### Comando exato !autocombo

Em 0x10fe2: cmp rbx,0xa (10 bytes), e não comparação com 11 em 0x10fe5.
Em 0x10feb: referência à string 0xe4678; comparação chamada em 0x10ff2.
Campos [rdi+0x10] e [rdi+0x14] devem ser zero nessa rota imediata; caso contrário, o fluxo vai a 0x11037, que escreve 1 em +0x21e044 e não faz essa chamada imediata.
Em 0x11022: descritor 0xe2ea8; em 0x11029: call 0x19b20.

Descritor completo de 32 bytes:
```
a0 9b 63 00 40 55 53 56 57 41 54 41 55 41 56 41
57 48 8d 6c 24 e1 48 81 ec f8 00 00 00 00 00 00
```
Primeiros quatro bytes são chave/RVA de referência, NÃO instrução do handler.
A entrada 7 contém:
```
a0 9b 63 00 b0 25 63 00 40 55 53 56 57 41 54 41
55 41 56 41 57 48 8d 6c 24 e1 48 81 ec f8 00 00
```
Os 24 bytes finais são uma sequência compatível com prólogo, não o corpo no destino:
```asm
push rbp; push rbx; push rsi; push rdi
push r12; push r13; push r14; push r15
lea rbp,[rsp-0x1f]
sub rsp,0xf8  ; último byte da instrução requer byte seguinte
```
No descritor base há um byte adicional zero que completa sub rsp,0xf8. Não interpretar o restante/padding como 32 bytes consecutivos obtidos do destino histórico.

### Parser de argumentos dentro do payload: 0x19ca0

Aqui existem bytes de código e prólogo verificáveis:
```
40 55 53 56 57 41 54 41 55 41 56 41 57 48 8d 6c
24 e1 48 81 ec 88 00 00 00 4c 8b e1 c7 45 67 00
```

- 0x19cb9: R12=RCX, objeto de string de entrada.
- 0x19cc3: compara capacidade em +0x18 com 0xf; escolhe armazenamento inline ou ponteiro.
- 0x19cd2: cmp qword [rcx+0x10],0xb; 0x19cd7 rejeita comprimento menor que 11.
- 0x19ce9: referência a 0xe4650, "!autocombo " com espaço.
- 0x19cf6: chamada de busca/comparação; 0x19cfb..0x19d07 exige correspondência no começo.
- 0x19db8: RCX=&texto[indice]; 0x19dbc: mov r8b,0x2c; 0x19dc2: call 0xd5c10.
- O retorno delimita token; subtração em 0x19dcf e cálculo de comprimento em 0x19dd8..0x19ddb alimentam a extração subsequente.
- O chamador em 0x1104e chama 0x19ca0 na rota alternativa; isso NÃO prova que o destino externo 0x6325b0 contém esse parser.

Portanto a exigência de provar vírgula dentro de payload+0x6325b0 mistura dois endereços/módulos. A vírgula foi encontrada no parser 0x19ca0; o destino externo continua sem corpo disponível neste dump.

## Onde vive no build atual (RVA no exe OU "só existe no payload" + razão)

**Destino externo selecionado: não reancorado no build atual.**
Não é correto afirmar "só existe no payload": o resolvedor soma uma base externa capturada a um RVA.
Também não é correto afirmar que 0x6325b0 é o RVA do cliente atual.

Não acessei a memória do cliente em base 0x7ff65a1d0000: a regra de análise exclusivamente estática prevalece sobre o pedido de busca ao vivo. Isso é limite de escopo, não falha de acesso comprovada.

Como conferência suplementar, consultei uma captura offline preexistente fora do repo:
C:/Users/yago/.t3/scratch/2026-11-05-you-are-silas-a-shadow-0ec3ee10/shiba-walk-audit/binding-live-20261109/text.bin.
Nenhuma nova coleta foi feita. Ela não é prova do estado atual e não integra o aceite solicitado sobre artefatos do repo.
O prefixo de 24 bytes da entrada apareceu em múltiplos locais, inclusive 0x67fbf0; portanto não identifica sozinho o destino. Não promovo nenhum desses locais a handler confirmado.

## Assinatura para reancorar (32 bytes)

**32 bytes do handler externo histórico: não estavam no dump.** Há apenas a sequência curta incorporada nos metadados. Não completar com zeros, bytes da próxima entrada ou bytes de outro candidato.

Assinatura exata de 32 bytes do parser do payload 0x19ca0 (NÃO usar como assinatura do destino do exe):
```
40 55 53 56 57 41 54 41 55 41 56 41 57 48 8d 6c
24 e1 48 81 ec 88 00 00 00 4c 8b e1 c7 45 67 00
```

Assinatura exata de 32 bytes do resolvedor do payload 0x16010:
```
8b 05 52 d7 20 00 83 f8 03 75 2c 8b 11 48 8d 05
7c d5 0c 00 4c 8d 05 f5 d8 0c 00 0f 1f 44 00 00
```
São assinaturas desta captura, com deslocamentos RIP relativos; não prometem estabilidade entre builds.

## O que NÃO foi provado

- Corpo e 32 bytes de entrada do destino externo histórico 0x6325b0: **não estavam no dump**.
- Correspondência desse destino com uma função do exe atual.
- Identidade do módulo da base +0x223720 por inventário de módulos da captura; o fluxo prova soma de base externa, não o nome do módulo.
- Tipos completos, construtores e lifetime dos argumentos do destino externo.
- Thread correta, agendamento, reentrância, segurança, efeito e funcionamento sem foco.
- Independência de estado de combate; o despachante tem gates e o chamador tem campos condicionais.
- Significado de sucesso do jogo: a flag escrita após call rax indica retorno normal pelo wrapper, não efeito confirmado.
- Validade global das tabelas de unwind. Nenhuma conclusão dependeu delas.

## Contrato para o DeepSeek (RVA, assinatura, registradores na entrada, pré-condições, se depende de estado de combate)

**Resultado utilizável agora: resolução estática por perfil, não função liberada para chamar.**

1. Descritor: payload+0xe2ea8, chave 0x639ba0.
2. Perfil 3: RVA externo 0x6325b0; perfil 2: 0x63a0e0; fallback: 0x639ba0.
3. Endereço = QWORD[payload+0x223720] + RVA selecionado por 0x16010.
4. No ramo exato 0x11029: destino recebe RCX=&local[rbp-0x10], RDX=0, R8=0. R9 e quinto argumento vêm de R13 pelos argumentos de pilha do wrapper; o valor de R13 não foi rastreado nesta análise. Não presumir RCX=runtime/LocalPlayer nem completar ABI.
5. Pré-condições visíveis: flag +0x22319e não zero; +0x22319f zero; perfil/base coerentes; campos condicionais do chamador satisfeitos. Condições internas do handler desconhecidas.
6. Assinatura do handler externo: indisponível. As assinaturas acima pertencem ao parser/resolvedor do payload.
7. Dependência de combate: não determinada. Não inferir ausência a partir do texto "!autocombo".
8. Próximo dado necessário: dump offline do módulo externo correspondente à captura histórica, ou artefato do build atual com candidato validado por corpo/callers. Uma correspondência de prólogo isolada é insuficiente.
9. Não chamar 0x6325b0 no cliente atual com base nesta nota; não reutilizar os três RVAs por delta presumido.

Aceite: **A fechado; B fechado apenas quanto à separação parser/destino; C e assinatura externa pendentes por ausência de bytes.** Não declarar o destino atual resolvido.

