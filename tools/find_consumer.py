"""Proximo passo: achar o CONSUMIDOR do callable.

Objetivos:
  1. revalidar identidade (base, A/B/C, slots da vftable, gate)
  2. procurar quem referencia o container 0x39d3818
  3. procurar quem usa o deslocamento +0x2c0 (a std::list)

Somente leitura (PROCESS_VM_READ). Sem attach, escrita, suspensao.
"""
import ctypes, struct, json, time, os
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\consumer-search-2026-11-09.json"

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

def u8(rva):
    d = rd(rva, 1); return d[0] if d else None
def u64(rva):
    d = rd(rva, 8); return struct.unpack('<Q', d)[0] if len(d) == 8 else None

print('=== 1. revalidacao ===')
print('  base = %#x  size = %d' % (base, size))
checks = {
    'A 0x7463d0': (0x7463d0, '4055535657415441'),
    'B 0x74742a': (0x74742a, 'e861980300'),
    'C 0x780c90': (0x780c90, '48895c2408555657'),
    'DoCall 0x37bc40': (0x37bc40, '4883ec28'),  # sub rsp,0x28
}
reval = {}
for name, (rva, exp) in checks.items():
    got = rd(rva, len(exp) // 2).hex()
    reval[name] = {'bytes': got, 'match': got == exp}
    print('  %-18s %s %s' % (name, got, 'OK' if got == exp else 'DIVERGE'))

slots = [0x37bd00, 0x37bd00, 0x37bc40, 0x37bc30, 0x318930, 0x3186c0]
slot_vals = []
for i, exp in enumerate(slots):
    v = u64(0x1f899e0 + i * 8)
    rva = (v - base) if v else None
    slot_vals.append({'i': i, 'rva': hex(rva) if rva else None,
                      'match': rva == exp})
    print('  vf[%d] %s %s' % (i, hex(rva) if rva else 'NULL',
                              'OK' if rva == exp else 'DIVERGE'))

gate = u8(0x2291d0b)
container = u64(0x39d3818)
print('  gate [0x2291d0b]      = %s' % gate)
print('  container [0x39d3818] = %s' % (hex(container) if container else 'NULL'))

allok = all(v['match'] for v in reval.values()) and all(s['match'] for s in slot_vals)
print('  >>> identidade %s' % ('CONFERE' if allok else 'DIVERGE'))
if not allok:
    print('  ABORTANDO: nao leio estrutura com identidade divergente')
    k32.CloseHandle(ctypes.c_void_p(h))
    raise SystemExit(2)

print()
print('=== 2. referencias ao container 0x39d3818 ===')
# qword absoluto em .text/.rdata/.data
refs_qword = []
for s, e in ((0x1000, 0x1000 + 0x1a3b00c),
             (0x1a3d000, 0x1a3d000 + 0x83604c),
             (0x2274000, 0x2274000 + 0x17af5f0)):
    pat = struct.pack('<Q', base + 0x39d3818)
    off = s
    while off < e:
        n = min(4 << 20, e - off)
        d = rd(off, n)
        if not d:
            off += n; continue
        j = d.find(pat)
        while j >= 0:
            refs_qword.append(off + j)
            j = d.find(pat, j + 1)
        off += n
print('  qword (base+0x39d3818): %s' % ([hex(x) for x in refs_qword] or 'nenhum'))

print()
print('=== 3. instrucoes que usam +0x2c0 (a std::list) ===')
# 48 8D / 48 8B com disp32 == 0x2c0, modrm rip-rel ou reg
hits_lea = []
hits_mov = []
TEXT_END = 0x1000 + 0x1a3b00c
off = 0x1000
tail = b''
while off < TEXT_END:
    n = min(4 << 20, TEXT_END - off)
    d = rd(off, n)
    if not d:
        off += n; continue
    buf = tail + d
    buf_base = off - len(tail)
    for opcode, bucket in ((b'\x48\x8d', hits_lea), (b'\x48\x8b', hits_mov)):
        i = 0
        while True:
            i = buf.find(opcode, i)
            if i < 0 or i + 7 > len(buf):
                break
            disp = struct.unpack_from('<i', buf, i + 3)[0]
            if disp == 0x2c0:
                bucket.append(buf_base + i)
            i += 1
    tail = d[-8:]
    off += n

print('  lea ...+0x2c0 : %d  %s' % (len(hits_lea), [hex(x) for x in hits_lea[:12]]))
print('  mov ...+0x2c0 : %d  %s' % (len(hits_mov), [hex(x) for x in hits_mov[:12]]))

k32.CloseHandle(ctypes.c_void_p(h))

out = {'pid': PID, 'base': hex(base), 'size': size,
       'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
       'revalidation': reval, 'vfSlots': slot_vals,
       'gate': gate, 'container': hex(container) if container else None,
       'containerRefsQword': [hex(x) for x in refs_qword],
       'lea2c0': [hex(x) for x in hits_lea],
       'mov2c0': [hex(x) for x in hits_mov]}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, 'w', encoding='utf-8'), indent=1)
print('\nartefato: %s' % OUT)
