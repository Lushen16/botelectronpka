"""Quem CHAMA 0x3007c0 (a funcao de init que escreve o gate)?

Se ela nunca e' chamada em runtime, o gate fica 0 e o lambda_6 nunca registra.
"""
import ctypes, struct, os, time, json
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
FUNC = 0x3007c0
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\init-callers-2026-11-09.json"

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
base = 0; size = 0
if k32.Module32FirstW(ctypes.c_void_p(snap), ctypes.byref(me)):
    while True:
        if me.szModule.lower() == 'pokealliance_dx.exe':
            base = int(me.modBaseAddr); size = int(me.modBaseSize); break
        if not k32.Module32NextW(ctypes.c_void_p(snap), ctypes.byref(me)):
            break
k32.CloseHandle(ctypes.c_void_p(snap))

h = k32.OpenProcess(0x10 | 0x1000, False, PID)
def rd(rva, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(base + rva),
                               buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''

# 1) E8 rel32 -> 0x3007c0
calls = []
off = 0x1000
END = 0x1000 + 0x1a3b00c
while off < END:
    n = min(4 << 20, END - off)
    d = rd(off, n)
    if not d:
        off += n; continue
    i = d.find(b'\xe8')
    while i >= 0 and i + 5 <= len(d):
        rel = struct.unpack_from('<i', d, i + 1)[0]
        if (off + i) + 5 + rel == FUNC:
            calls.append(off + i)
        i = d.find(b'\xe8', i + 1)
    off += n

# 2) ponteiro absoluto (registro como callback / vtable)
ptr = struct.pack('<Q', base + FUNC)
ptrs = []
for s, e in ((0x1a3d000, 0x1a3d000 + 0x83604c),
             (0x2274000, 0x2274000 + 0x17af5f0)):
    off = s
    while off < e:
        n = min(4 << 20, e - off)
        d = rd(off, n)
        if not d:
            off += n; continue
        j = d.find(ptr)
        while j >= 0:
            ptrs.append(off + j)
            j = d.find(ptr, j + 1)
        off += n

k32.CloseHandle(ctypes.c_void_p(h))

json.dump({'pid': PID, 'base': hex(base), 'func': hex(FUNC),
           'calls': [hex(x) for x in calls],
           'pointers': [hex(x) for x in ptrs]},
          open(OUT, 'w', encoding='utf-8'), indent=1)

print('=== quem chama 0x%x ===' % FUNC)
print('  E8 rel32 : %s' % ([hex(x) for x in calls] or 'NENHUM'))
print('  ponteiro : %s' % ([hex(x) for x in ptrs] or 'NENHUM'))
print('artefato:', OUT)
