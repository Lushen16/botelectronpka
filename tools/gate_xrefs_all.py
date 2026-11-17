"""Quem referencia o DWORD alinhado 0x2291d08 (gate = byte 0x2291d0b)?

O gate e o BYTE ALTO do DWORD em 0x2291d08 (valor atual 1 -> bytes 01 00 00 00,
logo 0x2291d0b = 0). Uma escrita de 4 bytes alinhada a 0x2291d08 cobre o gate.

Procura TODA instrucao RIP-relative cujo alvo esteja em
  [0x2291d08 - 8, 0x2291d08 + 8]
e classifica por mnemonic (leitura vs escrita).

Varredura por BYTES (nao desmonte em chunk, que desalinha).
"""
import ctypes, struct, os, json, time
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
ANCHOR = 0x2291d08
LO, HI = ANCHOR - 8, ANCHOR + 8
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\gate-xrefs-2026-11-09.json"

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

# preambulos uteis para RIP-relative, com offset do disp e tamanho total
# (bytes, disp_offset, total_len, note)
FORMS = [
    (b'\x48\x8d', 3, 7,  'lea r64'),
    (b'\x48\x8b', 3, 7,  'mov r64,[..]'),
    (b'\x48\x89', 3, 7,  'mov [..],r64'),
    (b'\x48\x39', 3, 7,  'cmp [..],r64'),
    (b'\x48\x3b', 3, 7,  'cmp r64,[..]'),
    (b'\x48\xc7\x05', 3, 11, 'mov qword [..],imm32'),
    (b'\xc7\x05', 2, 10, 'mov dword [..],imm32'),
    (b'\xc6\x05', 2, 7,  'mov byte [..],imm8'),
    (b'\x0f\xb6\x05', 3, 7, 'movzx eax,byte [..]'),
    (b'\x0f\xbe\x05', 3, 7, 'movsx eax,byte [..]'),
    (b'\x8a\x05', 2, 6,  'mov al,byte [..]'),
    (b'\x88\x05', 2, 6,  'mov byte [..],al'),
    (b'\x38\x35', 2, 6,  'cmp byte [..],dh'),
    (b'\x40\x38\x35', 3, 7, 'cmp byte [..],sil (REX)'),
]

TEXT_START, TEXT_END = 0x1000, 0x1000 + 0x1a3b00c
CH, OV = 4 << 20, 20
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
    for pfx, doff, ln, note in FORMS:
        i = 0
        while True:
            i = buf.find(pfx, i)
            if i < 0 or i + ln > len(buf):
                break
            # para os 48 xx, exigir modrm RIP-rel
            if pfx.startswith(b'\x48') and pfx not in (b'\x48\xc7\x05',):
                if (buf[i + 2] & 0xC7) != 0x05:
                    i += 1; continue
            disp = struct.unpack_from('<i', buf, i + doff)[0]
            tgt = (bb + i) + ln + disp
            if LO <= tgt <= HI:
                hits.append({'insn': hex(bb + i), 'kind': note,
                             'target': hex(tgt), 'delta': tgt - ANCHOR})
            i += 1
    tail = d[-OV:]
    off += n

k32.CloseHandle(ctypes.c_void_p(h))

json.dump({'pid': PID, 'base': hex(base), 'anchor': hex(ANCHOR),
           'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'hits': hits}, open(OUT, 'w', encoding='utf-8'), indent=1)

print('=== referencias a [%#x - 8 .. +8] ===' % ANCHOR)
for hh in hits:
    print('  %-10s %-26s alvo=%s delta=%+d' % (
        hh['insn'], hh['kind'], hh['target'], hh['delta']))
print('total: %d' % len(hits))
print('artefato:', OUT)
