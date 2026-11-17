# Relatório de validação — Walker e combate

## Alterações
- Em reconstruction/engines/walker-engine.cjs, o motor aguarda uma nova leitura quando a posição e o identificador da amostra coincidem com os do último despacho. Isso evita repetir um passo ou contar aquela leitura como tentativa de desatolar.
- Em reconstruction/engines/target-engine.cjs, o Target libera a rota quando o último alvo some depois do combo. Se o AutoRevive estiver habilitado e tiver uma tecla configurada, o estado de combo concluído continua disponível para o revive.
- Duas regressões em tests/engines.test.cjs verificam a leitura repetida e a retomada do mesmo waypoint após o combate.

## Verificação na sessão do Windows — 14/11/2026

Validação reportada pelo usuário após a correção do TDZ em Q() de walker.js.

| Verificação | Resultado |
|---|---|
| Interface | Aberta e responsiva, PID 4708, sessão 1 |
| Smoke | Exit 0 |
| Auditoria | ok:true, failed:[] |
| Validação geral | 853 testes, zero falhas |

Em futuras aberturas, use ABRIR_RECONSTRUCAO.bat, que limpa ELECTRON_RUN_AS_NODE. Se houver nova falha, colete stderr com --enable-logging=stderr --v=1. A causa do código 0x80000003 da tentativa anterior não foi confirmada.

## Verificação anterior no ambiente do assistente
| Verificação | Resultado |
|---|---|
| Testes focados | 118 passaram |
| Build | Passou |
| Suíte Node | 834 passaram, 11 falharam, 8 pulados |
| Suíte Electron | 842 passaram, 11 falharam |
| Smoke | Electron encerrou antes de concluir |
| Auditoria da interface | Sem relatório |

As 11 falhas coincidem por nome com a execução anterior registrada nesta conversa. Envolvem persistência de perfis, locks, scanner RPM e integração de vídeo. Não foi feita uma comparação em checkout limpo.

Para reproduzir a verificação focada, execute:

```powershell
node --test tests/engines.test.cjs tests/rpm_combat_runtime.test.cjs tests/walker_input_runtime.test.cjs tests/walker_target_isolation.test.cjs
```

## Limites
A validação automatizada usou dados locais de teste. O intervalo entre passos ainda depende das leituras de posição. A fluidez no jogo, o contorno de paredes e a equivalência com o Shiba seguem sem confirmação. A análise local em analysis/lure-stop-rule/RELATORIO-VALIDACAO.md registra ausência de vídeo sincronizado para validar a parada física durante a lure.

