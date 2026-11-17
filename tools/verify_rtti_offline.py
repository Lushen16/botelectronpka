"""Verificacao OFFLINE da hipotese RTTICompleteObjectLocator (MSVC x64).

Usa APENAS os 256 bytes ja salvos. Nao le o processo.

Layout esperado (24 bytes):
  +0x00  DWORD signature        (esperado 1)
  +0x04  DWORD offset
  +0x08  DWORD cdOffset
  +0x0C  DWORD pTypeDescriptor  (RVA)
  +0x10  DWORD pClassDescriptor (RVA)
  +0x14  DWORD pSelf            (RVA)
"""
import json, struct, io

P = r'local-data\binding-read-2026-11-09.json'
d = json.load(io.open(P, encoding='utf-8'))
base = int(d['base'], 16)

COL_SIZE = 24

for r in d['reads'][:3]:
    b = bytes.fromhex(r['hex'])
    own = int(r['rva'], 16)
    sig, off, cdoff, ptd, pcd, pself = struct.unpack_from('<6I', b, 0)

    print('=== %s @ %#x ===' % (r['name'], own))
    print('  signature        = %d  %s' % (sig, 'OK' if sig == 1 else 'INESPERADO'))
    print('  offset           = %d' % off)
    print('  cdOffset         = %d' % cdoff)
    print('  pTypeDescriptor  = %#x (RVA)' % ptd)
    print('  pClassDescriptor = %#x (RVA)' % pcd)
    print('  pSelf            = %#x (RVA)' % pself)
    print('  base + pSelf == proprio? %s  (%#x vs %#x)' % (
        base + pself == base + own, base + pself, base + own))
    print('  24 bytes restantes pertencem a outra estrutura? +0x18.. = %s'
          % b[COL_SIZE:COL_SIZE + 8].hex())
    print()

# reg1 tem pClassDescriptor DENTRO da janela lida (0x204fcd0 = reg1 + 0x28)
r1 = d['reads'][1]
b1 = bytes.fromhex(r1['hex'])
own1 = int(r1['rva'], 16)
pcd1 = struct.unpack_from('<I', b1, 0x10)[0]
delta = pcd1 - own1
print('=== ClassHierarchyDescriptor de reg1 ===')
print('  pClassDescriptor = %#x, delta do COL = +%#x' % (pcd1, delta))
if 0 <= delta and delta + 16 <= len(b1):
    sig, attr, nbase, pbase = struct.unpack_from('<4I', b1, delta)
    print('  signature        = %d  %s' % (sig, 'OK (esperado 0)' if sig == 0 else 'INESPERADO'))
    print('  attributes       = %#x' % attr)
    print('  numBaseClasses   = %d' % nbase)
    print('  pBaseClassArray  = %#x (RVA)' % pbase)
else:
    print('  fora da janela lida (precisa de leitura adicional)')
