'use strict';

/**
 * Sonda crua do pipe: conecta, le o que o servidor mandar e NAO autentica.
 *
 *   node tools/tap_probe_raw.cjs --pid 19792
 *
 * Serve para responder uma pergunta binaria: o servidor do fornecedor fala
 * nesse pipe agora? Se ele manda challenge (kind 1) e o tap nao gravou nada,
 * o hook esta quebrado. Se ele nao manda nada, a captura vazia era ausencia de
 * trafego, nao falha do tap.
 *
 * Nao envia comando. Desconecta em seguida.
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
let pid = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--pid') pid = Number(argv[++i]);
}
if (!pid) {
  console.log('uso: node tools/tap_probe_raw.cjs --pid <pid do jogo>');
  process.exitCode = 1;
  return;
}

const pipe = `\\\\.\\pipe\\pka-runtime-2-${pid}`;
console.log('conectando em ' + pipe);

const socket = net.createConnection(pipe);
let buffer = Buffer.alloc(0);
let frames = 0;
const started = Date.now();

socket.on('connect', () => console.log('conectado'));

socket.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (buffer.length < 8) break;
    const len = buffer.readUInt32LE(0);
    const kind = buffer.readUInt32LE(4);
    if (len > 2105344) {
      console.log(`header invalido: len=${len} kind=${kind} (nao e o protocolo)`);
      buffer = Buffer.alloc(0);
      break;
    }
    if (buffer.length < 8 + len) break;
    const payload = buffer.subarray(8, 8 + len);
    frames++;
    const preview = payload.subarray(0, 24).toString('hex');
    console.log(`frame ${frames}: kind=${kind} len=${len} payload=${preview}`);
    buffer = buffer.subarray(8 + len);
  }
});

socket.on('error', error => {
  console.log('erro: ' + error.message + ' (' + (error.code || 'sem code') + ')');
});

socket.on('close', () => {
  const ms = Date.now() - started;
  console.log(`fechado apos ${ms}ms, ${frames} frames`);

  /* correlaciona com o log do tap */
  for (const dir of [path.join(__dirname, '..', 'native'), require('node:os').tmpdir()]) {
    const file = path.join(dir, `pka_tap_${pid}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    console.log(`tap log: ${file} (${size} bytes)`);
    if (frames > 0 && size === 0) {
      console.log('DIAGNOSTICO: servidor falou e o tap NAO gravou -> hook quebrado');
    } else if (frames === 0) {
      console.log('DIAGNOSTICO: servidor nao falou nada -> instancia orfa, sem trafego');
    } else {
      console.log('DIAGNOSTICO: servidor falou e o tap gravou -> hook OK');
    }
    break;
  }
});

setTimeout(() => socket.destroy(), 6000);
