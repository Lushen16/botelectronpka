# Tracer CONGELADO

Data: 2026-11-07
Motivo: decisao de mecanismo mudou para depurador externo (cdb).
Nada aqui deve ser recompilado, reinjetado ou reaproveitado sem decisao nova.

DLL: pka_walktrace.dll
sha256: 810A87FFD1A31CA56C3877733CACA68CD00B46661F7EB2138C8DB55DCD72318B

## Estado final do tracer

- Ciclo de vida IDLE->PREPARED->ARMED->STOPPING->DISARMED/DISARM_FAILED
- Atribuicao por Dr0 no entry do handler; Dr6 descartado por instabilidade
- Gate de pendencia (wait_pending_db) presente, ramo NUNCA exercitado
- 70 execucoes no ramo exercitado, 0 falhas
- VEH NAO e removido apos Stop (inerte, handlerRegistered fica 1)
- Limitacao declarada: slot+endereco NAO identificam proprietario;
  debug registers sao POR THREAD (provado em diag_perthread.c)

## Por que congelado

A pergunta em aberto era atribuicao de origem de excecao. O tracer
resolvia por inferencia nao documentada. O depurador externo resolve por
DEBUG_EVENT, que e' explicito e documentado.

## O que NAO fazer

- nao rodar build_walktrace.cjs
- nao injetar pka_walktrace.dll no cliente
- nao tratar este codigo como pronto; o ramo de pendencia nunca rodou
- nao usar os vereditos "DISARMED_STATE_VERIFIED" como prova de garantia
