# Target e scanner — seguimento de 2026-10-31

## Correções nesta retomada

- tools/scan_creatures.py compartilha descoberta dinâmica entre CLI e streaming.
  Remove endereços absolutos históricos e coordenadas de fallback. Obtém a base
  do módulo atual, resolve RTTI Monster e seu controle compartilhado, exige o
  hash suportado e valida referências e vtable do objeto antes da classificação.
- A localização do jogador usa cadeias relativas à base atual e busca nominal
  validada como alternativa. Jogador inválido não recebe novas coordenadas nem
  timestamp de snapshot; o streaming tenta relocá-lo na próxima descoberta.
- reconstruction/rpm-combat-runtime.cjs não exige exatamente um pet para
  habilitar Target. Ausência ou ambiguidade deixa ownPokemon=null e um aviso;
  não pausa Walker nem impede seleção de inimigos tipo 1 verificados.
- Todos os tiles ocupados pelos pets tipo 3 conhecidos são excluídos dos alvos,
  inclusive quando há mais de um candidato próprio. Mudanças de identidade
  continuam invalidando ações planejadas antes do envio.
- tools/creature_identity.py aceita ausência de pet somente em TargetGuard
  explícito allowMissingOwn=true, com alvo obrigatório e releitura RPM do
  inimigo. Mantém verificações de tipo, ID, HP, posição, andar e validade temporal.
  Cura não aceita essa opção: ainda exige pet próprio comprovado.

## Validação factual

Executado: python -B tools/scan_creatures.py --pid 29472
--player-name Nobutdopai --output captures/creatures-29472-dynamic-cli.json.

Na última leitura, timestamp 2026-11-01T01:25:05.124003+00:00
(31/10, 22:25:05 em America/Sao_Paulo), o scanner encontrou o objeto nominal
Nobutdopai em (3315,2107,7), base 0x7ff65f700000, mas nenhum monstro ou pet
validado. Isso comprova execução do caminho dinâmico, não sessão online,
invocação de pet, ataque, dano, abate ou captura.

Os 54 testes Node focados passaram. Regressões Python incluem duas bases ASLR,
jogador inválido sem publicação, política explícita de Target sem pet, rejeição
de tipo 3 e impossibilidade de curar sem identidade própria.

node tools/validate.cjs concluiu com success=true em validation.json:
- Build, smoke e audit: exitCode 0.
- Node: 596 testes, 588 aprovados, 8 ignorados, zero falhas.
- Electron: 596 aprovados, zero ignorados e zero falhas.

## Aplicação e limites

O bot PID 29296 foi encerrado normalmente e relançado como PID 16416,
carregando os fontes corrigidos. O jogo PID 29472 não foi encerrado.
Após a reinicialização, local-data/live-provider-status.json passou a informar
waiting / player unresolved. O provedor de criaturas não foi iniciado com nome
vazio; depende da identificação do jogador pelo provedor de sessão.

Nenhum ataque foi enviado nesta retomada. Não houve confirmação de Target
ativado pela UI nem de caça real: falta uma sessão de jogador resolvida e
telemetria atual válida para essa etapa. A captura de janela não forneceu
conteúdo confiável do cliente e não foi usada como prova de seu estado.
