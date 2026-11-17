# Combo: candidato no executável capturado, sem intervenção no cliente

Data: 2026-11-10. Complementa COMBO_RESOLUCAO_DESTINO.md; não substitui a distinção entre destino histórico e build atual.

## Resultado

O RVA **0x67fbf0** na captura offline do exe contém um caminho que compara o comando exato `!autocombo`, e outro que processa a parte posterior aos primeiros 11 bytes usando vírgula como delimitador. Isso é evidência do corpo, não apenas de prólogo.

**Não foi provado que é o equivalente histórico de 0x6325b0, que a captura ainda representa o processo atual, nem que seja seguro chamá-lo diretamente.** Não é uma autorização de execução.

## Proveniência

Capturas preexistentes, consultadas apenas em disco:

- Raiz: C:/Users/yago/.t3/scratch/2026-11-05-you-are-silas-a-shadow-0ec3ee10/shiba-walk-audit/
- binding-live-20261109/text.bin: RVA inicial 0x1000; SHA256 cece83475ea5fa2a90c8ff5cbee190a658c2f4bce6119e26a25f55be9b2d3a78, registrado no manifesto da captura.
- binding-tables-20261109/rdata.bin: RVA inicial 0x1a3d000; SHA256 recalculado dbd7c637ca7e865ad37494af51c3371e8220854c5100f4751f24fb12f4e32c81.
- capture.json da primeira captura: PID histórico 19400; hash do exe em disco 48c41bd4422842e7a73890c4e65fc0714beb80c191ca274612a86ebe27b0ac2b. Hash de disco não certifica identidade de toda a imagem em memória.

São arquivos fora do repo já produzidos anteriormente nesta investigação; a extensão de análise deste turno usou esses arquivos sem coletar dados novos. Nenhum acesso ao jogo vivo, injeção ou leitura de memória remota.

## Evidência discriminante

Desmontagem contígua a partir do prólogo em 0x67fbf0, sem .pdata:

| RVA | Instrução / observação |
|---|---|
| 0x67fc17 | mov rbx,rcx: preserva argumento de entrada |
| 0x67fc3e | mov r8,[rcx+0x10]: comprimento |
| 0x67fc42 | cmp qword [rcx+0x18],0xf: seleção de armazenamento inline/heap |
| 0x67fc49 | mov rcx,[rcx] no ramo heap |
| 0x67fc61 | cmp r8,0xa: comprimento 10 |
| 0x67fc6b | lea rdx,[rip+0x19928ee]: exe+0x2012560 |
| 0x2012560 | bytes de string `!autocombo\0`, conferidos em rdata.bin |
| 0x67fc72 | call 0x1934e00; test eax,eax em 0x67fc77 |
| 0x67fc84 | ramo de igualdade chama 0x40a920 com RCX=&local |
| 0x67fd38 | se coleção resultante vazia, salta para 0x680556 |
| 0x67fd43 | caso não vazio, call 0x785c40 com EDX=1 |
| 0x67fd63 | prepara comprimento 11 |
| 0x67fd71 | lê 8 bytes em 0x201bf98: início de `!autocombo ` |
| 0x67fd7f | lê DWORD em 0x201bf9f: completa texto com espaço |
| 0x67fda1 | verifica comprimento de entrada contra 11 |
| 0x67fdce | calcula endereço do texto após 11 bytes |
| 0x67feb4 | lê WORD em 0x1fbf448: bytes 2c 00 (vírgula) |
| 0x67fec4..0x67fed1 | passa string delimitadora, substring e local de saída para 0x8be660 |
| 0x67ff23..0x67ff32 | obtém limites da coleção produzida e testa vazio |

O comportamento completo das funções chamadas não foi reconstruído. Não confundir leitura da string de prefixo com prova de que todos os ramos validam o prefixo antes de executar; o fluxo interno ainda requer revisão integral.

## Assinatura exata de 32 bytes

RVA 0x67fbf0 da captura:

```text
40 55 53 56 57 41 54 41 55 41 56 41 57 48 8d 6c
24 e1 48 81 ec f8 00 00 00 48 8b 05 30 44 bf 01
```

Busca exata: **1 ocorrência em text.bin**. Os 24 bytes iniciais isolados aparecem em muitas funções e não são identificador suficiente. A assinatura de 32 inclui deslocamento RIP-relative; não prometer estabilidade entre builds. Unicidade nesta captura não prova equivalência entre versões.

## Chamadores

Busca de E8+rel32 encontra candidatos em 0x4439b4 e 0x5f2e30. A primeira chamada está no trecho já observado que compara `!autocombo` e passa RCX=RSI. A segunda ainda exige validar fronteiras e origem dos argumentos; uma coincidência E8 isolada não é chamada confirmada.

## Contrato parcial e próximo passo

- RCX é consumido como objeto com layout compatível com std::string MSVC x64 (tamanho +0x10, capacidade +0x18), **não como runtime ou LocalPlayer**.
- O prólogo corresponde aos 24 bytes incorporados na tabela histórica; essa correspondência somada ao corpo torna 0x67fbf0 candidato forte, não equivalência histórica certificada.
- Não foram estabelecidos lifetime, alocador, retorno, contexto de thread, reentrância nem efeito sem foco.
- DeepSeek continua dono exclusivo do cliente/native. Não alterar executor de walk para testar este endereço por tentativa.
- Continuação estática útil: validar o chamador em 0x4439b4 e a construção da string; separar configuração/ativação da sequência de envio de cada skill. Só depois definir teste isolado com precondições explícitas.

## Não foi feito

Nenhum teste de combo, nenhuma escrita em memória, nenhuma execução de DLL, nenhuma alteração em native/, tools/, botfinal/ ou reconstruction/. A descoberta não muda o status do teste de walk do outro agente.

## Continuação: chamador e retorno (2026-11-10)

SHA256 de text.bin recalculado e igual ao manifesto: cece83475ea5fa2a90c8ff5cbee190a658c2f4bce6119e26a25f55be9b2d3a78.

Desmontagem alinhada do chamador:

```asm
44399b lea rdx,[rip+0x1bcebbe] ; 0x2012560, !autocombo
4439a2 call 0x1934e00
4439a7 test eax,eax
4439a9 jne 0x4439be
4439ab cmp r13,0xa
4439af jb 0x4439be
4439b1 mov rcx,rsi
4439b4 call 0x67fbf0
4439b9 jmp 0x444da1
```

Isso confirma o call-site, não a construção original de RSI. Tentativa inicial de desmontar a partir de 0x44397f começou no meio de instrução e foi descartada; nenhuma conclusão deriva dessa tentativa.

No candidato, o caminho de comando exato produz uma coleção, chama 0x785c40 quando não vazia e converge em 0x6801ea. A partir dali concatena elementos e prepara comprimento adicional 11 em 0x6803b7/0x6803e1. O separador de elementos em 0x1fbce58 contém `, `. O destino final dessa montagem e seu efeito ainda não foram fechados.

Epílogo normal observado:

```asm
6805d1 mov rcx,[rbp+0xf]
6805d5 xor rcx,rsp
6805d8 call 0xa151f0
6805dd add rsp,0xf8
6805e4 pop r15
6805e6 pop r14
6805e8 pop r13
6805ea pop r12
6805ec pop rdi
6805ed pop rsi
6805ee pop rbx
6805ef pop rbp
6805f0 ret
```

**Não usar EAX/AL como bool de sucesso:** esse caller não consome retorno e o epílogo não estabelece um status explícito. Compatível com retorno void, mas a declaração original não foi recuperada. Ainda falta contrato de ownership da string e contexto de execução; não chamar diretamente a partir desta evidência.
