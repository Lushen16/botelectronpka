# Exceções em trânsito — regra final

Data: 2026-11-07
Escopo: **somente** a regra de exceções em trânsito.
Nada injetado no jogo.

DLL: `native/pka_walktrace.dll`
sha256: `320A26876E136A9727FC9D6EAB2A8097429316279609E00BCD0548F22933F1AD`

---

## 1. O "carimbo" — o que era e por que saiu

O que eu chamava de carimbo era `g_lastHitStampMs`, preenchido com
`GetTickCount64()` **dentro do handler, ao receber a exceção**.

| pergunta | resposta |
| :--- | :--- |
| onde era criado | no handler, linha `g_lastHitStampMs = GetTickCount64();` |
| onde ficava | variável global, último valor apenas |
| como vinculava a exceção ao armamento | **não vinculava** |

Era hora de recebimento. Não carrega origem: duas exceções de armamentos
diferentes produzem o mesmo tipo de valor. **Removido como critério.** O
campo não existe mais no JSON.

---

## 2. O que substituiu: atribuição por `Dr0` no contexto da exceção

O Windows entrega ao VEH o `CONTEXT` com os debug registers **do momento do
disparo**. Medi três candidatos:

### `Dr6.B<n>` — descartado

Visível no handler (confirmado: `dr6_at_entry=0xffff0ff1`, B0=1), inclusive com
atraso de 200 ms. Mas **instável sob concorrência**:

```
clears=63905  hits=25138  b0_seen=24335  b0_lost=803
VERDICT dr6_b0_stable_under_concurrent_clear=NO
```

803 de 25138 chegaram com B0 já zerado porque outra thread limpou `Dr6`
durante a entrega. Não serve como identidade.

### `Dr0` — adotado

```
cycles=50242  hits=12350  dr0_match=12235  dr0_zero=115  ambiguous=0
VERDICT dr0_identifies_origin=YES
```

- `12235`: `Dr0 == alvo` e `L0` ligado → disparo em curso
- `115`: `Dr0 == 0` → exceção levantada antes de o desarme limpar
- **0 ambíguos**

`Dr0` no contexto é o que o hardware diz sobre a origem. Não é relógio.

---

## 3. O kernel zera `Dr0` — e isso mudou o desenho

Tentei manter `Dr0` setado como "marca de origem" com `L0` desligado:

```
set2 (L0 off only) ok=1
after clear: dr0=0x0 dr7=0x0 L0=0
```

**Não existe estado de debug sem slot habilitado.** O kernel zera `Dr0..Dr3`
quando nenhum `L`/`G` fica ligado. "Marca retida" é impossível.

Logo, a atribuição não pode vir do `Dr0` *depois* do desarme. Ela vem de
**não desarmar enquanto houver `#DB` pendente**.

---

## 4. A regra determinística: `wait_pending_db`

```
thread SUSPENSA  +  Dr6.B<slot> == 0   =>   não há #DB nosso a caminho
```

- Thread suspensa não executa a instrução de breakpoint, então não levanta
  novo `#DB` durante a checagem. A decisão é tomada contra estado congelado.
- Se `Dr6.B<slot> == 1`: há exceção levantada e não entregue. **Retomamos a
  thread** para o VEH consumi-la (o handler limpa o bit) e tentamos de novo.
  Não limpamos nada nesse meio-tempo.
- Budget de 500 ms; estourar → `pendingDbTimeout`, desarme **recusado**
  (`state=5`), nada é limpo.

Aplicado em `do_stop`, **antes** de cada `disarm_one`:

```c
if (!wait_pending_db(tid, slot, 500, &err)) {
    /* registra pendência, NÃO desarma esta thread */
    anyFailed = 1; continue;
}
disarm_one(tid, slot, &err);
```

### Não há prazo mágico

Não uso 50 ms. Não uso janela temporal. A condição é um **bit de hardware
lido com a thread suspensa**: ou existe `#DB` pendente, ou não existe. Não é
tolerância empírica.

### O que ainda é limite declarado

Se um terceiro apontar `Dr0` para o **mesmo endereço**, ambos monitoram o
mesmo ponto e o contexto não os separa. Isso é ambiguidade **por construção**,
registrada em `ambiguousSameTarget`, não adivinhada. Ver
`reuse_inside`/`reuse_after`.

---

## 5. Testes dirigidos (todos exercitam a condição)

### `transit_delayed`

Estado antes do Stop: `slot_enabled=3`, `dr7=0x401`, `dr6=0xffff0ff0`.
Depois: `slot_enabled=0`, `dr7=0x0`, `dr6=0x0`.

```
ATTR_DELAY before_stop threads=3 slot_enabled=3 sample_dr7=0x401
ATTR_DELAY after_stop  threads=3 slot_enabled=0 sample_dr7=0x0 sample_dr6=0x0
ATTR_DELAY verdict=DISARMED_DETERMINISTIC
```

E `events 3→6` durante a janela de desarme: exceções chegaram e foram
consumidas.

**Limite honesto:** `forced_pending_db=0`. Tentei forçar `Dr6.B0` escrevendo
`SetThreadContext` com `L0` ligado; o kernel não preservou o bit. Então o
caminho "havia `#DB` pendente" **não foi exercitado** neste teste — só o
caminho "não havia". O gate roda (`gateChecks` > 0) mas `pendingDbSeen=0` em
todas as execuções. Está instrumentado para provar quando ocorrer.

### `reuse_inside` — terceiro no mesmo slot/endereço, tracer ATIVO

```
REUSE_INSIDE alien_armed=1 same_addr=1 same_slot=1
REUSE_INSIDE tracer_state_before=2 after=2
REUSE_INSIDE tracer_events_delta=79 alien_hits=0
```

Tracer armado consome os 79 eventos; o VEH alheio não recebe nenhum. É a
ambiguidade esperada: com o mesmo slot+endereço não há como separar. O JSON
declara `ambiguousSameTarget`; não fingimos separar.

### `reuse_after` — terceiro toma o slot antes do Stop

```
REUSE_AFTER hijacked_tid=26976 hijacked=1
PHASE stop returned=5 state=5
json: state=disarm_failed verified=0
      pending={"tid":26976,"err":170,"stage":3}
```

`err=170` = `ERROR_BUSY`. O desarme **recusou** mexer num slot que não é mais
nosso. Não rouba de volta. Registra TID e motivo. `disarmVerified=0` — não
declara limpo.

### `stop_race` — parada sob concorrência

```
calls=207 events=195
STOP_RACE stop_result=4 elapsed_ms=0 leftover=0 self_L0=0
STOP_RACE verdict=CLEAN
```

195 eventos disparando enquanto o Stop roda; desarme limpo, zero residual.

### Bateria completa

14 cenários × 5 repetições = **70 execuções, 0 falhas**:

```
basic, negative, occupied, limit, timeout, twice, partial, residual,
foreign_after_stop, late_thread, transit_delayed, reuse_inside,
reuse_after, stop_race
```

---

## 6. Injeção e encerramento com a DLL final

```
DLL_SHA256=320A26876E136A9727FC9D6EAB2A8097429316279609E00BCD0548F22933F1AD
CONFIG: module=walktrace_target.exe rva=1000 max_events=5 max_seconds=8
        threads=* out=...inject_final2.json
TARGET_PID=18392
LOADED base=0x7ff987840000 (64-bit, por enumeração de módulo)
CALL_RETURNED PkaWalkTraceStart=0x2   (ARMED)
target_exited=False
```

Estado final do JSON vinculado ao hash acima:

```
state=disarmed   attribution=dr0-held
handlerRegistered=1   recordingEnabled=0
armedThreads=6   armedThreadsLive=0   disarmVerified=1
gateChecks=6   pendingDbSeen=0   pendingDbTimeout=0
recognizedTransit=0   ambiguousSameTarget=0
exceptionsObserved=6   recordsAccepted=5   recordsDiscarded=1   maxRecords=5
coverage={snapshot:6, armed:6, refused:0, goneBeforeArm:0, lateThreadsArmed:0}
disarmPendingCount=0
```

`6 == 5 + 1` fecha. Cobertura total no snapshot.

---

## 7. Contrato de estado (inalterado)

| campo | significado |
| :--- | :--- |
| `handlerRegistered` | VEH instalado (fica 1; não é removido) |
| `recordingEnabled` | gate grava eventos |
| `armedThreads` | snapshot no início |
| `armedThreadsLive` | armadas agora |
| `disarmVerified` | `DR7`/`Dr0`/`Dr6` relidos e limpos |
| `attribution` | `"dr0-held"` — método de identificação |
| `gateChecks` / `pendingDbSeen` / `pendingDbTimeout` | gate exercitado |
| `recognizedTransit` | exceções nossas reconhecidas fora do disparo ativo |
| `ambiguousSameTarget` | terceiro no mesmo endereço |

---

## 8. Resposta direta ao ponto 4

**A atribuição inequívoca é possível** para o caso real: `#DB` pendente é
detectado antes do desarme por leitura de `Dr6` com a thread suspensa — sem
prazo. Não aumentei nenhum timeout para "resolver" isso.

**Não é possível** separar quando um terceiro aponta `Dr0` para o mesmo
endereço. Isso é limite físico do mecanismo, declarado em
`ambiguousSameTarget`, com teste (`reuse_inside`) provando que o comportamento
é o esperado e não silencioso.

---

## 9. Configuração revisada

```
module=pokealliance_dx.exe
rva=780c90
max_events=5
max_seconds=60
threads=*
out=C:\Users\yago\Documents\Clone\RECONSTRUÇÃO OFICIAL\local-data\walktrace-game-<PID>.json
```

Sem `threads=` → recusa. Sem `--force`, build divergente → recusa.

---

## 10. Pendente

- Teste B, executor nativo próprio, background, minimizado.
- `pendingStep` intacto; `native-step.cjs` fora do walker.
- Identidade de `[0x39cb958]` como `LocalPlayer` não provada.
- Caminho "havia `#DB` pendente" instrumentado mas não exercitado em teste
  (o kernel não aceita `Dr6.B` escrito à mão com o slot ligado).
