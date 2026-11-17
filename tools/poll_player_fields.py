"""Polling passivo: o que a SETA muda?

Amostra campos do LocalPlayer a cada 20 ms por N segundos.
Somente Process_VM_Read. Nao envia tecla, nao captura foco.

Campos observados:
  +0xb4   direcao (dword)
  +0xcf6  flag autowalk (byte)
  +0xbf8  throttle timestamp (qword)
  +0xbe8  loop ativo (byte)
Posicao: procura x,y,z. Se o telemetrista estiver ativo, o objeto muda.

Uso:
  python tools/poll_player_fields.py <segundos>
Aperte a seta durante a coleta.
"""
import ctypes, struct, sys, time, os, json
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\poll-player-2026-11-09.json"

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
def u16(va):
    d = rd(va, 2); return struct.unpack('<H', d)[0] if len(d) == 2 else None
def u8(va):
    d = rd(va, 1); return d[0] if d else None

def snapshot():
    lp = u64(base + 0x39cb958)
    if not lp:
        return {'lp': None}
    return {
        'lp': lp,
        'dir': u32(lp + 0xb4),
        'autowalk': u8(lp + 0xcf6),
        'throttle': u64(lp + 0xbf8),
        'loop': u8(lp + 0xbe8),
        'sess': u16(lp + 0x164),
    }

print('base=%#x  pid=%d  dur=%.0fs' % (base, PID, SECONDS))
print('APERTE A SETA AGORA (a coleta comeca em 2 s)')
time.sleep(2)

samples = []
t0 = time.time()
while time.time() - t0 < SECONDS:
    s = snapshot()
    s['t'] = round(time.time() - t0, 3)
    samples.append(s)
    time.sleep(0.02)

k32.CloseHandle(ctypes.c_void_p(h))

# analise: quais campos MUDARAM
print()
print('=== campos que mudaram durante a coleta ===')
fields = ('dir', 'autowalk', 'throttle', 'loop', 'sess')
for f in fields:
    vals = [s.get(f) for s in samples if f in s]
    uniq = sorted(set(v for v in vals if v is not None))
    changed = len(uniq) > 1
    print('  %-9s valores=%s  %s' % (f, [x if not isinstance(x, int) or x < 1e12 else hex(x) for x in uniq[:6]],
                                     '<<< MUDOU' if changed else ''))

print()
print('=== transicoes (so as que mudam) ===')
prev = None
for s in samples:
    key = tuple(s.get(f) for f in fields)
    if prev is not None and key != prev[0]:
        print('  t=%6.3fs  dir=%s autowalk=%s throttle=%s loop=%s sess=%s' % (
            s['t'], s.get('dir'), s.get('autowalk'), s.get('throttle'),
            s.get('loop'), s.get('sess')))
    prev = (key, s)

json.dump({'pid': PID, 'base': hex(base), 'samples': samples},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print()
print('amostras: %d  artefato: %s' % (len(samples), OUT))
