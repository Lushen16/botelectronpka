# Bloqueio do Target — diagnóstico de 2026-10-31

## Causa observada

O scanner em streaming procurava o endereço absoluto histórico
0x7ff718ec1e58. No processo 37936, a base observada era
0x7ff7b6780000 e o bloco de controle de Monster usava
0x7ff7b86c1e58. A busca antiga publicava uma lista vazia, impedindo
RpmCombatRuntime de identificar o Pokémon próprio.

## Correção

tools/scan_creatures.py resolve por RTTI, na imagem carregada do processo,
as classes ?$_Ref_count_obj2@VMonster@@@std e Monster. O hash do executável
em disco precisa coincidir com o perfil suportado. Não há fallback para
endereços históricos no streaming. Antes de publicar uma criatura como
verificada, exige referência viva no bloco de controle e a vtable Monster
em +0x10. Os offsets de campos continuam relativos ao bloco de controle.

## Validação observada

- O scanner corrigido encontrou Diglett próprio, ID 1083898939, tipo 3,
  e criaturas selvagens tipo 1 no processo real.
- Após reiniciar somente o scanner antigo, a interface exibiu
  "Target pronto para iniciar" e liberou o botão "Iniciar Target".
- Uma instância diagnóstica de RpmCombatRuntime, usando os arquivos RPM
  reais e o perfil ativo, retornou targetKeyboard=true, issue=null,
  modules=["target"], paused=false para PID 37936.
- Essa instância usou automatic=false e foi encerrada imediatamente.
  O probe de janela não envia teclas. Não foram executados ataques.
- As tentativas de clique automatizado na interface não produziram
  mudança observável; a ativação foi comprovada pela API do motor,
  não por esses cliques. O bot da interface permaneceu pausado.
- 49 testes Node focados passaram, incluindo seis casos Python novos
  sobre relocação, RTTI ausente, hash incompatível e blocos inválidos.
- node tools/validate.cjs: build, smoke e audit com saída 0;
  Node 584 testes, 576 aprovados, 8 ignorados, zero falhas;
  Electron 584 aprovados, zero falhas. Relatório em validation.json.

## Limites

Identificar o Pokémon próprio e iniciar o módulo não comprova ataque,
combo, captura nem operação background no jogo. O perfil observado tinha
Rattata, alcance 5 e minCount 8; não foi alterado para fabricar combate.
O resolvedor corrigido é o caminho --stream usado pelo Electron.
O modo antigo de varredura avulsa não foi validado neste diagnóstico.

## Seguimento — dessincronização dos snapshots em 2026-10-31

Após liberar o Target, foi observado outro bloqueio: "Posicoes RPM
divergentes; projecao de combate suspensa." A interface estava pausada
no waypoint 3/27. Os provedores independentes atualizam a posição em
momentos diferentes; uma divergência temporária encerrava o ciclo inteiro.

reconstruction/rpm-combat-runtime.cjs identifica essa condição como
COMBAT_SNAPSHOT_DESYNC. Antes de qualquer despacho, aguarda sincronização
por até maxAgeMs (1500 ms na configuração padrão), sem enviar comandos,
descartar a fila ou avançar o waypoint. Posições coincidentes permitem
retomar; divergência persistente continua pausando. Falhas de transporte
incertas não recebem repetição automática. A comparação exata foi mantida.

Três regressões em tests/rpm_combat_runtime.test.cjs cobrem divergência
temporária, persistente e surgida imediatamente antes do despacho,
incluindo reprojeção do ataque ainda não enviado.

Uma instância diagnóstica limitada a seis ticks, com automatic=false,
arquivos RPM reais e o perfil salvo ativo, enviou ataque a Magnemite e a
tecla C de AutoCombo via PostMessageW. O atuador informou aceitação dos
eventos; o HP do alvo foi observado de 100 para 95. Os seis ticks mantiveram
paused=false. A instância foi encerrada ao final. A janela do jogo estava
em primeiro plano: isso não valida funcionamento em background. Os registros
mantiveram effectVerified=false; a variação de HP não comprova causalidade
individual, abate ou captura. Walker e recuperação de dessincronização em
movimento real ainda não foram comprovados.

Validação geral concluída em validation.json (2026-10-31T18:31:01.819Z):
build, smoke e audit com saída 0; Node 587 testes, 579 aprovados e oito
ignorados; Electron 587 aprovados; zero falhas em ambas as execuções.

Às 15:45 de America/Sao_Paulo, somente o bot reconstruído e seus helpers
foram reiniciados para carregar o código atualizado. O jogo não foi
reiniciado. Perfis e rotas salvos não foram editados; o waypoint em memória
da execução anterior não foi preservado. O reinício não comprova retomada
da caça pela interface.

A primeira tentativa de lançamento encerrou porque o terminal herdava
ELECTRON_RUN_AS_NODE=1. A segunda removeu essa variável apenas do ambiente
do filho. Foi confirmado o novo Electron principal PID 1844, renderer e
os três provedores RPM filhos, com o jogo original PID 37936 preservado.

Como o lançamento oculto não expôs a interface, o bot foi reaberto às
15:47 como aplicativo interativo, PID 8516. A janela foi observada exibindo
PAUSED, perfil Default salvo e Nobutdopai conectado ao PID 37936. Nenhum
módulo foi iniciado nessa conferência final.
