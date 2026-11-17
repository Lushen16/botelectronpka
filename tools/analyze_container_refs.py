"""Analisa as 14 referencias ao container e localiza quem ITERA a lista +0x2c0.

Para cada xref: qual funcao contem, e ela toca +0x2c0?
"""
import ctypes, struct, os
from ctypes import wintypes
import capstone

PID = int(os.environ.get("TARGET_PID", "28500"))

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
def rd(rva, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(base + rva),
                               buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''

# .pdata -> limites exatos de funcao
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

def owner(rva):
    best = None
    for b, en in ranges:
        if b <= rva < en and (best is None or b > best[0]):
            best = (b, en)
    return best

XREFS = [0x37a774, 0x37a780, 0x37a98f, 0x37aa1d, 0x37b3e4, 0x37b448,
         0x37b4ac, 0x37b79d, 0x37bc54, 0x37bd34, 0x37bede, 0x37bf80,
         0x37bfde, 0x37bfea]

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)

print('=== funcao dona de cada xref ===')
funcs = {}
for x in XREFS:
    o = owner(x)
    key = o[0] if o else None
    funcs.setdefault(key, []).append(x)
    print('  %#010x -> funcao %s' % (x, ('%#x..%#x' % o) if o else '?'))
print()

print('=== em cada funcao, ha acesso a +0x2c0? ===')
for start in sorted(k for k in funcs if k is not None):
    if start is None:
        continue
    o = owner(start)
    body = rd(start, o[1] - start)
    has_2c0 = False
    sample = []
    for ins in md.disasm(body, start):
        s = ins.mnemonic + ' ' + ins.op_str
        if '0x2c0' in s:
            has_2c0 = True
            if len(sample) < 3:
                sample.append((hex(ins.address), s))
    print('  funcao %#x..%#x  size=%d  +0x2c0=%s %s' % (
        o[0], o[1], o[1] - o[0], 'SIM' if has_2c0 else 'nao',
        sample if sample else ''))

