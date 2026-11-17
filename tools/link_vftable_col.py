"""Demonstra a cadeia 0x37bc40 -> vftable -> COL -> TypeDescriptor -> nome."""
import json, io

d1 = json.load(io.open(r'local-data\binding-read-2026-11-09.json', encoding='utf-8'))
base = int(d1['base'], 16)

RECORDS = [
    ('reg0', 0x1f899d8, [0x204ff70, 0x37bd00, 0x37bd00, 0x37bc40, 0x37bc30, 0x318930, 0x3186c0]),
    ('reg1', 0x1f89a10, [0x204fca8, 0x37bc20, 0x37bc20, 0x37bbb0, 0x37bba0, 0x318930, 0x3186c0]),
]
COLS = {
    0x204ff70: (0x22fe590, 'lambda_6 bool(TPoint<int> const&, Fw::MouseButton)'),
    0x204fca8: (0x22fe6e0, 'lambda_7 bool(TPoint<int> const&, TPoint<int> const&)'),
    0x204fbf0: (0x22fe610, 'lambda_2 void()'),
}

print('=== reg0: vftable completa ===')
name, rec, vals = RECORDS[0]
print('  vtable[-1] (COL)  @ %#x  -> RVA %#x' % (rec, vals[0]))
print('  address point     @ %#x' % (rec + 8))
for i, fn in enumerate(vals[1:]):
    print('    [%d] %#x%s' % (i, fn, '   <=== 0x37bc40' if fn == 0x37bc40 else ''))

idx = vals.index(0x37bc40) - 1
col = vals[0]
td, desc = COLS[col]
print()
print('=== CADEIA FECHADA ===')
print('  0x37bc40              = vftable[%d]' % idx)
print('  vftable address point = %#x  (registro %#x + 8)' % (rec + 8, rec))
print('  COL                   = %#x  (RVA %#x)' % (rec, col))
print('  pTypeDescriptor       = %#x  (RVA)' % td)
print('  nome                  = %s' % desc)
print()
print('=== consistencia nos 3 registros ===')
for n, r, v in RECORDS:
    print('  %s: [-1]=%#x conhecido=%s' % (n, v[0], v[0] in COLS))
print('  reg2: [-1]=0x204fbf0 conhecido=True (lido na rodada anterior)')
print()
print('=== ordem dos slots e o contrato ===')
for n, r, v in RECORDS:
    print('  %s: %s' % (n, [hex(x) for x in v[1:]]))
