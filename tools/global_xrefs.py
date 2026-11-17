"""Filtra: quem referencia 0x39d3818 (container) e 0x2291d0b (gate) por RIP-rel.

Achados anteriores (lea/mov +0x2c0) sao ruido: 412 hits, offset comum a muitas
estruturas. O alvo certo e' o GLOBAL, nao o offset.
"""
import ctypes, struct, json, time, os
from ctypes import wintypes
import capstone

PID = int(os.environ.get("TARGET_PID", "28500"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\global-xrefs-2026-11-09.json"

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
    buf = ctypes.create_string_buffer(n)
    got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(base + rva),
                               buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''

TARGETS = {
    'container 0x39d3818': 0x39d3818,
    'gate      0x2291d0b': 0x2291d0b,
}
TEXT_START, TEXT_END = 0x1000, 0x1000 + 0x1a3b00c

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.detail = True

hits = {k: [] for k in TARGETS}
CHUNK = 4 << 20
off = TEXT_START
while off < TEXT_END:
    n = min(CHUNK, TEXT_END - off)
    d = rd(off, n)
    if not d:
        off += n; continue
    # desmontar em blocos; inicio arbitrario perde instrucoes, entao
    # desmontamos e guardamos so as que tem RIP-rel batendo no alvo
    for ins in md.disasm(d, off):
        if any(base + t == ins.address + ins.size + 0
               for t in TARGETS.values()):
            pass
        for op in ins.operands:
            if op.type == capstone.x86.X86_OP_MEM and op.mem.base == capstone.x86.X86_REG_RIP:
                tgt = ins.address + ins.size + op.mem.disp
                for name, val in TARGETS.items():
                    if tgt == base + val:
                        hits[name].append({
                            'insn': hex(ins.address),
                            'text': '%s %s' % (ins.mnemonic, ins.op_str),
                        })
    off += n

k32.CloseHandle(ctypes.c_void_p(h))

out = {'pid': PID, 'base': hex(base),
       'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
       'targets': {k: hex(v) for k, v in TARGETS.items()},
       'hits': hits}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, 'w', encoding='utf-8'), indent=1)

for name in TARGETS:
    print('=== %s : %d ref(s) ===' % (name, len(hits[name])))
    seen = set()
    for hh in hits[name]:
        key = (hh['insn'], hh['text'])
        if key in seen: continue
        seen.add(key)
        print('  %-10s %s' % (hh['insn'], hh['text']))
    print()
print('artefato:', OUT)
