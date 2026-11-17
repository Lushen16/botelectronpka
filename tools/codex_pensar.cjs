'use strict';

/**
 * Abre o Codex para RACIOCINAR sobre o projeto, sem risco de escrever arquivo.
 *
 *   node tools/codex_pensar.cjs "sua pergunta"
 *   node tools/codex_pensar.cjs "sua pergunta" --ler reconstruction/engines/target-engine.cjs:460-520
 *   node tools/codex_pensar.cjs --continuar "e se for o contrario?"
 *
 * WHY ESTE SCRIPT
 *
 * O `codex exec` roda nao-interativo, mas exige repetir o contexto e o sandbox
 * toda vez. E o erro custoso e' o oposto: rodar sem `--sandbox read-only` e o
 * agente editar arquivo quando a intencao era so' pensar.
 *
 * Este wrapper fixa `read-only`. Se a pergunta exigir escrita, ela esta' no
 * lugar errado — deve ser um brief numerado, nao uma pergunta.
 *
 * COMO O CODEX ENCONTRA O PROJETO
 * O cwd e' a raiz do repositorio, entao ele le AGENTS.md e RACIOCINIO.md
 * sozinho. Nao precisamos colar contexto: basta apontar os arquivos.
 *
 * SESSOES
 * `--continuar` usa `exec resume --last` para manter o fio da conversa. Sem
 * isso, cada chamada e' uma sessao nova e nao lembra do raciocinio anterior.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CODEX = path.join(process.env.USERPROFILE || '', '.codex', '.sandbox-bin', 'codex.exe');

function arg(flag, def = null) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

function falhar(msg) {
  console.error('[pensar] ' + msg);
  process.exit(2);
}

if (!fs.existsSync(CODEX)) {
  falhar('codex.exe nao encontrado em ' + CODEX + '\n' +
    'Instale o Codex ou ajuste o caminho no topo deste script.');
}

/* A pergunta e' o primeiro argumento que nao e' flag nem valor de flag. */
const FLAGS_COM_VALOR = new Set(['--ler', '--modelo', '--esforco']);
const partes = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (FLAGS_COM_VALOR.has(a)) { i++; continue; }
  if (a.startsWith('--')) continue;
  partes.push(a);
}
const pergunta = partes.join(' ').trim() || arg('--ler') ? partes.join(' ').trim() : '';
if (!pergunta) {
  falhar('falta a pergunta.\n' +
    'uso: node tools/codex_pensar.cjs "sua pergunta" [--ler arquivo:linha-inicial-linha-final]');
}

const continuar = process.argv.includes('--continuar');
const modelo = arg('--modelo');
const esforco = arg('--esforco');
const leituras = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] !== '--ler') continue;
  const v = process.argv[i + 1];
  if (v && !v.startsWith('--')) leituras.push(v);
}

/* Um arquivo pode ser pedido como `caminho` ou `caminho:ini-fim`. Validamos que
 * existe antes de mandar, senao o Codex gasta turno descobrindo que nao existe. */
const alvos = [];
for (const item of leituras) {
  const m = String(item).match(/^(.+?)(?::(\d+)-(\d+))?$/u);
  const arquivo = m ? m[1] : item;
  const abs = path.isAbsolute(arquivo) ? arquivo : path.join(ROOT, arquivo);
  if (!fs.existsSync(abs)) falhar('arquivo nao existe: ' + arquivo);
  alvos.push({ arquivo, ini: m && m[2], fim: m && m[3] });
}

/* O prompt e' curto de proposito. O Codex le AGENTS.md e RACIOCINIO.md por
 * conta propria porque o cwd e' a raiz; nao repetimos o conteudo deles. */
const instrucoes = [
  'MODO RACIOCINIO. Nao edite nenhum arquivo.',
  '',
  'Leia RACIOCINIO.md (regras e fronteira de evidencia) e AGENTS.md',
  '(fronteiras do repositorio) antes de responder.',
  alvos.length
    ? '\nArquivos para ler:\n' + alvos.map(a => '  - ' + a.arquivo
      + (a.ini ? ' (linhas ' + a.ini + '-' + a.fim + ')' : '')).join('\n')
    : '',
  '',
  'Pergunta:',
  pergunta,
  '',
  'Na resposta, separe o que e MEDICAO (com a fonte), o que e LEITURA DE CODIGO',
  '(com arquivo:linha) e o que e PALPITE. Se a pergunta partir de uma premissa',
  'errada, diga isso em vez de responder dentro dela.',
].filter(l => l !== null).join('\n');

const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'];
if (continuar) args.push('resume', '--last');
if (modelo) args.push('-m', String(modelo));
if (esforco) args.push('-c', `model_reasoning_effort="${esforco}"`);
args.push(instrucoes);

console.log('[pensar] modelo: ' + (modelo || '(padrao do config)')
  + ' | sandbox: read-only' + (continuar ? ' | continuando sessao' : ''));
console.log('[pensar] cwd: ' + ROOT);
console.log('');

try {
  const saida = execFileSync(CODEX, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  /* O `codex exec` imprime cabecalho proprio (reasoning effort, session id,
   * banner do prompt). Filtramos para deixar so' a resposta. */
  const linhas = saida.split(/\r?\n/u);
  const corte = linhas.findIndex(l => /^codex$/u.test(l.trim()));
  const corpo = corte >= 0 ? linhas.slice(corte + 1) : linhas;
  const fim = corpo.findIndex(l => /^tokens used/u.test(l.trim()));
  console.log((fim >= 0 ? corpo.slice(0, fim) : corpo).join('\n').trim());
} catch (e) {
  const detalhe = (e.stdout || '') + (e.stderr || '');
  console.error('[pensar] falhou: ' + e.message);
  if (detalhe.trim()) console.error(detalhe.trim().slice(-3000));
  process.exit(1);
}
