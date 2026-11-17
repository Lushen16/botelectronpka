"""ETAPA 5: 0x7b6346 e' fragmento? Onde esta a funcao real?

Prólogo assimetrico: faz `add rsp,0x20; pop rbx; ret` sem push rbx / sub rsp.
Logo a entrada real esta ANTES. Desmonta para tras e confirma.
Depois: TESTE NO JOGO do estado de ambos os caminhos.
"""
import ctypes, struct, os, json, time
from ctypes import wintypes
import capstone

PID = int(os.environ.get("TARGET_PID", "28500"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\fragment-check-2026-11-09.json"

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

print('=== .pdata: entradas que COBREM 0x7b6346 (inclusive fragmentos) ===')
cov = [(b, en) for b, en in ranges if b <= 0x7b6346 < en]
for b, en in sorted(cov):
    print('  %#x..%#x  (size %d)  offset=%#x' % (b, en, en - b, 0x7b6346 - b))
print('  total de entradas cobrindo: %d' % len(cov))

print()
print('=== desmonte PARA TRAS a partir de 0x7b6346 (procurar prologo) ===')
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
start = 0x7b62c0
buf = rd(start, 0x7b6346 - start + 8)
for ins in md.disasm(buf, start):
    mark = ''
    if ins.address == 0x7b6346:
        mark = '  <== .pdata diz inicio aqui'
    if ins.mnemonic in ('push', 'sub') and 'rsp' in ins.op_str:
        mark += '  [prologo?]'
    print('  %-10s %-40s%s' % (hex(ins.address), ins.mnemonic + ' ' + ins.op_str, mark))
    if ins.address > 0x7b6346:
        break

print()
print('=== TESTE NO JOGO: estado dos dois caminhos ===')
gate = rd(0x2291d0b, 1)
cont = rd(0x39d3818, 8)
print('  caminho A/B/C  gate byte [0x2291d0b] = %s' % (gate.hex() if gate else '?'))
print('  caminho A/B/C  container [0x39d3818] = %s' % (
    hex(struct.unpack('<Q', cont)[0]) if len(cont) == 8 else '?'))
# wrapper: ele depende de rbx; sem chamadores, inativo. Checar se ha algum
# ponteiro para ele em TODA a imagem (nao so rdata/data).
ptr = struct.pack('<Q', base + 0x7b6346)
ptrs = []
for s, ee in ((0x1000, 0x1000 + 0x1a3b00c), (0x1a3d000, 0x1a3d000 + 0x83604c),
              (0x2274000, 0x2274000 + 0x17af5f0), (0x3a24000, 0x3a24000 + 0xd15a4)):
    off = s
    while off < ee:
        n = min(4 << 20, ee - off)
        d = rd(off, n)
        if not d:
            off += n; continue
        j = d.find(ptr)
        while j >= 0:
            ptrs.append(off + j); j = d.find(ptr, j + 1)
        off += n
print('  wrapper 0x7b6346: ponteiros na imagem inteira = %s' % ([hex(x) for x in ptrs[:8]] or 'NENHUM'))

k32.CloseHandle(ctypes.c_void_p(h))
json.dump({'pid': PID, 'base': hex(base),
           'pdataCovering': [{'start': hex(b), 'end': hex(en)} for b, en in cov],
           'wrapperPointers': [hex(x) for x in ptrs],
           'gateByte': gate.hex() if gate else None,
           'container': hex(struct.unpack('<Q', cont)[0]) if len(cont) == 8 else None},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print('artefato:', OUT)
