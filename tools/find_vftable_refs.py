"""Localiza quem constroi o callable: procura lea rip-relative -> 0x1f899e0.

Somente leitura (PROCESS_VM_READ). Sem attach, sem escrita, sem suspensao.
"""
import ctypes, struct, json, time, os
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "19400"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\vftable-refs-2026-11-09.json"

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
base = 0; size = 0; modpath = ''
if k32.Module32FirstW(ctypes.c_void_p(snap), ctypes.byref(me)):
    while True:
        if me.szModule.lower() == 'pokealliance_dx.exe':
            base = int(me.modBaseAddr); size = int(me.modBaseSize); modpath = me.szExePath
            break
        if not k32.Module32NextW(ctypes.c_void_p(snap), ctypes.byref(me)):
            break
k32.CloseHandle(ctypes.c_void_p(snap))

h = k32.OpenProcess(0x10 | 0x1000, False, PID)

def read(rva, n):
    buf = ctypes.create_string_buffer(n)
    got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(base + rva),
                               buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''

TARGETS = {
    'vftable_addrpoint': 0x1f899e0,
    'vftable_col_slot':  0x1f899d8,
    'COL_reg0':          0x204ff70,
}

# .text: 0x1000 .. 0x1a3c00c
TEXT_START, TEXT_END = 0x1000, 0x1a3b00c + 0x1000
CHUNK = 4 << 20
OVERLAP = 16

hits = {k: [] for k in TARGETS}
scanned = 0
t0 = time.time()

off = TEXT_START
prev_tail = b''
while off < TEXT_END:
    n = min(CHUNK, TEXT_END - off)
    d = read(off, n)
    if not d:
        off += n
        continue
    buf = prev_tail + d
    buf_base = off - len(prev_tail)
    # lea r64,[rip+disp32]: 48 8D modrm(00 rrr 101)
    i = 0
    while True:
        i = buf.find(b'\x48\x8d', i)
        if i < 0 or i + 7 > len(buf):
            break
        modrm = buf[i + 2]
        if (modrm & 0xC7) == 0x05:
            disp = struct.unpack_from('<i', buf, i + 3)[0]
            insn_rva = buf_base + i
            tgt = insn_rva + 7 + disp
            for name, val in TARGETS.items():
                if tgt == val:
                    hits[name].append(insn_rva)
        i += 2
    scanned += len(d)
    prev_tail = d[-OVERLAP:]
    off += n

# tambem: qword absoluto em .rdata/.data (caso vtable seja referenciada por ponteiro)
ptr_hits = {k: [] for k in TARGETS}
for sec_name, s, e in (('.rdata', 0x1a3d000, 0x1a3d000 + 0x83604c),
                       ('.data', 0x2274000, 0x2274000 + 0x17af5f0)):
    off = s
    while off < e:
        n = min(CHUNK, e - off)
        d = read(off, n)
        if not d:
            off += n; continue
        for name, val in TARGETS.items():
            pat = struct.pack('<Q', base + val)
            j = d.find(pat)
            while j >= 0:
                ptr_hits[name].append(off + j)
                j = d.find(pat, j + 1)
        off += n

k32.CloseHandle(ctypes.c_void_p(h))

out = {'pid': PID, 'base': hex(base), 'size': size, 'module': modpath,
       'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
       'textScannedBytes': scanned, 'elapsedMs': int((time.time() - t0) * 1000),
       'targets': {k: hex(v) for k, v in TARGETS.items()},
       'leaHits': {k: [hex(x) for x in v] for k, v in hits.items()},
       'qwordHits': {k: [hex(x) for x in v] for k, v in ptr_hits.items()}}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, 'w', encoding='utf-8'), indent=1)

print(json.dumps({k: out[k] for k in ('pid', 'base', 'textScannedBytes', 'elapsedMs')}, indent=1))
for k in TARGETS:
    print('%-20s lea: %s' % (k, out['leaHits'][k] or 'nenhum'))
    print('%-20s qword: %s' % ('', out['qwordHits'][k] or 'nenhum'))
print('artefato:', OUT)
