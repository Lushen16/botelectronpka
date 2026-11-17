"""Quem ESCREVE a direcao em [reg+0xb4]?

O wrapper 0x7b6320 le [+0xb4] mas nao escreve. A (0x74645d) escreve.
Se o teclado existe, ele tem que escrever a direcao em algum lugar.

Procura todas as escritas `mov dword [reg+0xb4], r32` (89 /r com disp8 0xb4)
e `mov byte [reg+0xb4], r8` (88 /r com disp8 0xb4).
"""
import ctypes, struct, os, json
from ctypes import wintypes
import capstone

PID = int(os.environ.get("TARGET_PID", "28500"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\dir-writes-2026-11-09.json"

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
def owner(rva):
    best = None
    for b, en in ranges:
        if b <= rva < en and (best is None or b > best[0]):
            best = (b, en)
    return best

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.detail = True

TEXT_START, TEXT_END = 0x1000, 0x1000 + 0x1a3b00c
CH = 4 << 20
hits = []
off = TEXT_START
while off < TEXT_END:
    n = min(CH, TEXT_END - off)
    d = rd(off, n)
    if not d:
        off += n; continue
    for ins in md.disasm(d, off):
        # so escritas em memoria com deslocamento 0xb4
        if len(ins.operands) == 2 and ins.operands[0].type == capstone.x86.X86_OP_MEM:
            mem = ins.operands[0].mem
            if mem.disp == 0xb4 and mem.base not in (capstone.x86.X86_REG_RIP, 0):
                if ins.mnemonic in ('mov', 'and', 'or', 'add', 'sub', 'inc', 'dec'):
                    hits.append({'insn': hex(ins.address),
                                 'text': ins.mnemonic + ' ' + ins.op_str,
                                 'func': hex(owner(ins.address)[0]) if owner(ins.address) else None})
    off += n

k32.CloseHandle(ctypes.c_void_p(h))

# dedup
seen = set()
uniq = []
for hh in hits:
    if hh['insn'] in seen: continue
    seen.add(hh['insn'])
    uniq.append(hh)

print('=== escritas/leitura em [reg+0xb4] encontradas: %d ===' % len(uniq))
for hh in uniq[:40]:
    print('  %-10s %-34s func=%s' % (hh['insn'], hh['text'], hh['func']))

json.dump({'pid': PID, 'base': hex(base), 'hits': uniq},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print('artefato:', OUT)
