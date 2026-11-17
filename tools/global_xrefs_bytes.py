"""Xrefs ao container e ao gate por varredura de BYTES (nao desmonte em chunk).

48 8D modrm=05 disp32  -> lea r64,[rip+disp]
48 8B modrm=05 disp32  -> mov r64,[rip+disp]
C6 05 disp32 imm8      -> mov byte [rip+disp],imm   (para o gate)
C7 05 disp32 imm32     -> mov dword [rip+disp],imm
"""
import ctypes, struct, json, time, os
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\global-xrefs-bytes-2026-11-09.json"

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
    buf = ctypes.create_string_buffer(n)
    got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(base + rva),
                               buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''

TARGETS = {'container': 0x39d3818, 'gate': 0x2291d0b}

# (prefixo de bytes, tamanho total da instrucao)
PATTERNS = [
    (b'\x48\x8d', 7, 'lea'),
    (b'\x48\x8b', 7, 'mov_load'),
    (b'\xc6\x05', 7, 'mov_byte_imm'),
    (b'\xc7\x05', 10, 'mov_dword_imm'),
]

hits = {k: [] for k in TARGETS}
TEXT_START, TEXT_END = 0x1000, 0x1000 + 0x1a3b00c
CHUNK, OVERLAP = 4 << 20, 16

off = TEXT_START
tail = b''
while off < TEXT_END:
    n = min(CHUNK, TEXT_END - off)
    d = rd(off, n)
    if not d:
        off += n; continue
    buf = tail + d
    buf_base = off - len(tail)
    for pfx, total_len, kind in PATTERNS:
        i = 0
        while True:
            i = buf.find(pfx, i)
            if i < 0 or i + total_len > len(buf):
                break
            if pfx in (b'\x48\x8d', b'\x48\x8b'):
                if (buf[i + 2] & 0xC7) != 0x05:
                    i += 1; continue
                disp_off = i + 3
            else:
                disp_off = i + 2
            disp = struct.unpack_from('<i', buf, disp_off)[0]
            insn_rva = buf_base + i
            tgt = insn_rva + total_len + disp
            for name, val in TARGETS.items():
                if tgt == val:
                    hits[name].append({'rva': hex(insn_rva), 'kind': kind})
            i += 1
    tail = d[-OVERLAP:]
    off += n

k32.CloseHandle(ctypes.c_void_p(h))

json.dump({'pid': PID, 'base': hex(base),
           'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'hits': hits}, open(OUT, 'w', encoding='utf-8'), indent=1)

for name in TARGETS:
    lst = hits[name]
    print('=== %s : %d ref(s) ===' % (name, len(lst)))
    for hh in lst[:30]:
        print('  %-10s %s' % (hh['rva'], hh['kind']))
    print()
print('artefato:', OUT)

