"""Le os tres TypeDescriptors RTTI. Teto 256 bytes cada, 768 total."""
import ctypes, struct, json, time, os
from ctypes import wintypes

PID = int(os.environ.get("TARGET_PID", "19400"))
OUT = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\rtti-typedescriptors-2026-11-09.json"

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
    return {'addr': hex(addr), 'rva': hex(addr - base), 'requested': n,
            'read': got.value, 'ok': bool(ok),
            'err': ctypes.get_last_error() if not ok else 0,
            'hex': buf.raw[:got.value].hex() if got.value else ''}

# revalidar os COLs antes
COLS = [('reg0', 0x204ff70), ('reg1', 0x204fca8), ('reg2', 0x204fbf0)]
col_state = []
td_rvas = []
for name, rva in COLS:
    b = read(base + rva, 24)
    sig = off = cd = ptd = pcd = pself = None
    if b['read'] >= 24:
        raw = bytes.fromhex(b['hex'])
        sig, off, cd, ptd, pcd, pself = struct.unpack('<6I', raw)
    col_state.append({'name': name, 'rva': hex(rva), 'sig': sig,
                      'pSelf': hex(pself) if pself is not None else None,
                      'selfOk': (pself == rva), 'pTypeDescriptor': hex(ptd) if ptd is not None else None})
    if ptd is not None:
        td_rvas.append((name, ptd))

# se algo mudou, parar
if any(not c['selfOk'] or c['sig'] != 1 for c in col_state):
    print(json.dumps({'ok': False, 'reason': 'COL divergiu', 'colState': col_state}, indent=1))
    raise SystemExit(2)
if [r for _, r in td_rvas] != [0x22fe590, 0x22fe6e0, 0x22fe610]:
    print(json.dumps({'ok': False, 'reason': 'pTypeDescriptor mudou',
                      'found': [hex(r) for _, r in td_rvas]}, indent=1))
    raise SystemExit(2)

out = {'pid': PID, 'created': created, 'module': modpath, 'base': hex(base),
       'size': size, 'readAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
       'colState': col_state, 'budgetBytes': 768, 'reads': []}

total = 0
for name, td in td_rvas:
    r = read(base + td, 256)
    r['name'] = 'TypeDescriptor_' + name
    total += r['read']
    # MSVC x64 TypeDescriptor:
    #   +0x00 void* pVFTable (8 bytes)
    #   +0x08 void* spare    (8 bytes)
    #   +0x10 char name[]
    if r['read'] >= 16:
        raw = bytes.fromhex(r['hex'])
        vft, spare = struct.unpack_from('<2Q', raw, 0)
        r['pVFTable'] = hex(vft)
        r['spare'] = hex(spare)
        nm = raw[16:]
        z = nm.find(b'\x00')
        r['nameTerminated'] = z >= 0
        r['nameRaw'] = nm[:z].decode('latin1') if z >= 0 else nm.decode('latin1')
    out['reads'].append(r)

out['totalRead'] = total
k32.CloseHandle(ctypes.c_void_p(h))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=1)

print(json.dumps({'ok': True, 'pid': PID, 'base': out['base'],
                  'budget': 768, 'totalRead': total, 'file': OUT}, indent=1))
for r in out['reads']:
    print('\n%s @ %s  read=%d ok=%s' % (r['name'], r['rva'], r['read'], r['ok']))
    if r.get('pVFTable'):
        print('  pVFTable=%s spare=%s' % (r['pVFTable'], r['spare']))
        print('  name(terminated=%s) = %r' % (r['nameTerminated'], r['nameRaw']))
