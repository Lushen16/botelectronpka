"""Quem ESCREVE no gate 0x2291d0b?

Tenta escritas alinhadas que cobrem o byte:
  mov dword [rip+d], imm32   -> c7 05 disp32 imm32   (cobre 4 bytes)
  mov qword [rip+d], imm32   -> 48 c7 05 disp32 imm32 (cobre 8)
  mov byte  [rip+d], imm8    -> c6 05 disp32 imm8
Procura qualquer alvo cujo intervalo [tgt, tgt+len) contenha 0x2291d0b.
"""
import ctypes, struct, os
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
GATE = 0x2291d0b

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

# (prefixo, len total, offset do disp, tamanho do alvo)
PATS = [
    (b'\xc6\x05', 7, 2, 1),
    (b'\xc7\x05', 10, 2, 4),
    (b'\x48\xc7\x05', 11, 3, 8),
]

TEXT_START, TEXT_END = 0x1000, 0x1000 + 0x1a3b00c
CH, OV = 4 << 20, 20
found = []
off = TEXT_START
tail = b''
while off < TEXT_END:
    n = min(CH, TEXT_END - off)
    d = rd(off, n)
    if not d:
        off += n; continue
    buf = tail + d
    bb = off - len(tail)
    for pfx, ln, doff, sz in PATS:
        i = 0
        while True:
            i = buf.find(pfx, i)
            if i < 0 or i + ln > len(buf):
                break
            disp = struct.unpack_from('<i', buf, i + doff)[0]
            tgt = (bb + i) + ln + disp
            if tgt <= GATE < tgt + sz:
                found.append({'insn': hex(bb + i), 'target': hex(tgt),
                              'width': sz, 'delta': GATE - tgt})
            i += 1
    tail = d[-OV:]
    off += n

k32.CloseHandle(ctypes.c_void_p(h))

print('=== escritas alinhadas que cobrem o gate %#x ===' % GATE)
for f in found[:20]:
    print('  %-10s alvo=%s width=%d gate em +%d' % (f['insn'], f['target'], f['width'], f['delta']))
if not found:
    print('  NENHUMA')
print()
print('total: %d' % len(found))
