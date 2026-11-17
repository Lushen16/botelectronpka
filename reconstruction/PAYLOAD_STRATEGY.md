# Payload do menu — estratégia, provas e limites

## Por que este caminho

Competir pelo pipe não funciona: `maxInstances=1`, e o runtime fecha o canal
para sempre quando o menu original cai (233 imediato em toda leitura, mesmo
ganhando a corrida). Verificado em duas injeções (PIDs 23152 e 26596).

Como o objetivo é comportamento nativo exato, a saída é **não substituir o
cliente, e sim entrar nele**: o menu original faz o handshake como sempre, e o
botfinal assume a mesma conexão já autenticada.

## O que foi verificado

| Fato | Resultado |
| :--- | :--- |
| DLL valida assinatura Authenticode do cliente? | **Não** — sem `WinVerifyTrust`, `CryptQueryObject`, `CryptVerify` |
| DLL valida quem conectou? | Sim: importa `GetNamedPipeClientProcessId`, tem "Sessão não autorizada pela DLL" |
| DLL valida caminho do menu? | Referencia "External PKA menu and file IPC client", mas sem strings de caminho fixo |
| Algum código valida hash/integridade do asar? | **Não** — `asar`, `integrity`, `package-integrity`, `app.asar` ausentes de todo o dump do módulo |
| Fuses do `PKA Tools.exe` | `OnlyLoadAppFromAsar=enabled`, `EnableEmbeddedAsarIntegrityValidation=**disabled**` |
| `package-integrity.json` | Manifesto escrito pelo launcher; não é consultado pelo jogo |

`EnableEmbeddedAsarIntegrityValidation=disabled` é o que torna o caminho viável:
o Electron não recalcula o hash do asar, então trocar o payload em disco não é
detectado pelo processo.

## O que o payload faz

Só um arquivo do asar muda: `main.cjs` (72 bytes) vira o bootstrap.

```text
main.cjs  ->  instala hook de net.connect
          ->  carrega ./bytecode-runtime.cjs
          ->  require('./main.jsc')     <-- menu ORIGINAL, intacto
          ->  quando o canal autentica, sobe o botfinal nele
```

Nada mais é recompilado ou reescrito. `main.jsc`, `lib/*.jsc`, `renderer/`,
`shared/` e `bytecode-runtime.cjs` continuam byte-a-byte originais — o
`install_payload.cjs --verify` confirma isso para os 84 arquivos.

O hook intercepta `net.connect`/`net.createConnection`, reconhece o alvo
`\\.\pipe\pka-runtime-2-<pid>`, e anexa um parser ao **mesmo socket** que o menu
abriu. O menu faz o HMAC; o botfinal só lê os quadros e escreve no quadro
`manual`, exatamente como o menu escreveria.

## Provas executadas

1. **Empacotador asar** — extrai 84 arquivos, reempacota, `verify` compara
   byte-a-byte: OK. Offsets e hashes de integridade por arquivo conferem com o
   original.
2. **Payload gerado** — `install_payload.cjs --verify`: 84 arquivos íntegros +
   entrypoint trocado.
3. **Electron real carregando o payload** (`runtime/electron-v44.7.2`):
   ```
   [pka-controller] hook de net.connect instalado
   [pka-entry] hook instalado
   [pka-entry] main.jsc original carregado
   [pka-entry] botfinal armado para o primeiro canal autenticado
   ```
4. **End-to-end sob Electron** (`tools/e2e_controller.cjs`): **9/9 OK** —
   menu autentica, hook captura o mesmo socket, herda autenticação, monta
   snapshot, e o botfinal despacha `walk` (opcode 1) pelo socket do menu.
5. **Suíte do botfinal**: 41 testes, 41 passando.

## O que NÃO foi provado

- Nada disso foi executado contra o jogo real ainda. Todos os testes usam
  `reconstruction/runtime-server.cjs`, o runtime reconstruído.
- Não há prova de que o DLL aceite o menu modificado — só de que ele não valida
  assinatura nem hash do asar.
- Nenhum ataque, cura, movimento ou captura foi executado no cliente.

## Como aplicar (quando decidir)

```cmd
node tools/install_payload.cjs ^
  --asar "C:\Users\yago\AppData\Local\ShibaLauncher\Apps\bc8634805668a104e3345ee8f6344af9\current\Shiba Bots - Poke Alliance v3.2.9\dll\resources\app.asar" ^
  --out  "local-data\payload-backup-2026-11-03\app.asar.patched" ^
  --verify
```

Isso **não escreve no original**. Para aplicar no lugar:

```cmd
node tools/install_payload.cjs --apply --asar "<...>\app.asar"
```

O backup fica em `<...>\app.asar.orig`, mais a cópia em
`local-data/payload-backup-2026-11-03/`.

Reverter:

```cmd
copy /Y "<...>\app.asar.orig" "<...>\app.asar"
```

## Requisitos em execução

O payload carrega o botfinal **do repositório**, não do asar:

```
PKA_BOTFINAL_DIR=C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial
```

O menu precisa dessa variável (ou o caminho padrão do repo). Log opcional:

```
PKA_CONTROLLER_LOG_DIR=<dir>
```

## Riscos

- O asar modificado quebra a assinatura Authenticode do `PKA Tools.exe` **se**
  ele for assinado — o que não impede a execução, mas muda o hash do binário.
- O launcher (`ShibaLauncher`) mantém `.shiba-install.json` com o hash do asar.
  Uma atualização/reparo pode sobrescrever o payload. Guarde o backup.
- Qualquer erro no hook é engolido de propósito: se ele falhar, o menu original
  ainda sobe. Isso é intencional, mas significa que uma falha silenciosa só
  aparece no log.
