"""Varredura por BYTES: escritas mov [reg+0xb4], r32 / r64.

Opcode 0x89 (mov r/m32, r32):
  modrm mod=01 (disp8) -> bytes: 89 MM B4       (MM bits 7-6 = 01)
  modrm mod=10 (disp32)-> bytes: 89 MM B4 00 00 00
Opcode 0xC7 (mov r/m32, imm32):
  mod=01 -> C7 MM B4 imm32
Adiciona prefixo REX 0x48 para qword.
"""
import ctypes, struct, os, json
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\dir-writes-bytes-2026-11-09.json"

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

TEXT_START, TEXT_END = 0x1000, 0x1000 + 0x1a3b00c
CH, OV = 4 << 20, 12
hits = []
off = TEXT_START
tail = b''
while off < TEXT_END:
    n = min(CH, TEXT_END - off)
    d = rd(off, n)
    if not d:
        off += n; continue
    buf = tail + d
    bb = off - len(tail)

    for i in range(len(buf) - 3):
        # optional REX prefix
        j = i
        rex = 0
        if 0x40 <= buf[i] <= 0x4F:
            rex = 1
            j = i + 1
            if j >= len(buf):
                continue
        op = buf[j]
        if op not in (0x89, 0xC7):
            continue
        if j + 1 >= len(buf):
            continue
        modrm = buf[j + 1]
        mod = modrm >> 6
        rm = modrm & 7
        if mod != 1 or rm == 4:      # disp8, sem SIB
            continue
        if j + 2 >= len(buf):
            continue
        if buf[j + 2] != 0xB4:
            continue
        insn_rva = bb + i
        o = owner(insn_rva)
        hits.append({'insn': hex(insn_rva), 'rex': bool(rex),
                     'opcode': hex(op),
                     'func': hex(o[0]) if o else None})
    tail = d[-OV:]
    off += n

k32.CloseHandle(ctypes.c_void_p(h))

seen = set(); uniq = []
for hh in hits:
    if hh['insn'] in seen: continue
    seen.add(hh['insn']); uniq.append(hh)

print('=== escritas mov [reg+0xb4], r32/r64 : %d ===' % len(uniq))
funcs = {}
for hh in uniq:
    funcs.setdefault(hh['func'], []).append(hh)
for f in sorted(funcs, key=lambda x: (x is None, x)):
    lst = funcs[f]
    print('  func %s : %d escrita(s)  %s' % (f, len(lst), [x['insn'] for x in lst[:6]]))

json.dump({'pid': PID, 'base': hex(base), 'hits': uniq},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print('artefato:', OUT)
