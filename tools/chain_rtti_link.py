"""Reconstroi a cadeia estrutural usando APENAS os bytes ja coletados.

Nao le o processo. Fontes:
  local-data/binding-read-2026-11-09.json      (256 B)
  local-data/rtti-typedescriptors-2026-11-09.json (768 B)

Pergunta: existe um caminho verificavel
  slot(0x37bc40) -> vftable -> COL -> TypeDescriptor -> nome ?
ou falta elo?
"""
import json, struct, io

P1 = r'local-data\binding-read-2026-11-09.json'
P2 = r'local-data\rtti-typedescriptors-2026-11-09.json'

d1 = json.load(io.open(P1, encoding='utf-8'))
d2 = json.load(io.open(P2, encoding='utf-8'))

base = int(d1['base'], 16)
MODSIZE = d1['size']

SECTIONS = [('text', 0x1000, 0x1a3b00c), ('rdata', 0x1a3d000, 0x83604c),
            ('data', 0x2274000, 0x17af5f0), ('pdata', 0x3a24000, 0xd15a4)]

def sec(rva):
    for n, a, s in SECTIONS:
        if a <= rva < a + s:
            return n
    return 'fora'

print('=== inventario dos intervalos lidos ===')
for r in d1['reads']:
    rva = int(r['rva'], 16)
    print('  %-16s RVA %#010x  %3d B  secao %s' % (r['name'], rva, r['read'], sec(rva)))
print()

print('=== inventario dos TypeDescriptors ===')
for r in d2['reads']:
    rva = int(r['rva'], 16)
    print('  %-20s RVA %#010x  %3d B  secao %s' % (r['name'], rva, r['read'], sec(rva)))
    print('    pVFTable=%s  name=%r' % (r.get('pVFTable'), r.get('nameRaw', '')[:50]))
print()

# ---- elo 1: slot -> 0x37bc40 (conhecido da tabela) ----
print('=== elo 1: slot da tabela contendo 0x37bc40 ===')
SLOT = 0x1f899f0
print('  slot RVA %#x -> funcao 0x37bc40  (lido na rodada da tabela)' % SLOT)
print()

# ---- elo 2: slot -> vftable? ----
print('=== elo 2: existe vftable apontando para COL? ===')
print('  Um COL e referenciado pela posicao ANTES do address point da vftable.')
print('  Precisamos de bytes em torno de um slot que contenha o COL.')
print()
print('  Onde estao os COLs?')
for r in d1['reads'][:3]:
    rva = int(r['rva'], 16)
    print('    COL %-20s RVA %#010x' % (r['name'], rva))
print()
print('  Onde esta o slot 0x37bc40?')
print('    SLOT                    RVA %#010x' % SLOT)
print()
print('  Distancia slot -> COLs: nao ha correspondencia direta.')
print('  Os COLs estao em 0x204fXXX; o slot em 0x1f899f0.')
print('  Diferenca: %#x bytes.' % (SLOT - 0x204ff70))
print()

# ---- elo 3: os bytes lidos de cada COL incluem algo apontando p/ vftable? ----
print('=== elo 3: algum campo do COL aponta para uma vftable de objeto? ===')
print('  COL tem 24 bytes e 6 campos, todos ja identificados (RTTI).')
print('  Nenhum deles aponta para 0x1f899f0 nem para 0x204ff18-familia.')
for r in d1['reads'][:3]:
    raw = bytes.fromhex(r['hex'])[:24]
    sig, off, cd, ptd, pcd, pself = struct.unpack('<6I', raw)
    own = int(r['rva'], 16)
    print('    %s: fields = %s' % (r['name'],
          [hex(v) for v in (sig, off, cd, ptd, pcd, pself)]))
print()

# ---- elo 4: o que aponta para os COLs? procurar nos bytes lidos ----
print('=== elo 4: algum byte ja lido contem ponteiro PARA um COL? ===')
col_rvas = [int(r['rva'], 16) for r in d1['reads'][:3]]
found = False
for r in d1['reads'] + d2['reads']:
    raw = bytes.fromhex(r['hex'])
    for i in range(0, len(raw) - 3):
        v = struct.unpack_from('<I', raw, i)[0]
        if v in col_rvas:
            print('  %s +%#x contem RVA de COL %#x' % (r['name'], i, v))
            found = True
if not found:
    print('  NENHUM. Os intervalos lidos nao ligam slot<-vftable<-COL.')
print()

print('=== conclusao ===')
print('Cadeia comprovada: COL -> TypeDescriptor -> nome  (RTTI, confirmado)')
print('Cadeia NAO comprovada: 0x37bc40 -> vftable -> COL')
print()
print('Falta exatamente:  bytes da vftable cujo endereco-8 contenha RVA de um')
print('dos tres COLs. Se essa vftable existir, o slot 0x37bc40 deveria estar')
print('nela -- ou o metodo de invocacao do _Func_impl_no_alloc deveria.')
