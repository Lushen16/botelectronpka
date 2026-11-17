# Auditoria dirigida — walker, combate e background

Data: 2026-11-05 ~16:15Z. Somente leitura: nenhuma ação no jogo, nenhuma
captura, nenhuma alteração de foco.

Baseline preservado: teste A validado às 19:10Z com a DLL `b293b2e7…`
(`local-data/walk-testA-armed-2026-11-05T19-08-42-747Z.json`).

---

## 1. O que a análise existente efetivamente oferece

### Combate — `research/shiba_tap/COMBAT_NATIVE_PROVEN.md`

**Observado estaticamente** (dump de 3.293.184 B do `msftedit.dll` stomped,
SHA-256 em `native-payload-audit.json`):

- `attack` **não é tecla**. É chamada de função dentro do jogo.
- Strings que provam o caminho, com RVA: `0xe4340` ("Client profile %s
  verified"), `0xe45f0` ("Resolving %s target %u"), `0xe4618`
  ("Dispatching %s target %u"), usadas pela função `0x12884..0x137c8`.
- O despacho vai para `0x15280` (ou `0x19b20` em build anterior), com
  `ecx = targetId` e `dl = modo` (0 = attack, 1 = follow).
- `send` (canal de comando) em `0x84340`.
- Regras de decisão com âncora byte-exata: medicine gate `0x57fe8`,
  deploy gate `0x9d2c3`, best tile `0x936ae`/`0x930e2`/`0x93a24`,
  next team `0x9b6c9`.

**Inferido, não observado:**
- O que `0x19b20` faz internamente. A assinatura `(ecx=targetId, dl=mode)` é
  leitura do prólogo, não prova de efeito.
- O ponteiro em `[rip+0x210a95]` é preenchido em runtime e nunca foi resolvido
  em dump vivo.

**Desconhecido:**
- Nenhum `effectVerified` foi obtido para ataque — nem pelo Shiba.

### Walker

**O que existe de código próprio**, duas implementações:

| arquivo | API | uso |
| :--- | :--- | :--- |
| `botfinal/engines/walker-engine.cjs` | `WalkerEngine.tick(telemetry, dispatcher)` | usado pelo `BotRuntime` e pelo teste A |
| `reconstruction/engines/walker-engine.cjs` | `createWalkerEngine(config)` | usado pelo backend teclado/RPM do Electron |

O do `botfinal` é o mais simples: escolhe direção cardinal por diferença de
coordenada, respeita cadência de 280 ms, avança waypoint ao chegar.
O do `reconstruction` tem `smartWalking`, escadas, detecção de travamento.

**O que NÃO existe**: evidência de que o Shiba caminhe por tecla. Não encontrei,
em nenhum doc, uma prova de "walker do fornecedor = PostMessage de seta". O que
está documentado é o **nosso** caminho por tecla (`WALKER_TECLADO.md`,
`TARGET_RPM_VALIDACAO.md`), que é uma extensão local declarada como tal.

### Execução e foco — `reconstruction/BACKGROUND_CAPTURE.md`

Este é o achado mais relevante para o requisito de produto:

> "O helper envia a tecla da bola e o clique somente via PostMessageW no HWND
> do PID selecionado. **Não há aquisição de foco, SendInput ou keybd_event
> nesse transporte.**"

E, explicitamente:

> "**PostMessage não garante que o cliente processe input quando minimizado;
> não existe fallback de foco.**"

Ou seja: o projeto **já tentou** um caminho sem foco, por `PostMessageW`, e
documentou que **não comprovou** que o cliente processe input em background.
`succeeded/eventsSent` são "mensagens aceitas na fila do Windows, não ação
aplicada no cliente".

`TARGET_RPM_VALIDACAO.md` é mais duro ainda: os ensaios de 29/10 aconteceram com
o cliente **em foco** ("Início e Continuar revalidam jogador e criaturas após
adquirir foco. Perda de foco pausa ambos").

### Estado atual do nosso executor

`native/pka_native.c`, `execute_command`:

- branch para `type == 1` (walk), `type == 20` (hotkey), `type == 4` (stop);
- **não há branch para `type == 2` (attack)**;
- fallback final: `return STATUS_UNSUPPORTED` (4).

### Origem exata do status 3 no caminho attack

Determinada por leitura do código:

| item | resposta |
| :--- | :--- |
| função | `execute_command()` em `native/pka_native.c` |
| condição | `type == 2` não casa nenhum `if`; cai no `return` final |
| significado atual | `STATUS_UNSUPPORTED = 4` |
| significado **histórico** | era literal `3`, que era também o código de `STATUS_NO_WINDOW`. Daí a confusão: "status 3" em attack **nunca** significou "janela ausente"; significava "não implementado" |

A referência que resolveria a lacuna é `0x15280` (`COMBAT_NATIVE_PROVEN.md`),
mas chamar RVA fixa em build diferente é exatamente o que não se deve fazer
sem resolver o ponteiro de runtime.

---

## 2. O que continua desconhecido

1. Se o Shiba executa a caminhada por tecla, por chamada nativa, ou pelo
   próprio cliente reagindo a um "walk to" do protocolo.
2. Se existe, na referência, um caminho de execução verdadeiramente
   independente de foco. **Nenhuma evidência concreta encontrada.**
3. O que `0x19b20` faz (efeito de ataque).
4. A resolução viva do ponteiro `[rip+0x210a95]`.
5. Semântica de `actionBarSettings.action=6` (o próprio doc marca como não
   comprovada).

---

## 3. Matriz de decisão

| capacidade | referência disponível | implementação própria | evidência | bloqueio |
| :--- | :--- | :--- | :--- | :--- |
| walker (decisão) | nenhuma prova do algoritmo do Shiba | `botfinal/engines/walker-engine.cjs` | teste A valida **dispatcher→DLL→efeito**, não o motor | falta validar a cadeia completa |
| walker (execução) | — | `PostMessageW` + scan code extended | **VALIDADO NO CLIENTE** 19:10Z | exige foreground |
| seleção de alvo | regras com âncora no dump | `botfinal/engines/combat-engine.cjs` | só testes locais | falta telemetria de criaturas (nossa DLL publica `creatures: []`) |
| execução de ataque | `0x15280` (RVA) | **NÃO IMPLEMENTADO** | status 3/4 documentado | RVA fixa é inválida entre builds; falta resolução viva |
| background sem foco | tentado por `PostMessageW`, **não comprovado** | `PKA_EXECUTOR_MODE=background` | nenhuma | **NÃO SUPORTADO**; evidência de que o cliente ignora |

### Respostas diretas

- **O que sabemos do algoritmo do walker?** Que existe um motor nosso
  funcional (direção cardinal por delta, cadência, waypoints). Nada do
  algoritmo do fornecedor foi provado.
- **O que sabemos do algoritmo de combate?** As regras de decisão têm âncoras
  no dump. A execução é chamada nativa com `(targetId, mode)`, mas o efeito
  não é observado.
- **Caminho efetivo de execução?** Hoje: Node → pipe → DLL → `PostMessageW`.
  Para ataque: **não existe** caminho implementado.
- **Existe evidência de background na referência?** **Não.** O projeto tentou
  e documentou que não comprovou.
- **Nosso executor é equivalente?** Não é equivalente a nada do Shiba — é
  **simulação de entrada de teclado** via `PostMessageW`, e exige foreground.

---

## 4. Caminho recomendado

**Fatia A: fechar o walker próprio pelo executor foreground já demonstrado.**

Motivo: o elo `dispatcher → DLL → efeito` está provado. O elo que falta é
`configuração → WalkerEngine → runtime/árbitro → dispatcher`. Isso é código
que já existe e precisa apenas ser exercitado pela cadeia real, sem escrever
motor novo.

Não escolho B (investigar execução independente de foco) porque:

- não há referência concreta de que exista;
- a tentativa documentada com `PostMessageW` não comprovou efeito;
- investigar exigiria captura nova, e a pergunta "existe caminho sem foco?"
  não é respondida por mais capturas de kind 11 (formato já conhecido).

**Combate permanece bloqueado** e não será tocado nesta rodada: `attack` exige
chamada nativa com RVA resolvido em runtime, e testar RVA fixa no cliente vivo
por tentativa e erro é proibido pelo escopo.

---

## 5. Próxima alteração mínima

Nenhuma reescrita. Duas mudanças pontuais:

1. `tools/live_walk_armed.cjs` ganha um modo `--engine` que exercita
   `WalkerEngine → BotRuntime → CommandDispatcher` em vez de chamar o
   dispatcher direto. É o teste B do escopo, agora com o executor corrigido.
2. O gate de estabilidade passa a exigir, além de "posições idênticas":
   cobertura temporal mínima, lacuna máxima entre leituras, timestamps e
   identidade constante — sem afrouxar para "verde".

O teste A de 19:10Z **não** será repetido: não houve regressão.
