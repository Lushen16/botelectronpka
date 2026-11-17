# Ferramenta de rota e combate

Interface visual para **desenhar uma rota** e **testar a efetividade do
combate** contra o cliente real. É ferramenta de teste, não o bot.

## Como abrir

```cmd
node tools/rota/abrir.cjs
```

Isso faz tudo: acha o `PokeAlliance_dx.exe` com personagem no mundo, injeta
`native/pka_native.dll` se ainda não estiver carregada, espera o pipe subir,
gera a chave e abre `http://127.0.0.1:7788` no navegador.

Opções:

```cmd
node tools/rota/abrir.cjs --pid 16260          :: pid explícito
node tools/rota/abrir.cjs --port 7790          :: outra porta
node tools/rota/abrir.cjs --no-inject          :: DLL já injetada
```

Se preferir separar:

```cmd
node tools/rota/gerar_chave.cjs --pid 16260
node tools/rota/servidor.cjs --pid 16260 --port 7788
```

## A tela

```
┌───────────────────────────────────┬──────────────────────┐
│                                   │  COMBATE             │
│         mapa (canvas)             │  [Atacar] [Combo]    │
│                                   │  [Poção]  [Parar]    │
│   @  jogador (anel de HP)         ├──────────────────────┤
│   ●  selvagem no seu andar        │  EXECUTAR ROTA       │
│   ○  selvagem em outro andar      │  [▶ Rodar][1 volta]  │
│   ① ②③ waypoints                  │  ☑atacar ☑curar ☑combo│
│                                   ├──────────────────────┤
│                                   │  WAYPOINTS           │
│                                   ├──────────────────────┤
│                                   │  ESTADO / LOG        │
└───────────────────────────────────┴──────────────────────┘
```

### Desenhar a rota

- **Clique** no mapa: adiciona um waypoint na coordenada do cursor.
- **×** no painel: remove aquele waypoint.
- **limpar**: apaga tudo (com confirmação).
- **Arrastar com Shift** (ou botão do meio/direito): panorâmica.
- **Roda do mouse**: zoom ancorado no cursor.

Waypoints são salvos em `captures/routes/desenho-<pid>.json` a cada mudança.
Reabrir a UI restaura a rota.

### Rodar

- **▶ Rodar**: começa no waypoint mais próximo do jogador e fica em loop.
- **Uma volta**: para ao completar a rota.
- **⏸**: pausa/retoma.

Durante a execução, com **atacar** marcado, ele para de andar quando há um
selvagem a ≤2 tiles no mesmo andar, ataca, espera o alvo morrer (ou 4 s) e
segue. Com **curar** marcado, usa poção abaixo de 60% de HP.

### Botões de combate

- **Atacar próximo**: ataca o selvagem mais próximo **no seu andar**.
- **Combo**: manda `!autocombo`.
- **Poção**: `Alt+f` (respeita cooldown de 1500 ms).
- **Parar**: aborta a rota e manda `stop`.

## Decisões que importam

**Node puro, zero dependência.** O repo não tem `ws` nem `express`. A
comunicação é HTTP + SSE (Server-Sent Events): telemetria flui servidor→
navegador (unidirecional, reconecta sozinho) e comandos vão por POST.

**Só 127.0.0.1.** O endpoint `/comando` move o personagem. Não expor na rede.

**Um cliente por vez no pipe.** O canal nativo aceita um handshake só. Se
aparecer `Handshake expirou`, há outro processo conectado — normalmente um
`servidor.cjs` antigo ou um `route-cycle.cjs` rodando. Feche o outro.

**Filtro por andar (z).** O jogo não conecta ataque em alvo de outro andar.
Medido: com `dz=0` → 5/5 deram dano; com `dz=1` → 2/13. Por isso o mapa
desenha selvagens de outro andar em vermelho escuro e esmaecidos, e "Atacar
próximo" ignora eles. O rodapé mostra os z disponíveis.

**Poção com cooldown de verdade.** Sem isso a UI disparava `Alt+f` a cada
400 ms com HP baixo — 14 comandos em 2 s, todos recusados com status 5. O
cooldown de 1500 ms vem da config real capturada do Shiba
(`hoenn.potionCooldownMs`), não de número inventado.

## Comandos permitidos

O servidor só aceita estes, para a ferramenta não virar um bot pela porta dos
fundos:

```
walk  attack  combo  potion  hotkey  stop  switchPokemon
```

Qualquer outro devolve HTTP 400 com a lista.

## Limitações honestas

**Não sobe/desce escada.** Andar cardinal não muda o `z`. Se o waypoint está
em outro andar, o runner registra `waypoint em z=X, você está em z=Y —
pulando` e segue. Mover entre andares exige a ação de escada do jogo, que
ainda não está mapeada.

**Não desvia de obstáculo.** Se um passo for bloqueado por parede, o runner
não tenta rota alternativa; ele repete na próxima amostra. Para testar
combate isso basta; para caça autônoma não.

**Não salva métricas.** O log vive na tela e some ao recarregar. Para medição
com relatório e série de HP, use `tools/route-cycle.cjs`.

**Não cura por move.** `healHpPercent` fica 0 de propósito: curar por move
troca o Pokémon ativo e depende de `roster` real, que nossa DLL ainda não
publica (`roster: []`). Só poção.

## Arquivos

| arquivo | papel |
| :--- | :--- |
| `abrir.cjs` | arranque: acha pid, injeta, gera chave, sobe UI |
| `servidor.cjs` | HTTP + SSE, liga o navegador ao canal nativo |
| `ui.html` | canvas, desenho de rota, painel de combate |
| `gerar_chave.cjs` | `native/pka_channel_key.txt` → `captures/channel-key-<pid>.json` |

## Endpoints

| método | rota | o que faz |
| :--- | :--- | :--- |
| GET | `/` | a UI |
| GET | `/eventos` | SSE: `telemetry`, `state`, `channel`, `route` |
| GET | `/estado` | snapshot para o primeiro paint |
| POST | `/comando` | `{name, parameter, options}` |
| POST | `/rota` | `{waypoints:[{action,pos:{x,y,z},param}]}` |
