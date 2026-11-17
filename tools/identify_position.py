"""Identifica quais offsets do LocalPlayer sao x/y/z.

FECHADO em 2026-11-09: NAO e' nenhum dos 5 trios que este script testava.

  LocalPlayer+0x20 = int32 x
  LocalPlayer+0x24 = int32 y
  LocalPlayer+0x28 = uint8 z

Evidencia:
  1. delta-scan2 (972 amostras, COM seta, relogio vivo andou):
     +0x20 mudou 877/972, mesma taxa de +0xb4 (direcao, 878/972).
  2. Mesma struct duplicada em dois objetos independentes (RPM ao vivo):
       LocalPlayer+0x20 -> da 0c 00 00 | f3 07 00 00 | 07   (3290, 2035, 7)
       Tile+0x68        -> da 0c 00 00 | f3 07 00 00 | 07   (idem)
     Tile = [[LocalPlayer]+0x9a8], RTTI .?AVTile@@ confirmado.
  3. z=7 bate com os fixtures do botfinal (pos {x,y,z:7}).

Os candidatos antigos eram ruido:
  +0x980, +0xa48, +0xe38  -> inteiros tipo 0x3f9430 (ids/contadores), NAO posicao
  +0x9a8, +0x9b0          -> par shared_ptr<Tile> (refcount), NAO posicao
                             ja documentado em docs/NATIVE_EXECUTOR_CONTRACT.md

Uso:
  python tools/identify_position.py 12
Aperte e segure a seta quando aparecer o aviso.
Agora le a posicao real + os candidatos antigos, para voce ver a diferenca.
"""
import ctypes, struct, sys, time
from ctypes import wintypes

PID = int(__import__('os').environ.get("TARGET_PID", "28500"))
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 12.0
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\pos-id-2026-11-09.json"
CLOCK = 0x3991490

OFF_X, OFF_Y, OFF_Z = 0x20, 0x24, 0x28

# mantidos apenas para contraste: prova visual de que NAO sao posicao
LEGACY = [
    ('0x980', 0x980),
    ('0xa48', 0xa48),
    ('0xe38', 0xe38),
]

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE

class ME(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('th32ModuleID', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('GlblcntUsage', wintypes.DWORD),
                ('ProccntUsage', wintypes.DWORD), ('modBaseAddr', ctypes.c_void_p),
                ('modBaseSize', wintypes.DWORD), ('hModule', wintypes.HMODULE),
                ('szModule', wintypes.WCHAR * 256), ('szExePath', wintypes.WCHAR * 260)]

snap = k32.CreateToolhelp32Snapshot(0x8 | 0x10, PID)
me = ME(); me.dwSize = ctypes.sizeof(ME)
base = 0
if k32.Module32FirstW(ctypes.c_void_p(snap), ctypes.byref(me)):
    while True:
        if me.szModule.lower() == 'pokealliance_dx.exe':
            base = int(me.modBaseAddr); break
        if not k32.Module32NextW(ctypes.c_void_p(snap), ctypes.byref(me)):
            break
k32.CloseHandle(ctypes.c_void_p(snap))

h = k32.OpenProcess(0x10 | 0x1000, False, PID)
def rd(va, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(va),
                               buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''
def u64(va):
    d = rd(va, 8); return struct.unpack('<Q', d)[0] if len(d) == 8 else None
def u32(va):
    d = rd(va, 4); return struct.unpack('<I', d)[0] if len(d) == 4 else None

lp = u64(base + 0x39cb958)
if not lp:
    print('SEM LocalPlayer'); raise SystemExit(2)

def position():
    d = rd(lp + OFF_X, 12)
    if len(d) < 12: return None
    x, y = struct.unpack('<ii', d[0:8])
    return (x, y, d[8])

print('base=%#x  LocalPlayer=%#x  dur=%.0fs' % (base, lp, SECONDS))
print('APERTE E SEGURE A SETA AGORA (coleta em 2 s)')
time.sleep(2)

t0 = time.time()
rows = []
while time.time() - t0 < SECONDS:
    dirv = rd(lp + 0xb4, 4)
    row = {'t': round(time.time() - t0, 2),
           'dir': struct.unpack('<I', dirv)[0] if len(dirv) == 4 else None,
           'clk': u64(base + CLOCK),
           'pos': position()}
    for name, off in LEGACY:
        row[name] = u32(lp + off)
    rows.append(row)
    time.sleep(0.1)

k32.CloseHandle(ctypes.c_void_p(h))

print()
print('=== POSICAO REAL (LocalPlayer+0x20) ===')
xs = [r['pos'][0] for r in rows if r['pos']]
ys = [r['pos'][1] for r in rows if r['pos']]
zs = [r['pos'][2] for r in rows if r['pos']]
print('  x: %s .. %s   (%d valores unicos)' % (xs[0], xs[-1], len(set(xs))) if xs else '  x: ?')
print('  y: %s .. %s   (%d valores unicos)' % (ys[0], ys[-1], len(set(ys))) if ys else '  y: ?')
print('  z: %s        (%d valores unicos)' % (sorted(set(zs)), len(set(zs))) if zs else '  z: ?')

print()
print('=== candidatos antigos (contraste: sao ids/contadores) ===')
for name, _ in LEGACY:
    vals = sorted({r[name] for r in rows if r.get(name) is not None})
    print('  %-6s -> %s' % (name, vals[:6]))

print()
print('=== direcao ===')
print('  dir unicos: %s' % sorted({r['dir'] for r in rows if r['dir'] is not None}))

print()
print('=== amostra crua (12 linhas) ===')
print('  t     dir  pos(x,y,z)          clk')
step = max(1, len(rows) // 12)
for r in rows[::step][:12]:
    print('  %-5s %-4s %-20s %s' % (
        r['t'], r['dir'],
        str(r['pos']) if r['pos'] else '?',
        hex(r['clk']) if r['clk'] else '?'))

import json
json.dump({'pid': PID, 'base': hex(base), 'localPlayer': hex(lp),
           'offsets': {'x': hex(OFF_X), 'y': hex(OFF_Y), 'z': hex(OFF_Z)},
           'rows': rows},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print()
print('artefato:', OUT)
