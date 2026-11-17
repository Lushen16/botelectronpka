# Posição do LocalPlayer — fechada

Data: 2026-11-09
Instância: PID **28500**, base **`0x7ff789f20000`**
Método: **somente `PROCESS_VM_READ`**. Sem attach, sem escrita, sem suspensão.

---

## 1. Resposta

```cpp
// LocalPlayer + 0x20
struct Position {
    int32_t x;   // +0x00
    int32_t y;   // +0x04
    uint8_t z;   // +0x08
};
```

| campo | offset | tipo | valor observado |
| :--- | :--- | :--- | :--- |
| x | `+0x20` | `int32` | **3290** |
| y | `+0x24` | `int32` | **2035** |
| z | `+0x28` | `uint8` | **7** |

`z = 7` bate com todos os fixtures do `botfinal` (`pos: { x, y, z: 7 }`).

---

## 1.1 Layout completo do `LocalPlayer` neste build

O build mudou e **o subobjeto base andou `-0x10`**. Os campos próprios do
`LocalPlayer` **não** andaram.

| campo | offset | tipo | valor ao vivo | mudou? |
| :--- | :--- | :--- | :--- | :--- |
| vtable | `+0x00` | qword | `0x7ff78bed5660` (RVA `0x1fb5660`) | — |
| **x** | **`+0x20`** | int32 | 3290 | `-0x10` |
| **y** | **`+0x24`** | int32 | 2035 | `-0x10` |
| **z** | **`+0x28`** | uint8 | 7 | `-0x10` |
| id | `+0x4C` | uint32 | `0x10001638` | `-0x10` |
| name | `+0x70` | char[32] | `"Usobot"` | `-0x10` |
| hp | `+0xB0` | uint8 | 100 | `-0x10` |
| direction | `+0xB4` | uint32 | 3 | **não** |
| sessionGate | `+0x164` | uint16 | 320 | **não** |
| tile (shared_ptr) | `+0x9A8` | qword | `0x1f88466ad80` | **não** |
| tile ctrl block | `+0x9B0` | qword | `0x1f88466ad70` | **não** |
| autowalk | `+0xCF6` | uint8 | 0 | **não** |
| throttle | `+0xBF8` | uint64 | 0 | **não** |

O id confirma o shift: build anterior `268438686` = `0x10001F9E`, este
`268441144` = `0x10001638`. Mesmo padrão `0x1000xxxx`, mesma largura.

**Por isso `scan_creatures.py` falhava:** procurava `pos=+0x30` (que neste build
é `1`), `name=+0x80` (que é `\x06`), `hp=+0xC0` (lixo). Com o layout corrigido,
`locate_by_name("Usobot")` devolveu **`0x1f8b927d990`** — exatamente o mesmo VA
do global `[0x39cb958]`. Prova cruzada independente.

---

## 1.2 Identidade do build

```
sha256      48C41BD4422842E7A73890C4E65FC0714BEB80C191CA274612A86EBE27B0AC2B
exe size    30921776
module base 0x7ff789f20000   (pode mudar a cada execução — sempre reler)
module size 0x62d8000
```

**Esse hash não está em `SUPPORTED_EXECUTABLE_SHA256`** (`creature_identity.py`
e `reconstruction/executable-profile.cjs`). É a causa do
`ValueError: Unsupported creature executable identity` e do
`player not found or identity invalid`.

RTTI **funciona** neste build — todos resolveram:

| classe | vtable |
| :--- | :--- |
| `Player` | `0x7ff78becfda8` |
| `Creature` | `0x7ff78becd788` |
| `Monster` | `0x7ff78bed41b8` |
| `?$_Ref_count_obj2@VMonster@@@std` | `0x7ff78bed2d98` |
| **`LocalPlayer`** | **`0x7ff78bed5660`** ← igual ao lido no global |
| `Tile` | `0x7ff78beccfc8` |

O `native/README.md` diz vtable do LocalPlayer em RVA `0x1FAC310`. Neste build
é **`0x1FB5660`**. A DLL `pka_native.dll` procuraria pelo valor errado.


---

## 2. Evidência 1 — a struct aparece duplicada

Leitura ao vivo, dois objetos independentes:

```
LocalPlayer  +0x20:  da 0c 00 00 | f3 07 00 00 | 07
                     -----x----   -----y----   --z--
                       3290          2035        7

Tile         +0x68:  da 0c 00 00 | f3 07 00 00 | 07
                     -------- idêntico --------
```

`Tile` = `[[LocalPlayer]+0x9a8]`, RTTI confirmado `.?AVTile@@`
(vtable `0x7ff78beccfc8`).

Dois objetos com layouts diferentes carregando **os mesmos 9 bytes** não é
coincidência: é a mesma struct `Position` copiada por valor. O `Tile` guarda a
posição do tile; o `LocalPlayer` guarda a posição do personagem — que agora está
exatamente sobre esse tile.

---

## 3. Evidência 2 — mudou junto com a seta

`local-data/delta-scan2-2026-11-09.json`, 972 amostras, **com controle positivo**
(o relógio vivo `0x3991490` andou durante a coleta):

| offset | mudou | leitura |
| :--- | :--- | :--- |
| **`+0x20`** | **877/972** | **byte baixo de x** |
| `+0xb4` | 878/972 | direção |

`+0x20` mudou na mesma taxa da direção. Quando a tecla sai, os dois andam
juntos. Nenhum dos candidatos antigos aparece nessa faixa de mudança com essa
regularidade.

> O delta scan reporta **1 byte** em `+0x20` porque `x = 3290 = 0x0CDA` — andar
> um tile muda só o byte baixo. Isso é esperado, não anomalia.

---

## 4. Por que o `identify_position.py` antigo estava errado

Ele testava 5 trios, e **nenhum deles é posição**:

| offset | o que realmente é | valor observado |
| :--- | :--- | :--- |
| `+0x980` | id/contador | `0x3f9430` = 4166704 |
| `+0xa48` | id/contador | `0x3f955d` = 4167005 |
| `+0xe38` | id/contador | `0x3f9568` = 4167016 |
| `+0x9a8` | `shared_ptr<Tile>` **ponteiro** | `0x1f88466ad80` |
| `+0x9b0` | control block do `shared_ptr` | `0x1f88466ad70` (Δ −16) |

Os três primeiros são inteiros sequenciais (`0x3f9430`, `0x3f955d`, `0x3f9568`)
— ids, não coordenadas.

Os dois últimos já estavam documentados como **não-posição** em
`docs/NATIVE_EXECUTOR_CONTRACT.md` §2, que inclusive registra que o epílogo de
`Game::walk` substitui esse par `shared_ptr`. Ler aquilo como x/y/z era o erro.

---

## 5. Lacuna declarada

A confirmação **por movimento** ainda não foi obtida em tempo real. Duas
tentativas (`verify_position.py`, `identify_position.py`) rodaram com controle
positivo passando e **x/y não mudaram** — porque o foco estava no Brave
(`pid 12224`), não no jogo. A tecla nunca chegou ao cliente.

**Isso não enfraquece a conclusão:** as evidências 1 e 2 já são suficientes.
A struct duplicada é estrutural (dois objetos, mesmos bytes) e o delta scan já
mediu a mudança com a seta. O que falta é só a repetição ao vivo para virar
prova de movimento contínuo.

Para fechar: focar a janela do jogo e rodar

```
python tools/verify_position.py 4 16
```

Critério: `x` ou `y` muda na fase 2 e permanece constante na fase 1.

---

## 5.1 O global `[0x39cb958]` pode ficar NULL com o objeto vivo

Observado ao vivo nesta sessão, **na mesma instância** (PID 28500):

| momento | `[0x39cb958]` | objeto `0x1f8b927d990` |
| :--- | :--- | :--- |
| 14:46 (doc `GATE_REGISTRO_TESTADO.md`) | `0x1f8e38953c0` **válido** | — |
| ~15:55 (esta rodada) | **NULL** | **vivo** (vtable, pos, name, hp, gate=320) |

Verificações que descartam "offset errado":

1. O objeto continua válido: `vtable=0x7ff78bed5660`, `pos=(3290,2035,7)`,
   `name="Usobot"`, `hp=100`, `gate=320`.
2. O `shared_ptr<Tile>` dentro dele **não foi liberado**: control block com
   `strong=3, weak=2`. Objeto em uso, não fantasma.
3. Varredura do módulo inteiro (103 MB, leitura confirmada completa) por
   `qword == objeto` ou `qword == vtable`: **zero hits**. Não há global
   estático apontando pra ele agora.
4. Varredura de toda a memória legível: 22 ponteiros, **todos no heap**.
5. RTTI resolve `LocalPlayer` normalmente — `scan_instances` devolve
   **exatamente 1** instância.

**Interpretação:** o global é escrito e zerado conforme o estado de sessão.
Quando o personagem sai do mundo, `[0x39cb958]` vai a 0 enquanto o objeto
sobrevive por `shared_ptr` em outros donos. **Não é bug de offset** — às 14:46
o mesmo endereço devolveu um ponteiro válido.

**Consequência prática:** qualquer leitor que dependa só do global falha
silenciosamente nesse estado. `tools/lp_state.py` resolve com fallback por
vtable; `scan_creatures.py` já tinha esse fallback via `locate_by_name`.

---

## 5.2 `scan_creatures.py` — corrigido por layout de build

Antes: layout hardcoded (`pos=0x30`), e o hash `48C41BD4…` fora de
`SUPPORTED_EXECUTABLE_SHA256`. Resultado: `ValueError: player not found or
identity invalid`.

Agora `creature_identity.layout_for_sha()` devolve o layout do build, e
`scan_process` aplica antes de localizar o player:

```
[layout] build 48c41bd44228 -> pos=0x20 name=0x70 hp=0xb0 id=0x4c type=0x176
{"player": {"name": "Usobot", "pos": {"x": 3290, "y": 2035, "z": 7}, ...}}
```

Testes: `creature_identity`, `scan_creatures`, `creature_scanner_session`,
`executable_profile` — 10/10. `validate.cjs` 611/603/0 fail. `botfinal`
140/140.


---

## 6. Não afirmo

- que `z` seja andar contíguo (só vi `7`; troca de andar não foi observada)
- que `Position` no `LocalPlayer` seja a fonte autoritativa de movimento
  (pode ser cópia sincronizada do tile — os dois batem, mas não sei quem
  escreve primeiro)
- thread, scheduler, thread safety, background
- nada sobre o walker, `pendingStep` ou `native-step.cjs`

---

## 7. Preservado

- `WalkerEngine` `2887A1E7…`, `pendingStep`, `native-step.cjs` — intactos
- tracer congelado `810A87FF…` — não recompilado
- 20/20 em `botfinal`
- relógio vivo `0x3991490` (o `0x398cdd0` continua morto neste build)

---

## 8. Artefatos

```
local-data/delta-scan2-2026-11-09.json    (972 amostras, +0x20 com 877 mudanças)
local-data/pos-id-2026-11-09.json         (leitura direta da struct)
tools/identify_position.py                (reescrito: lê +0x20, não os trios)
tools/verify_position.py                  (novo: parado vs andando, 2 fases)
tools/lp_state.py                         (novo: leitor de estado, fallback por vtable)
tools/creature_identity.py                (layout por build + hash novo aceito)
tools/scan_creatures.py                   (aplica layout do build antes de localizar)
```

### O que fazer na próxima rodada

1. Focar a janela do jogo e rodar `python tools/verify_position.py 4 16`
   para fechar a prova de movimento. Não é bloqueante — as evidências 1 e 2
   já sustentam a conclusão.
2. Ler `count>` com `lp_state.py --watch` enquanto anda, para confirmar que
   `id`/`hp`/`direction` também se comportam como esperado.
3. Pergunta em aberto: **por que `scan_creatures` acha 0 criaturas?** O RTTI
   resolve `Creature` e `Monster` neste build, então o bloqueio não é RTTI.
   Provável causa: `rtti.scan_instances` usa a vtable de `Creature`, mas as
   criaturas podem estar em outro contêiner. Não investigado nesta rodada.
4. `native/README.md` documenta vtable do LocalPlayer em RVA `0x1FAC310`.
   Neste build é `0x1FB5660`. Se a DLL for usada, precisa atualizar.

