# Revisao independente - 2026-11-11

Escopo: codigo e artefatos existentes; testes offline. Nenhuma injecao, leitura de memoria do cliente, movimento ou reinicio. Nenhum arquivo de implementacao alterado.

## Veredito e testes

Ha progresso no lure, arbitragem e instrumentacao nativa. Ainda nao comprova bot integrado confiavel sem foco ou equivalencia com o Shiba.

Executado: node --test botfinal/tests/dynamic_lure.test.cjs botfinal/tests/arbiter.test.cjs botfinal/tests/shiba_state_adapter.test.cjs

Resultado: 30/30 aprovados. Testes de logica, nao de efeito no jogo.

## Prioridade alta: hold nao chega ao walker

CombatEngine.isRepositioning salva a decisao em lastLure. BotRuntime.runState, ramo LURING, chama walker.tick sem consultar hold, adjust-step ou walk-route.

Reproducao offline com combat.lastLure={phase:'stationary',action:'hold'} e walker falso: runState(LURING) chamou walker.tick uma vez. Prova a chamada ao motor, nao deslocamento fisico: o walker pode recusar por outras condicoes.

Proximo teste de integracao: hold produz zero chamadas ao walker/dispatcher; ajuste e rota possuem caminhos distintos. Revisar tambem o timeout de formacao: phaseSince muda a cada troca de fase.

## Evidencia: consistencia interna nao prova parada fisica

analysis/lure-stop-rule/transition-eval.json registra zero frames comparaveis e reproduces:false. O acordo historico de 97,9% nao foi reproduzido nessa avaliacao.

analysis/lure-stop-rule/scan-pka_tap_17748.json registra 33.577 frames de lure, 12.064 kind5 com posicao, zero frames de lure cobertos por posicao recente e zero kind5 com selvagens no intervalo filtrado.

Isso demonstra falta de cobertura nesse conjunto. Nao prova que posicao nunca sera publicada em execucao. Explicacoes como runtime ocupado ou decisao de design permanecem hipoteses.

Derivar referencia e acao observada do mesmo holding mede consistencia interna. Para parada fisica, video sincronizado com kind6 pode servir sem kind5 espacial; geometria exige evidencia espacial independente.

## Executor: melhorias e concorrencia pendente

O codigo atual acrescenta estados, sequencia, ownerSeq, TID e resultado indeterminado. Melhora o desenho antigo que confundia inicio com conclusao.

Ha uma janela no timeout: a callback disputa CLAIMED para RUNNING por CAS; o caminho que nao observou RUNNING faz reset incondicional para IDLE e retorna FAILED. A callback pode iniciar entre a ultima leitura e o reset. Uma acao iniciada pode ser classificada como nao executada, permitindo fallback no walk.

Revisar cancelamento atomico disputando o mesmo estado da callback, nao apenas aumentar prazo. Revisar tambem alteracoes de textLen/buffer antes de recusar pedido anterior em voo. Observacao estatica; nenhuma corrida provocada no jogo.

## Continuidade e limites

1. Integrar decisoes do lure ao runtime e cobrir por teste.
2. Fechar cancelamento e propriedade do pedido nativo.
3. Validar ciclo integrado curto com posicao/HP e identificacao da DLL da mesma sessao.
4. Separar efeito do nosso bot de reproducao do comportamento do Shiba.

Nao provado nesta revisao: movimento nativo estavel sem foco/minimizado; efeito do combo mais recente; equivalencia com o lure do Shiba; seguranca completa de vida util e chamadas nativas; qual DLL esta carregada agora. Arquivo em disco nao comprova modulo carregado.
