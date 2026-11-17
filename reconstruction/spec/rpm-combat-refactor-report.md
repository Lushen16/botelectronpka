# Refatoração do combate RPM — Council v2.5 Spectral

Implementação realizada na árvore oficial `RECONSTRUÇAO OFIcial`, em 31/10/2026. O runtime agora agenda movimento independentemente do combate, prioriza cura sem descartar a sequência ofensiva e distingue mudanças de posição de mudanças de identidade no atuador.

1. **Diagnóstico e evidência**

   O bloqueio principal estava em `RpmCombatRuntime.runTick()`: o Walker só era chamado quando o Target retornava `idle` ou `luring`, condicionado ainda a `lure.allowMovement`. Além disso, Walker e combate atualizavam `lastDispatch`, fazendo um envio adiar o outro. O único `inFlight` bloqueava todos os módulos enquanto o subprocesso de combate respondia.

   O tratamento existente de `COMBAT_TARGET_MOVED` já preservava a fila, ao contrário da descrição inicial do problema. Entretanto, inseria um `attack` antes de uma hotkey rejeitada. A causa desse erro estava também em `creature_identity.validate_guard()`: a comparação rígida do tile era aplicada a teclas e cliques indistintamente.

   Havia outro defeito: `combat.step()` avançava a rotação antes de comparar `creaturesGeneratedAt` com `lastCombatSnapshot`. Com um snapshot repetido, mas ainda válido, os eventos planejados eram descartados depois de consumirem o índice da sequência e os cooldowns.

   O arquivo solicitado `reconstruction/spec/rpm-combat-runtime.spec.cjs` não existia. A suíte canônica estava em `tests/rpm_combat_runtime.test.cjs`. Foi criado um ponto de entrada no caminho solicitado que carrega a mesma suíte, evitando duplicação.

   A linha de base selecionada passou com 92 testes. A primeira execução das regressões reproduziu oito falhas antes das correções. O arquivo de hunt examinado continha 1.183 registros, com intervalo mediano de 1.013 ms e campos de posição, HP e criaturas, sem eventos individuais de envio de magias. Portanto, 250–350 ms foi tratado como requisito de comportamento informado, não como uma medição extraída desse arquivo.

2. **Coordenação entre Walker e combate**

   `WalkerInputRuntime` passou a utilizar `lastMovementDispatch`. O `lastDispatch` do runtime RPM controla os envios de combate, cura e captura. Andar não consome GCD de magias; lançar uma magia não reinicia o intervalo do Walker.

   `RpmCombatRuntime.tick()` mantém uma operação pendente por canal: `inFlight` para combate/cura/captura e `walkerFlight` para movimento. Um envio lento de combate não impede o próximo tick do Walker. Nenhum canal duplica sua própria operação pendente. `pause()` aguarda os dois canais; as verificações de `epoch` impedem novos envios após cancelamento.

   A presença de monstros e os estados de hold do Lure deixaram de bloquear a rota no backend RPM. Permanecem os waits explícitos da rota, os intervalos de movimento e as interrupções por telemetria inválida ou erro de transporte. Ao concluir a rota, somente o módulo Walker é removido; Target e Healer continuam ativos.

   A captura `useWith` é uma exceção necessária: combina tecla e clique sobre um corpo projetado no viewport. Ela não começa com movimento pendente e impede novos passos durante essa operação. Isso evita invalidar a projeção entre as partes da captura.

3. **Identidade, mira e movimento do alvo**

   O atuador escolhe o modo da validação a partir do tipo da operação, sem confiar em uma opção dentro do guard fornecido pelo chamador. Cliques exigem posições atuais compatíveis com a projeção. A posição do jogador também é verificada, pois o deslocamento da câmera altera a coordenada do clique.

   Hotkeys conservam as validações de PID, identidade do jogador, identidade e posse do Pokémon próprio, identidade e tipo selvagem do alvo, HP do alvo, andar e validade temporal. Um deslocamento XY não invalida uma hotkey. Sobreposição com o próprio Pokémon continua bloqueando cliques; ela não é um erro de mira para uma tecla sem coordenadas.

   Em uma rejeição recuperável, o runtime conserva a ação e a sequência pendentes, aguarda um snapshot novo e respeita um intervalo mínimo de 300 ms antes de tentar novamente. Cliques são reprojetados; hotkeys não recebem um ataque extra. Mudança de posse, morte, desaparecimento ou saída do alcance invalidam as ações correspondentes. Envios parciais ou de resultado incerto continuam sem repetição automática.

   A revalidação imediatamente anterior ao envio usa novamente o filtro de candidatos, incluindo vida, andar e alcance. Uma conclusão assíncrona registra o envio no motor que o planejou, evitando marcar um motor recém-reconfigurado como se já tivesse atacado.

4. **Cadência e rotação**

   O GCD padrão de 250 ms foi centralizado em `target-engine.cjs`. O backend RPM respeita configurações maiores, incluindo 350 ms, e mede a próxima oportunidade a partir da confirmação do envio. Cooldowns por tecla permanecem ativos, inclusive após reconfiguração.

   Com o timer de 100 ms, o padrão de 250 ms permite envios em ticks separados por aproximadamente 300 ms, sujeito à duração do transporte e ao escalonamento. Não foi introduzido jitter aleatório. Um GCD configurado acima desse padrão continua tendo precedência; o código não promete um teto de 350 ms em qualquer condição.

   `ATTACK_RETRY_MS` e `SKILL_RETRY_MS` passaram a 300 ms. Após um clique aceito, o caminho RPM mantém o alvo pelo ID e não insere cliques periódicos entre magias. A rotação contínua de hotkeys é coberta por um teste com seis habilidades sucessivas a cada 300 ms e apenas um clique inicial. O contrato de repetição de ataque do transporte nativo direto, fora do RPM, permanece em 1.000 ms para preservar seu comportamento existente.

   Snapshots repetidos podem sustentar novas etapas enquanto permanecem válidos. A idade da percepção protege a segurança do envio; ela não funciona mais como relógio da rotação. Os delays explícitos do combo e cooldowns específicos continuam sendo respeitados.

5. **Healer e cura prioritária**

   A cura é avaliada antes de retries, captura e fila ofensiva. `target.healSkill` ganhou planejamento independente da rotação, funcionando também quando há `target.skills` ou nenhum inimigo visível. Uma cura aceita não remove o ataque ou a magia pendente, não avança `comboIndex` e não reinicia a sequência.

   O módulo Healer pode ser ativado no runtime RPM com HP real e identidade válida. Reutiliza `createHealerEngine` em modo de teclado: poção e medicina usam hotkeys suportadas; magias do Pokémon exigem roster e identidade ativa compatíveis. Troca nativa de Pokémon e comandos sem canal de teclado não são simulados; os bloqueios ficam expostos no estado do Healer.

   A cura envia `ownGuard`, que valida jogador e Pokémon próprio sem depender de um alvo hostil. O Walker continua em seu canal independente. Cura e ataque compartilham o GCD e são serializados no canal de combate: prioridade significa a próxima oportunidade válida, sem interromper um pacote já submetido ao atuador. Os cooldowns de cura são corrigidos para o instante da confirmação do envio.

   Alterar configurações de poção/medicina ao ativar o Healer não reconstrói o Target nem apaga sua fila. Somente alterações de Hoenn relevantes ao Target invalidam esse motor.

   Durante a validação geral, foi encontrado um fallback preexistente que transformava HP ausente em 100. `live-session.cjs` passou a manter esse valor como desconhecido, e `pka_live_session.py` retorna `None` quando a leitura do byte de HP falha. Os testes cobrem HP ausente, inválido e válido; não há substituição por uma condição artificialmente saudável.

6. **Validação**

   `node reconstruction/spec/rpm-combat-runtime.spec.cjs`: **46 testes aprovados, zero falhas**. Foram acrescentadas 15 regressões à suíte original de 31 casos. Três expectativas antigas foram adaptadas porque exigiam comportamentos expressamente substituídos: bloquear movimento em combate, compartilhar o relógio do Walker com o GCD e inserir clique antes de retentar uma hotkey.

   A cobertura nova inclui canais pendentes independentes; snapshot repetido; cadência contínua; GCD configurado; cura antes de habilidade enfileirada; cura sem inimigo; ciclo de vida do Healer; HP desconhecido; proteção do Pokémon ativo; pausa aguardando ambos os canais; conclusão da rota; captura com Healer; retry de 300 ms; reconfiguração durante envio e cooldown de cura medido no envio aceito.

   A validação Python de identidade passou com 19 casos. Os testes do transporte verificam que cliques, hotkeys ofensivas e hotkeys de cura chegam ao modo correto de validação no atuador.

   `node tools/validate.cjs`: build aprovado; Node com **575 aprovados, 8 ignorados e zero falhas**; Electron com **583 aprovados e zero falhas**; smoke e auditoria aprovados. Resultado consolidado em `validation.json`.

7. **Limites e integração**

   Não foi executada uma nova hunt real nesta tarefa. `effectVerified: false` permanece correto: a aceitação pelo transporte comprova o envio, não o efeito de dano, cura, seleção ou caminhada dentro do jogo. O clique inicial aceito não equivale a confirmação nativa do alvo selecionado.

   A ativação do Healer não cria roster nem HP inexistentes. Se o provedor RPM não disponibilizar roster/slot/nome ativo verificáveis, a cura específica de um Pokémon fica bloqueada; hotkeys de poção com HP observado não precisam dessa resolução de roster.

   As alterações paralelas no worker residente, em `keyboard-combat.cjs` e no ciclo de serviço de `combat_actuator.py` foram preservadas. Neste último arquivo, esta implementação alterou especificamente o encaminhamento de `targetGuard`/`ownGuard` e o modo posicional. As mudanças anteriores no coletor de criaturas também foram preservadas; a alteração adicional no coletor de sessão trata apenas a ausência de HP e sua verificação.
