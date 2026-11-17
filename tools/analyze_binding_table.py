"""Analise offline da tabela de binding em .rdata (dados da rodada anterior).

NAO le o processo. Usa os 20 slots ja registrados.
Objetivo: determinar a estrutura (registro de N ponteiros) e as colunas.
"""

STRIDE = 0x38            # 7 ponteiros
SEQ = [
 (0x1f899d8, 0x204ff70), (0x1f899e0, 0x37bd00), (0x1f899e8, 0x37bd00),
 (0x1f899f0, 0x37bc40), (0x1f899f8, 0x37bc30), (0x1f89a00, 0x318930),
 (0x1f89a08, 0x3186c0),
 (0x1f89a10, 0x204fca8), (0x1f89a18, 0x37bc20), (0x1f89a20, 0x37bc20),
 (0x1f89a28, 0x37bbb0), (0x1f89a30, 0x37bba0), (0x1f89a38, 0x318930),
 (0x1f89a40, 0x3186c0),
 (0x1f89a48, 0x204fbf0),
]

SECTIONS = [('text', 0x1000, 0x1a3b00c), ('rdata', 0x1a3d000, 0x83604c),
            ('data', 0x2274000, 0x17af5f0)]

def sec(rva):
    for n, a, s in SECTIONS:
        if a <= rva < a + s:
            return n
    return '?'

base = SEQ[0][0]
print('base do 1o registro: %#x' % base)
print('stride verificado: %#x -> %#x = %#x' % (base, SEQ[7][0], SEQ[7][0] - base))
print()

records = {}
for addr, rva in SEQ:
    idx = (addr - base)
    rec, off = divmod(idx, STRIDE)
    records.setdefault(rec, {})[off] = rva

for rec in sorted(records):
    print('registro %d @ %#x' % (rec, base + rec * STRIDE))
    for off in sorted(records[rec]):
        rva = records[rec][off]
        print('   +0x%02x  %#010x  %-5s' % (off, rva, sec(rva)))
    print()

print('=== colunas ===')
cols = {}
for rec in records:
    for off, rva in records[rec].items():
        cols.setdefault(off, []).append((rec, rva))
FUNC_COLS = {0x08, 0x10, 0x18, 0x20, 0x28, 0x30}
for off in sorted(cols):
    vals = cols[off]
    uniq = sorted(set(v for _, v in vals))
    same = 'IDENTICO entre registros' if len(uniq) == 1 and len(vals) > 1 else 'difere'
    print('  +0x%02x  n=%d  unicos=%s  %s' % (off, len(vals), [hex(v) for v in uniq], same))

print()
print('=== leitura ===')
print('registro = 7 ponteiros (0x38). O 3o registro comeca em 0x1f89a48')
print('(base + 2*0x38), coerente com array contiguo.')
print()
print('coluna +0x00: aponta para .rdata (dado/string), unico por registro')
print('coluna +0x08 e +0x10: par identico DENTRO do registro (factory?)')
print('coluna +0x18: handler distinto por registro (0x37bc40 / 0x37bbb0)')
print('coluna +0x20: getter distinto por registro (0x37bc30 / 0x37bba0)')
print('coluna +0x28 e +0x30: COMPARTILHADOS (0x318930 / 0x3186c0)')
