"""ETAPA 1 + 2: achar quem alimenta o wrapper que chama C direto (0x7b6346).

O wrapper tem throttle em [rbx+0xbf8] e chama C = 0x780c90 sem passar por A/B.
Se o teclado usa esse wrapper, essa e' a via.

Procura TODAS as formas de referencia a 0x7b6346:
  E8 rel32 / E9 rel32
  qword absoluto (base+rva) em .rdata/.data
  lea rip-relative
"""
import ctypes, struct, os, json, time
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "28500"))
TARGET = 0x7b6346
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\wrapper-refs-2026-11-09.json"

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
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(base + rva),
                               buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''

# revalidacao
print('=== ETAPA 1: revalidacao ===')
reval = {}
for name, rva, exp in (('A', 0x7463d0, '4055535657415441'),
                       ('B', 0x74742a, 'e861980300'),
                       ('C', 0x780c90, '48895c2408555657'),
                       ('wrapper', 0x7b6346, None)):
    nbytes = len(exp) // 2 if exp else 8
    got = rd(rva, nbytes).hex()
    ok = (got == exp) if exp else True
    reval[name] = {'rva': hex(rva), 'bytes': got, 'ok': ok}
    print('  %-8s %#010x %s %s' % (name, rva, got, 'OK' if ok else 'DIVERGE'))
if not all(v['ok'] for v in reval.values()):
    print('ABORT'); k32.CloseHandle(ctypes.c_void_p(h)); raise SystemExit(2)
print('  base = %#x' % base)

# --- referencias a TARGET ---
print()
print('=== ETAPA 2: referencias a 0x%x ===' % TARGET)
call_refs, jmp_refs, ptr_refs, lea_refs = [], [], [], []

def scan_range(s, e):
    off = s
    tail = b''
    while off < e:
        n = min(4 << 20, e - off)
        d = rd(off, n)
        if not d:
            off += n; continue
        buf = tail + d
        bb = off - len(tail)
        # E8/E9
        for op, bucket in ((b'\xe8', call_refs), (b'\xe9', jmp_refs)):
            i = 0
            while True:
                i = buf.find(op, i)
                if i < 0 or i + 5 > len(buf):
                    break
                rel = struct.unpack_from('<i', buf, i + 1)[0]
                if (bb + i) + 5 + rel == TARGET:
                    bucket.append(bb + i)
                i += 1
        # lea rip-rel 48 8d
        i = 0
        while True:
            i = buf.find(b'\x48\x8d', i)
            if i < 0 or i + 7 > len(buf):
                break
            if (buf[i + 2] & 0xC7) == 0x05:
                disp = struct.unpack_from('<i', buf, i + 3)[0]
                if (bb + i) + 7 + disp == TARGET:
                    lea_refs.append(bb + i)
            i += 1
        # qword absoluto
        pat = struct.pack('<Q', base + TARGET)
        j = buf.find(pat)
        while j >= 0:
            ptr_refs.append(bb + j)
            j = buf.find(pat, j + 1)
        tail = d[-16:]
        off += n

scan_range(0x1000, 0x1000 + 0x1a3b00c)            # .text
scan_range(0x1a3d000, 0x1a3d000 + 0x83604c)       # .rdata
scan_range(0x2274000, 0x2274000 + 0x17af5f0)      # .data

print('  E8 call : %s' % ([hex(x) for x in call_refs[:10]] or 'NENHUM'))
print('  E9 jmp  : %s' % ([hex(x) for x in jmp_refs[:10]] or 'NENHUM'))
print('  lea     : %s' % ([hex(x) for x in lea_refs[:10]] or 'NENHUM'))
print('  qword   : %s' % ([hex(x) for x in ptr_refs[:10]] or 'NENHUM'))

k32.CloseHandle(ctypes.c_void_p(h))
json.dump({'pid': PID, 'base': hex(base), 'target': hex(TARGET),
           'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'reval': reval,
           'calls': [hex(x) for x in call_refs],
           'jmps': [hex(x) for x in jmp_refs],
           'leas': [hex(x) for x in lea_refs],
           'qwords': [hex(x) for x in ptr_refs]},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print('artefato:', OUT)

