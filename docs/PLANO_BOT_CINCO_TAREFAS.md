# Entrega do bot em cinco tarefas

Data: 2026-11-10. Plano de execução e revisão inicial, não declaração de bot concluído.

## Objetivo e fronteira

Entregar uma rota curta com movimento, seleção de alvo e combo, com outra janela em primeiro plano, sem roubar foco. Minimizando é critério separado. Preservar os motores existentes, pendingStep e protocolo; não reconstruir tudo do zero.

DeepSeek continua dono de native/, tools/, motores e intervenções no cliente. GPT faz análise offline e revisão somente leitura; entrega documentos em docs/. Qualquer mudança nessa propriedade deve ser combinada antes. Não executar validadores gerais enquanto outro agente usa o cliente sem verificar os efeitos desses scripts.

Estado consultado no T3: OpenCode executando game-loop.cjs --test probe após encontrar o jogo fechado. Nenhum resultado novo de movimento constava na atividade disponível. Leituras/ataque sem foco são resultados relatados pelo DeepSeek; não foram repetidos pelo GPT. Combo por WM_CHAR está implementado, mas não há evidência nova de efeito ou de background.

## 1. Consolidar contrato e evidências — levantamento inicial concluído

Responsável: GPT; DeepSeek confirma artefato carregado no próximo teste.

Entrega: inventário por capacidade, build/hash, versão da DLL carregada, transporte, thread, efeito e limitações. Separar fatos do dump histórico, código atual e execução medida. Documentos antigos contêm RVAs e conclusões contraditórias: não usá-los como autorização de chamada.

Aceite: cada afirmação de funcionamento aponta para resultado do cliente; cada função a chamar tem assinatura/ABI e build identificados. Nenhuma suposição de PID ou base persistente.

Feito nesta rodada: atividade consultada; código atual de walk/telemetria e chamadas dos motores lido. Não há resultado novo de teste vivo a acrescentar.

## 2. Fechar contrato do combo nativo — em andamento

Responsável: GPT, somente offline. DeepSeek implementa após contrato validado.

Reutilizar COMBO_RESOLUCAO_DESTINO.md e COMBO_CANDIDATO_EXE_OFFLINE.md. O resolvedor histórico soma base externa ao RVA por perfil. Candidato no exe capturado: 0x67fbf0, assinatura32 única naquela captura, compara !autocombo e trata argumentos com vírgula.

Próximo trabalho: validar origem/lifetime da string, caminhos de envio e condições de execução; verificar se configura, ativa ou envia a sequência. Não equiparar presença de string a efeito completo. Preservar a opção simples de usar a sequência configurada no jogo.

Aceite: assinatura e corpo correlacionados, ABI descrita, ownership/alocador e contexto definidos, retorno interpretado apenas se o caller o consumir. Endereço histórico não vira automaticamente endereço atual.

Início concreto desta rodada: chamada em 0x4439b4 confirmada por instruções alinhadas; RCX=RSI aponta para objeto consumido como string. Caller salta após a chamada, sem testar EAX/AL. Epílogo em 0x6805d1..0x6805f0 não prepara status explícito. Isso impede tratar retorno não zero como sucesso sem evidência adicional.

## 3. Corrigir ciclo de execução e vida útil — prioridade de segurança

Responsável: DeepSeek implementa; GPT revisa snapshots sem editar native/.

Achados no código lido nesta rodada:

- native/pka_native.c:1999 marca done antes de fn; done significa início/claim, não conclusão.
- run_in_game_thread, aproximadamente 2051..2080: após detectar done espera no máximo 100*5ms por result. Pode retornar falso enquanto a função ainda executa.
- execute_command, aproximadamente 2127..2134: retorno falso leva ao teclado. Chamada nativa tardia mais teclado pode produzir duas ações. Novo pedido pode sobrescrever estado global ainda em uso pelo anterior.
- game_call_hook não correlaciona pedido com mensagem/token específico; qualquer callback elegível pode executar o slot pendente.
- Thread dona da janela é a thread do hook, não prova suficiente de que todo estado de jogo é seguro nesse ponto, nem de ausência de reentrância.
- resolve_creature_cbs identifica candidatos por layout, mas leitura/validação não garante vida útil até a chamada. Se cbVtCache for zero, a condição atual não exige vtable correspondente; revisar política fail-closed.

Correção a desenhar antes de teste amplo: identidade de pedido, serialização, estados QUEUED/RUNNING/COMPLETED/CANCELLED/INDETERMINATE, publicação ordenada do resultado e slot não reutilizado enquanto em voo. Timeout de RUNNING não autoriza fallback nem retentativa. Cancelamento deve disputar atomicamente com claim; timeout não é cancelamento confirmado. Não exigir esse nome exato de estados, mas preservar essas distinções.

WH_CALLWNDPROC e PostMessage(WM_NULL) precisam de confirmação de entrega/execução no mecanismo escolhido; contar PostMessage aceito não comprova callback. Não substituir cegamente por outra API durante teste. A callback também não deve ser removida/descarregada enquanto estiver em voo.

Aceite: teste auxiliar focal que atrasa callback comprova uma execução, nenhum fallback após início e nenhum reaproveitamento de slot em voo; interrupção/saída do mundo não deixa operação tardia. Vida útil da criatura obtida por ownership coerente, não somente refcount igual antes/depois.

## 4. Integrar motores sem duplicação — após primitivas válidas

Responsável: DeepSeek; GPT revisa contrato e evidências.

Preservar pendingStep: um comando de movimento pendente por vez. Combate e Walker devem compartilhar arbitragem de movimento, sessão e ordem. ACK de transporte não limpa pendingStep como se fosse movimento concluído. Reconciliar com amostra nova, posição prevista e timeout explícito.

Combo: emitir uma vez conforme estado/cooldown, não em todo tick. Diferenciar comando aceito, execução iniciada, efeito observado e fim de sequência. Não declarar sequência completa só por ACK ou desaparecimento do alvo. Telemetria stale/identidade trocada bloqueia novas ações. Não misturar caminho native e teclado silenciosamente.

Aceite: testes locais com transporte simulado comprovam supressão de duplicados, amostra stale, conflito Walker/combate, desconexão, erro e resultado indeterminado. Testes simulados não certificam efeito no jogo.

## 5. Validar ponta a ponta e empacotar — última etapa

Responsável: DeepSeek controla cliente; GPT confere log e critérios.

Ordem mínima:
1. Um comando, um tile na direção exata, mesmo andar, sem passo extra posterior; registrar executor efetivo para não confundir fallback com nativo.
2. Repetir com outra janela à frente; não alterar foco para fazer passar.
3. Um ataque controlado com alvo identificável e contexto registrado; não atribuir todo dano ambiental ao bot.
4. Um autocombo com efeito observável específico; não confundir configuração com disparo.
5. Rota curta integrando pausa para combate e retomada, com cancelamento explícito pelo usuário.

Minimizado é ensaio separado apenas depois dos anteriores. Sem loop de repetição ilimitado; falha sem nova hipótese não autoriza repetir. Congelar hashes das fontes/binários testados, guardar JSON/logs com timestamps, instância, posição, TID, executor, pedido e resultado.

Aceite final: capacidades declaradas correspondem ao que foi demonstrado; limitações visíveis na UI; parada confiável; nenhuma DLL concorrente ou teste automático esquecido. Se uma capacidade falhar, ela permanece desabilitada em vez de apresentar sucesso nominal.

## Ordem efetiva e paralelismo

1 estabelece base comum. 2 (combo offline) e 3 (executor) podem progredir em paralelo sem arquivos compartilhados. 4 depende das primitivas relevantes e do ciclo de vida correto; 5 depende de 4. Movimento permanece requisito prioritário; combo não bloqueia a correção do walk.

Não contratar cinco agentes para escrever ao mesmo tempo no mesmo repo. As cinco tarefas são entregas com responsáveis e dependências, não cinco controladores do jogo.

## Ponto de parada desta rodada

GPT entregou plano e revisão inicial, e avançou a tarefa 2. Problema de timeout/fallback enviado diretamente ao OpenCode. Tarefas 2..5 não estão concluídas. Nenhum teste no cliente foi executado pelo GPT.
