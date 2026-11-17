"""ETAPA 5 (final): identificar os dois chamadores e TESTAR no jogo.

Chamadores de 0x7b6320: 0x7b8add e 0x999b04.
0x999b04 esta' na faixa do lambda-autowalk (0x996b00..0x996bf0 documentado).
Confirmar por .pdata e testar o estado vivo de 0x164 (gate de sessao).
"""
import ctypes, struct, os, json, time
from ctypes import wintypes
import capstone

PID = int(os.environ.get("TARGET_PID", "28500"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\callers-0x7b6320-2026-11-09.json"

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

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.detail = True

print('=== os dois chamadores de 0x7b6320 ===')
for cr in (0x7b8add, 0x999b04):
    o = owner(cr)
    print('  call em %#x -> funcao %s' % (cr, ('%#x..%#x size=%d' % (o[0], o[1], o[1]-o[0])) if o else '?'))
    if o:
        print('    inicio:', rd(o[0], 8).hex())
        # procurar strings proximas
        body = rd(o[0], min(o[1] - o[0], 0x800))
        for ins in md.disasm(body, o[0]):
            if ins.mnemonic == 'lea':
                for op in ins.operands:
                    if op.type == capstone.x86.X86_OP_MEM and op.mem.base == capstone.x86.X86_REG_RIP:
                        t = ins.address + ins.size + op.mem.disp
                        if 0x1a3d000 <= t < 0x2274000:
                            s = rd(t, 64); z = s.find(b'\x00')
                            txt = s[:z] if z > 0 else s
                            if 3 < len(txt) < 48 and all(32 <= c < 127 for c in txt):
                                print('      str @%#x: %r' % (t, txt.decode('ascii')))
    print()

print('=== TESTE NO JOGO: gate de sessao do wrapper ===')
lp = rd(0x39cb958, 8)
lpv = struct.unpack('<Q', lp)[0] if len(lp) == 8 else 0
print('  [0x39cb958] LocalPlayer = %s' % (hex(lpv) if lpv else 'NULL'))
if lpv:
    off = lpv - base
    w164 = rd(off + 0x164, 2)
    print('  [LP+0x164] word = %s  (gate: >= 1 = sessao viva)' % (
        str(struct.unpack('<H', w164)[0]) if len(w164) == 2 else '?'))
    b4 = rd(off + 0xb4, 4)
    print('  [LP+0xb4] direcao = %s' % (str(struct.unpack('<I', b4)[0]) if len(b4) == 4 else '?'))
    bf8 = rd(off + 0xbf8, 8)
    print('  [LP+0xbf8] throttle = %s' % (str(struct.unpack('<Q', bf8)[0]) if len(bf8) == 8 else '?'))

k32.CloseHandle(ctypes.c_void_p(h))
json.dump({'pid': PID, 'base': hex(base), 'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'callers': [{'call': hex(x), 'func': ('%#x' % owner(x)[0]) if owner(x) else None}
                       for x in (0x7b8add, 0x999b04)],
           'localPlayer': hex(lpv) if lpv else None},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print('artefato:', OUT)

