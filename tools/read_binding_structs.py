"""Leitor limitado: 256 bytes em 5 intervalos. Sem depurador, sem write."""
import ctypes, struct, json, time, hashlib, os
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "19400"))
OUT = os.environ.get("OUT_JSON", r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\binding-read-2026-11-09.json")

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

h = k32.OpenProcess(0x10 | 0x1000, False, PID)   # READ | QUERY_LIMITED
ct = wintypes.FILETIME(); et = wintypes.FILETIME()
kt = wintypes.FILETIME(); ut = wintypes.FILETIME()
created = None
if k32.GetProcessTimes(ctypes.c_void_p(h), ctypes.byref(ct), ctypes.byref(et),
                       ctypes.byref(kt), ctypes.byref(ut)):
    cv = (ct.dwHighDateTime << 32) | ct.dwLowDateTime
    created = time.strftime('%Y-%m-%dT%H:%M:%SZ',
                            time.gmtime((cv - 116444736000000000) // 10000000))

def read(addr, n):
    buf = ctypes.create_string_buffer(n)
    got = ctypes.c_size_t(0)
    ctypes.set_last_error(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(addr),
                               buf, n, ctypes.byref(got))
    return {
        'addr': hex(addr), 'rva': hex(addr - base),
        'requested': n, 'read': got.value, 'ok': bool(ok),
        'err': ctypes.get_last_error() if not ok else 0,
        'hex': buf.raw[:got.value].hex() if got.value else '',
    }

INTERVALS = [
    ('descriptor_reg0', 0x204ff70, 64),
    ('descriptor_reg1', 0x204fca8, 64),
    ('descriptor_reg2', 0x204fbf0, 64),
    ('shared_util_1',   0x318930, 32),
    ('shared_util_2',   0x3186c0, 32),
]

out = {
    'pid': PID, 'created': created, 'module': modpath,
    'base': hex(base), 'size': size,
    'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'budgetBytes': sum(n for _, _, n in INTERVALS),
    'reads': [],
}
total = 0
for name, rva, n in INTERVALS:
    r = read(base + rva, n)
    r['name'] = name
    total += r['read']
    out['reads'].append(r)

out['totalRead'] = total
k32.CloseHandle(ctypes.c_void_p(h))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=1)

print(json.dumps({'pid': out['pid'], 'created': out['created'], 'base': out['base'],
                  'budget': out['budgetBytes'], 'totalRead': out['totalRead'],
                  'file': OUT}, indent=1))
for r in out['reads']:
    print('%-16s %s req=%d read=%d ok=%s err=%s' % (
        r['name'], r['rva'], r['requested'], r['read'], r['ok'], r['err']))
