import json, struct, io

P = r'local-data\binding-read-2026-11-09.json'
d = json.load(io.open(P, encoding='utf-8'))
base = int(d['base'], 16)

SECTIONS = [('text', 0x1000, 0x1a3b00c), ('rdata', 0x1a3d000, 0x83604c),
            ('data', 0x2274000, 0x17af5f0), ('pdata', 0x3a24000, 0xd15a4)]

def sec(rva):
    for n, a, s in SECTIONS:
        if a <= rva < a + s:
            return n
    return 'OUT'

for r in d['reads']:
    if r['name'].startswith('shared'):
        continue
    b = bytes.fromhex(r['hex'])
    print('=== %s  (%s, %d bytes) ===' % (r['name'], r['rva'], len(b)))
    for i in range(0, len(b), 16):
        chunk = b[i:i+16]
        hexs = ' '.join('%02x' % x for x in chunk)
        asci = ''.join(chr(x) if 32 <= x < 127 else '.' for x in chunk)
        qwords = []
        for j in range(0, len(chunk) - 7, 8):
            q = struct.unpack_from('<Q', chunk, j)[0]
            if q > 0x1000:
                rva = q - base
                qwords.append('+%02x:%#x(%s)' % (i+j, q, sec(rva) if 0 <= rva < 0x7000000 else 'ext'))
        print('  %04x  %-47s %-16s %s' % (i, hexs, asci, ' '.join(qwords)))
    print()
