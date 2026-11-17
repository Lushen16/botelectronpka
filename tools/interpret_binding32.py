import json, struct, io

P = r'local-data\binding-read-2026-11-09.json'
d = json.load(io.open(P, encoding='utf-8'))
base = int(d['base'], 16)
MODSIZE = d['size']

SECTIONS = [('text', 0x1000, 0x1a3b00c), ('rdata', 0x1a3d000, 0x83604c),
            ('data', 0x2274000, 0x17af5f0), ('pdata', 0x3a24000, 0xd15a4),
            ('_RDATA', 0x3af6000, 0x13208)]

def sec(rva):
    for n, a, s in SECTIONS:
        if a <= rva < a + s:
            return n
    return 'ext' if 0 <= rva < MODSIZE else 'fora'

for r in d['reads']:
    b = bytes.fromhex(r['hex'])
    if len(b) < 64:
        continue
    q = struct.unpack('<16I', b)   # 16 DWORDs = 64 bytes
    print('=== %s @ %s  (interpretado como 16 x DWORD) ===' % (r['name'], r['rva']))
    for i, v in enumerate(q):
        tag = ''
        if 0 < v < MODSIZE:
            tag = 'RVA -> %s' % sec(v)
        print('  +0x%02x  %#010x  %s' % (i * 4, v, tag))
    print()
