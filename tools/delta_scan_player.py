"""Delta scan: quais bytes do objeto LocalPlayer mudam durante a acao?

Amostra os primeiros N bytes do LocalPlayer duas vezes por ciclo e registra
quais offsets mudaram. Nao interpreta semantica antes de saber o que muda.

Somente leitura. Nao envia tecla.
"""
import ctypes, struct, sys, time, os, json
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
SECONDS = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
SIZE = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0x1000
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\delta-scan-2026-11-09.json"

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

lp = struct.unpack('<Q', rd(base + 0x39cb958, 8))[0]
print('LocalPlayer = %#x  size=0x%x  dur=%.0fs' % (lp, SIZE, SECONDS))
if not lp:
    print('SEM LocalPlayer'); raise SystemExit(2)

print('APERTE A SETA AGORA (coleta em 2 s)')
time.sleep(2)

first = rd(lp, SIZE)
if len(first) != SIZE:
    print('leitura inicial falhou'); raise SystemExit(2)

changed = [0] * SIZE     # contagem de mudancas por offset
t0 = time.time()
n = 0
while time.time() - t0 < SECONDS:
    cur = rd(lp, SIZE)
    if len(cur) == SIZE:
        for i in range(SIZE):
            if cur[i] != first[i]:
                changed[i] += 1
        n += 1
    time.sleep(0.02)

k32.CloseHandle(ctypes.c_void_p(h))

offsets = [i for i, c in enumerate(changed) if c > 0]
print()
print('=== %d amostras. offsets que mudaram: %d ===' % (n, len(offsets)))

# agrupar offsets contiguos em regioes
regions = []
if offsets:
    s = prev = offsets[0]
    for o in offsets[1:]:
        if o == prev + 1:
            prev = o
        else:
            regions.append((s, prev)); s = prev = o
    regions.append((s, prev))

print()
print('=== regioes que mudaram (offset inicial, tamanho, contagem maxima) ===')
for a, b in regions:
    mx = max(changed[a:b + 1])
    print('  +0x%04x .. +0x%04x  (%d B)  mudou ate %d/%d vezes' % (a, b, b - a + 1, mx, n))

json.dump({'pid': PID, 'base': hex(base), 'localPlayer': hex(lp), 'size': SIZE,
           'samples': n,
           'regions': [{'start': hex(a), 'end': hex(b), 'size': b - a + 1,
                        'maxChanges': max(changed[a:b + 1])} for a, b in regions],
           'changedOffsets': offsets},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print()
print('artefato:', OUT)
