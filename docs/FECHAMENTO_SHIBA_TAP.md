# FECHAMENTO DA FRENTE SHIBA TAP

Data: 2026-11-13. Veredito sobre a frente de pesquisa `research/shiba_tap/`.
Não é abandono: é declaração de que o que ela existia para responder foi
respondido, e o resto é feature do fornecedor que não queremos copiar.

## 1. O que a frente entregou

| artefato | estado |
| :--- | :--- |
| `native/pka_tap.c` / `pka_tap.dll` | pronto, 17/17 no servidor de teste |
| capturas reais | 5 arquivos, 6,8 GB, `kind 4/5/6/11/12` |
| `KIND11_SCHEMA.md` | envelope completo do controle de automação |
| `KIND6_MAP.md` | 246 campos do kind 6 mapeados |
| `automation-state.cjs` | parser do kind 6, 49/50 testes |
| `botfinal/core/kind11-codec.cjs` | codec consumível, sem depender de `research/` |

## 2. O vocabulário completo do controle (medido)

20 frames `kind 11` c2s na captura limpa PID 8036, ordem preservada:

```
 1. togglePause
 2. togglePause
 3. stop  / hoenn        <- panic stop
 4. stop  / walker       <- panic stop
 5. stop  / hoenn
 6. stop  / walker
 7. monitor [config]
 8. monitor
 9. start / walker [config]
10. stop  / walker
11-16. togglePause  (6×)
17. start / walker [config]
18. start / target [config]
19. stop  / target
20. start / target [config]
```

Leitura: **o menu só liga, desliga e pausa.** Não há comando por criatura, não
há "ataca o alvo X", não há passo individual. A config inteira (10.301 B) vai
uma vez no `start`, e o runtime C++ decide tudo sozinho dali em diante.

Isso confirma a arquitetura que o nosso bot já adota.

## 3. Correção aplicada nesta rodada

`botfinal/core/kind11-codec.cjs` afirmava `OBSERVED_MODULE = [target, walker,
hoenn]` para qualquer op. Mas **`hoenn` só aparece em `stop`, nunca em
`start`**. O codec permitia emitir `start module:"hoenn"` — uma forma que o
fornecedor nunca produziu e que não tem evidência de funcionar.

Agora o vocabulário é por op:

```js
OBSERVED_START_MODULE = ['target', 'walker']
OBSERVED_STOP_MODULE  = ['target', 'walker', 'hoenn']
```

`start/hoenn` passa a ser rejeitado com mensagem clara; `stop/hoenn` (o panic
real) continua aceito. Regressão coberta:

```
OK      start/target
OK      start/walker
REJEITA start/hoenn   <- nunca medido
OK      stop/target
OK      stop/walker
OK      stop/hoenn    <- panic medido
```

## 4. Gap de telemetria: 25 campos, 3 importam

Shiba publica 48 campos no `kind 5`. Nós publicamos 27.

**Faltam 25.** Mas separando por valor:

### Não queremos (22)

`guildDailyAvailable`, `automationVersion`, `shinyVersion`,
`combatDispatchVersion`, `dynamicLureVersion`, `captureVersion`,
`itemInspectorAvailable`, `inspection`, `itemCounts`, `safeLogoutVersion`,
`playerStates`, `guildDailyAutoVersion`, `guildName`, `guildDailyRenewVersion`,
`guildRenewals`, `guildDailies`, `instanceEntryVersion`, `instanceEntry`,
`alertSignals`, `alertEventRevision`, `alertEventsDropped`, `alertEvents`,
`pinnedTexts`, `performance`

São feature de UI do fornecedor (guild daily, entrada de instância, alerta com
som/voz). Copiar sem a UI que consome não ganha nada.

### Queremos (3)

**`direction`** — está em `+0xB4`, e o próprio código já documenta que esse
offset **não anda entre builds** (comentário em `native/pka_native.c` linha
399). Custo: 4 bytes lidos. Uso: o walker precisa saber para onde o personagem
está virado antes de decidir o próximo passo.

Distribuição real medida (9.003 amostras): `0`→8.973, `2`→25, `3`→2, `7`→3.
Direção só muda em transição, então amostrar a 1 Hz perde eventos — outro
motivo para ler a cada observação, não a cada telemetria.

**`roster[]`** — 5 slots com `slot/uuid/name/identityAvailable/healthPercent`
e `moves[]` por Pokémon (`spellword`, `remainingMs`, `totalMs`). Hoje publicamos
`"roster":[]` fixo. É o que falta para o healer escolher por HP real em vez de
cair no `ownPokemon`.

**`moves[]`** — no nível de topo vem **vazio** sempre. As moves reais estão
**dentro de cada slot do roster**. Ou seja, `moves` de topo é campo morto no
protocolo do fornecedor; não vale implementar.

### Nosso extra (3)

`ownPokemon`, `healthPercent`, `runtimeReady` — o Shiba não publica, nós
publicamos. `runtimeReady` já existe e lê o gate real (`RUNTIME_RVA+0x2668`);
eu tinha dito nesta sessão que era pendente e **estava errado**.

## 5. O que fica bloqueado, e por quê

**`roster[]` e `moves[]` não são implementáveis agora.** A estrutura do
pokebar não foi localizada em memória:

- nomes encontrados na varredura eram entradas de Pokédex (stride `0x140`,
  padrão `hino <Nome>`), não o time;
- nomes de move têm **0 ocorrências**;
- `party` foi falso positivo de crypto (ACVP);
- não há ponteiro de LocalPlayer para o pokebar.

Sem uma âncora nova (RTTI da classe de party, ou um scan dirigido no objeto do
jogador), copiar `roster` é adivinhação. E `roster` adivinhado é pior que
`roster` vazio: o healer passaria a escolher por HP errado.

## 6. Veredito

A frente Shiba **cumpriu o objetivo**. O que ela existia para provar está
provado e virou código consumível:

1. o controle é `start/stop/monitor/togglePause`, sem comando granular — logo
   nosso design de DLL autônoma está correto;
2. o `kind 6` é o canal de estado do runtime, e já temos parser;
3. o `kind 12` é lease com contador crescente, já no codec;
4. o vocabulário de `module` é por op, não global — corrigido aqui.

O que resta (`roster`, `direction`) é trabalho do **bot**, não da frente de
pesquisa. Fechar o tap encerra a role de espionagem; as capturas ficam como
evidência congelada e o codec como contrato.

Não deletar `research/shiba_tap/`. Ele não roda em produção, não conflita com
o bot (a regra de coexistência está no `AGENTS.md` do projeto) e é a única
fonte de verdade do protocolo quando uma build nova quebrar alguma suposição.

## 7. Regra que não pode ser esquecida

Nunca injetar `pka_native.dll` e `pka_tap.dll` no mesmo processo. O bot cria o
pipe `pka-runtime-2-<pid>` e brigaria com o do fornecedor. Para espionar,
tap sozinho; para operar, DLL nossa sozinha.
