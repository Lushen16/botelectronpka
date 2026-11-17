"""ETAPA 3+4: o "wrapper" 0x7b6346 e' inicio de funcao? Quem chama a funcao real?

Se 0x7b6346 nao estiver em .pdata como inicio, o wrapper faz parte de uma
funcao maior e meus xrefs foram para o lugar errado.
"""
import ctypes, struct, os, json
from ctypes import wintypes
import capstone

PID = int(os.environ.get("TARGET_PID", "28500"))
WRAP = 0x7b6346
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\wrapper-func-2026-11-09.json"

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

# .pdata
head = rd(0, 0x400)
e = struct.unpack_from('<I', head, 0x3C)[0]
nsec = struct.unpack_from('<H', head, e + 6)[0]
optsz = struct.unpack_from('<H', head, e + 20)[0]
opt = e + 24
magic = struct.unpack_from('<H', head, opt)[0]
dd = opt + (112 if magic == 0x20b else 96)
exc_rva, exc_sz = struct.unpack_from('<II', head, dd + 3 * 8)
pdata = rd(exc_rva, min(exc_sz, 2000000))
ranges = []
for i in range(0, len(pdata) - 11, 12):
    b, en, u = struct.unpack_from('<III', pdata, i)
    if b and en > b:
        ranges.append((b, en))

starts = {b: en for b, en in ranges}
print('=== ETAPA 3: 0x%x e inicio de funcao? ===' % WRAP)
print('  em .pdata como inicio: %s' % (WRAP in starts))
owner = None
for b, en in ranges:
    if b <= WRAP < en:
        owner = (b, en); break
print('  funcao que o contem: %s' % ('%#x..%#x (size %d)' % (owner[0], owner[1], owner[1]-owner[0]) if owner else '?'))
print('  offset dentro: %s' % (hex(WRAP - owner[0]) if owner else '?'))

print()
print('=== ETAPA 4: chamadores da FUNCAO REAL (%#x) ===' % (owner[0] if owner else 0))
T = owner[0] if owner else WRAP
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
        if (off + i) + 5 + rel == T:
            calls.append(off + i)
        i = d.find(b'\xe8', i + 1)
    off += n
print('  E8 -> %#x : %s' % (T, [hex(x) for x in calls[:12]] or 'NENHUM'))

# ponteiro
ptr = struct.pack('<Q', base + T)
ptrs = []
for s, ee in ((0x1a3d000, 0x1a3d000 + 0x83604c), (0x2274000, 0x2274000 + 0x17af5f0)):
    off = s
    while off < ee:
        n = min(4 << 20, ee - off)
        d = rd(off, n)
        if not d:
            off += n; continue
        j = d.find(ptr)
        while j >= 0:
            ptrs.append(off + j); j = d.find(ptr, j + 1)
        off += n
print('  ponteiro : %s' % ([hex(x) for x in ptrs[:12]] or 'NENHUM'))

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
print()
print('=== inicio real da funcao ===')
for ins in md.disasm(rd(T, 48), T):
    m = ' <<< call C' if ins.address == 0x7b6381 else ''
    print('  %-10s %-42s%s' % (hex(ins.address), ins.mnemonic + ' ' + ins.op_str, m))

k32.CloseHandle(ctypes.c_void_p(h))
json.dump({'pid': PID, 'base': hex(base), 'wrapper': hex(WRAP),
           'isFuncStart': WRAP in starts,
           'funcRange': [hex(owner[0]), hex(owner[1])] if owner else None,
           'calls': [hex(x) for x in calls], 'pointers': [hex(x) for x in ptrs]},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print('artefato:', OUT)
