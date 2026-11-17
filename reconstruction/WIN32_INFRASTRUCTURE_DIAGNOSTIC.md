# Infraestrutura Win32 — 2026-10-31

## Alterações

- tools/walker_input.py mantém uma única vinculação WinSta0/Default por
  objeto user32 no helper. Os handles associados são retidos até o término
  do processo, evitando reaberturas a cada descoberta. Falha ao selecionar
  a station fecha o handle recém-aberto e não abre Default na station errada.
- EnumWindows é tentado primeiro, após a vinculação. Se não houver janela
  elegível, EnumDesktopWindows tenta o desktop explícito. PID, título,
  visibilidade, owner e dimensões continuam sendo verificados. Falhas de
  vinculação são incluídas no erro final de descoberta.
- tools/combat_actuator.py reutiliza essa descoberta no CLI e no --serve,
  removendo vinculações redundantes. O protocolo residente existente mantém
  stdin/stdout JSONL, correlação por id e o interpretador aberto. Falhas após
  input parcial não recebem retry automático.
- reconstruction/app/main.cjs rejeita PID inválido e nome vazio antes de
  iniciar o scanner. A chegada de status.ok com PID correspondente e nome
  aciona o scanner. Erro de spawn libera a referência para nova tentativa;
  eventos de um filho antigo não apagam seu substituto.
- tools/creature_bridge.cjs trata arquivo vazio, whitespace, JSON incompleto,
  ENOENT, EACCES, EPERM e EBUSY como indisponibilidade transitória. Somente
  reutiliza snapshot ainda fresco; sem ele, retorna erro controlado
  CREATURE_STREAM_WAITING sem revelar mensagem bruta/caminho do Windows.

## Evidência real

O comando solicitado foi executado duas vezes:

    python -B tools/combat_actuator.py 37936 --probe

Ambas retornaram success=false, eventsSent=0, pointerEventsSent=0,
error="Processo do cliente indisponivel.". A consulta Win32_Process não
encontrou executável PokeAlliance ativo. Nenhum HWND ou resultado positivo
foi fabricado, e não houve envio de input ao jogo nesta tarefa.

No mesmo terminal, uma chamada real a user32 confirmou a vinculação:
station=0x17c, desktop=0x16c, issues=[], sameBinding=true.
EnumWindows retornou sucesso e enumerou 277 janelas. Isso valida o caminho
Win32 nesse processo, não a presença do jogo ou acesso a outra sessão.

## Desempenho e limites

tools/bench_combat_dispatch.py executou 2000 iterações com Win32 simulado
e sleep substituído. Para key: primeira mensagem média 36,712 us e p99
103,7 us; comando médio 62,292 us. Não é medição de latência do jogo nem
garantia de prazo. O transporte real mantém pressão de tecla de 40 ms;
assim, o round-trip completo não pode ser declarado inferior a 2 ms.
As guardas RPM e o agendamento do Windows adicionam custos variáveis.

Nenhuma descoberta é infalível diante de processo encerrado, PID reutilizado,
desktop inacessível ou outra sessão Windows. O HWND histórico 0x29039a não
é usado como fallback fixo.

Os novos testes estão em tests/win32_infrastructure.test.cjs e
tests/win32_discovery_checks.py. Aprovação da suíte não equivale a 100%
de cobertura de linhas/branches nem a validação de input no cliente.

## Validação final

node tools/validate.cjs concluiu com success=true em
2026-10-31T22:43:50.913Z. Build, smoke e audit retornaram saída zero.
Node: 593 testes, 585 aprovados, oito ignorados, zero falhas.
Electron: 593 testes aprovados, zero ignorados e zero falhas.
git diff --check não encontrou erros de whitespace, apenas avisos LF/CRLF.
O cliente fechado mantém o probe positivo e a medição real de input pendentes.
