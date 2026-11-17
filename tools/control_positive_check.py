"""CONTROLE POSITIVO: o relogio do jogo muda? O objeto do player muda?

Se o relogio (0x398cdd0, contador de alta frequencia documentado) NAO mudar,
meu metodo de leitura esta errado. Se mudar e o player nao mudar, o achado
e' real: aquele objeto e' estatico nesse estado.

Tambem verifica se o ponteiro [0x39cb958] permanece o mesmo.
"""
import ctypes, struct, time, os, json
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
DUR = 6.0
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\control-check-2026-11-09.json"

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

print('base = %#x' % base)
print()
print('t     clock[0x398cdd0]      playerPtr            player[0xb4] [0xcf6] [0x164]')
t0 = time.time()
clock0 = u64(base + 0x398cdd0)
lp0 = u64(base + 0x39cb958)
while time.time() - t0 < DUR:
    clk = u64(base + 0x398cdd0)
    lp = u64(base + 0x39cb958)
    d = rd(lp + 0xb4, 4) if lp else b''
    aw = rd(lp + 0xcf6, 1) if lp else b''
    se = rd(lp + 0x164, 2) if lp else b''
    print('%.2f  %-20s %-20s %-10s %-7s %s' % (
        time.time() - t0,
        hex(clk) if clk is not None else '?',
        hex(lp) if lp else 'NULL',
        struct.unpack('<I', d)[0] if len(d) == 4 else '?',
        aw[0] if aw else '?',
        struct.unpack('<H', se)[0] if len(se) == 2 else '?'))
    time.sleep(0.5)

clk1 = u64(base + 0x398cdd0)
lp1 = u64(base + 0x39cb958)
k32.CloseHandle(ctypes.c_void_p(h))

print()
print('=== veredito do controle ===')
print('  clock mudou?  %s  (%s -> %s)' % (
    clk1 != clock0, hex(clock0) if clock0 is not None else '?',
    hex(clk1) if clk1 is not None else '?'))
print('  ponteiro do player mudou? %s' % (lp1 != lp0))
if clk1 == clock0:
    print('  >>> METODO SUSPEITO: nem o relogio mudou. Leitura pode estar congelada.')
elif lp1 != lp0:
    print('  >>> OBJETO SUBSTITUIDO: o ponteiro mudou; delta scan anterior usou objeto velho.')
else:
    print('  >>> METODO OK e ponteiro estavel: o objeto nao mudou em 15 s. Achado real.')

json.dump({'pid': PID, 'base': hex(base), 'clock0': hex(clock0) if clock0 else None,
           'clock1': hex(clk1) if clk1 else None, 'clockChanged': clk1 != clock0,
           'lp0': hex(lp0) if lp0 else None, 'lp1': hex(lp1) if lp1 else None,
           'lpChanged': lp1 != lp0},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print('artefato:', OUT)
