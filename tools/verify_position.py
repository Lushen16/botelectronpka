"""Confirma LocalPlayer+0x20 como posicao (x,y,z).

HIPOTESE: LocalPlayer+0x20 = x (u32), +0x24 = y (u32), +0x28 = z (u8).
Medido passivo: 3290 / 2035 / 7  (z=7 bate com os fixtures do botfinal).

Protocolo:
  1. Captura passiva de BASE_SECONDS (sem tocar em nada) -> prova que nao muda sozinho.
  2. Avisa e captura MOVE_SECONDS enquanto voce aperta a seta.
  3. Controle positivo: relogio 0x3991490 deve andar nas duas fases.

Se x/y mudarem na fase 2 e nao na fase 1, a hipotese esta fechada.
Se z mudar, e' andar entre andares (escada/portal) — anota.

Uso:
  python tools/verify_position.py            # 4 s parado + 14 s andando
  python tools/verify_position.py 4 20
Aperte e SEGURE a seta quando aparecer o aviso.
"""
import ctypes, struct, sys, time, json
from ctypes import wintypes

PID     = 28500
BASE_T  = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0
MOVE_T  = float(sys.argv[2]) if len(sys.argv) > 2 else 14.0
OUT     = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial\local-data\pos-confirm-2026-11-09.json"

CLOCK       = 0x3991490    # vivo neste build (0x398cdd0 esta morto)
LOCALPLAYER = 0x39cb958
OFF_X, OFF_Y, OFF_Z = 0x20, 0x24, 0x28

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE

class ME(ctypes.Structure):
    _fields_ = [('dwSize', wintypes.DWORD), ('th32ModuleID', wintypes.DWORD),
                ('th32ProcessID', wintypes.DWORD), ('GlblcntUsage', wintypes.DWORD),
                ('ProccntUsage', wintypes.DWORD), ('modBaseAddr', ctypes.c_void_p),
                ('modBaseSize', wintypes.DWORD), ('hModule', wintypes.HMODULE),
                ('szModule', wintypes.WCHAR * 256), ('szExePath', wintypes.WCHAR * 260)]

def module_base(pid, name):
    snap = k32.CreateToolhelp32Snapshot(0x8 | 0x10, pid)
    me = ME(); me.dwSize = ctypes.sizeof(ME); base = 0
    if k32.Module32FirstW(ctypes.c_void_p(snap), ctypes.byref(me)):
        while True:
            if me.szModule.lower() == name:
                base = int(me.modBaseAddr); break
            if not k32.Module32NextW(ctypes.c_void_p(snap), ctypes.byref(me)):
                break
    k32.CloseHandle(ctypes.c_void_p(snap))
    return base

base = module_base(PID, 'pokealliance_dx.exe')
if not base:
    print('processo %d ausente ou modulo nao carregado' % PID); raise SystemExit(2)

h = k32.OpenProcess(0x10 | 0x1000, False, PID)
def rd(va, n):
    buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(va),
                               buf, n, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''
def u64(va):
    d = rd(va, 8); return struct.unpack('<Q', d)[0] if len(d) == 8 else None

lp = u64(base + LOCALPLAYER)
if not lp:
    print('LocalPlayer NULL — personagem fora do mundo'); raise SystemExit(3)

def sample():
    d = rd(lp + OFF_X, 12)
    if len(d) < 12: return None
    x, y = struct.unpack('<II', d[0:8])
    return {'x': x, 'y': y, 'z': d[8], 'dir': None, 'clk': None}

def full():
    s = sample()
    if s is None: return None
    dv = rd(lp + 0xb4, 4)
    s['dir'] = struct.unpack('<I', dv)[0] if len(dv) == 4 else None
    s['clk'] = u64(base + CLOCK)
    return s

print('base=%#x  LocalPlayer=%#x' % (base, lp))
print('posicao lida de LP+0x%02x/0x%02x/0x%02x' % (OFF_X, OFF_Y, OFF_Z))
print()

# --- fase 1: parado -------------------------------------------------------
t0 = time.time(); s0 = full()
print('FASE 1/2 — NAO ENCOSTE NO TECLADO (%.0f s)' % BASE_T)
still = []
while time.time() - t0 < BASE_T:
    s = full()
    if s: still.append(s)
    time.sleep(0.1)
s1 = full()

# --- fase 2: andando ------------------------------------------------------
print()
print('FASE 2/2 — APERTE E SEGURE A SETA AGORA (%.0f s)' % MOVE_T)
t1 = time.time(); walk = []
while time.time() - t1 < MOVE_T:
    s = full()
    if s: walk.append(s)
    time.sleep(0.05)

k32.CloseHandle(ctypes.c_void_p(h))

def uniq(rows):
    xs = sorted({r['x'] for r in rows}); ys = sorted({r['y'] for r in rows})
    zs = sorted({r['z'] for r in rows}); ds = sorted({r['dir'] for r in rows if r['dir'] is not None})
    return xs, ys, zs, ds

sx, sy, sz, sd = uniq(still)
mx, my, mz, md = uniq(walk)

def fmt(vals):
    if not vals: return '—'
    return '%s..%s (%d)' % (vals[0], vals[-1], len(vals)) if len(vals) > 5 else str(vals)

print()
print('=== veredito ===')
print('  relogio fase1 mudou? %s   fase2 mudou? %s' % (
    s0['clk'] != s1['clk'], bool(walk) and walk[0]['clk'] != walk[-1]['clk']))
print()
print('  %-6s %-28s %s' % ('campo', 'PARADO (fase 1)', 'ANDANDO (fase 2)'))
print('  %-6s %-28s %s' % ('x', fmt(sx), fmt(mx)))
print('  %-6s %-28s %s' % ('y', fmt(sy), fmt(my)))
print('  %-6s %-28s %s' % ('z', fmt(sz), fmt(mz)))
print('  %-6s %-28s %s' % ('dir', fmt(sd), fmt(md)))
print()

moved    = len(mx) > 1 or len(my) > 1
z_moved  = len(mz) > 1
still_ok = len(sx) == 1 and len(sy) == 1

if moved and still_ok:
    print('  >>> CONFIRMADO: LP+0x20=x, LP+0x24=y, LP+0x28=z')
elif moved and not still_ok:
    print('  >>> INCONCLUSIVO: x/y ja variavam parado (auto-walk? animacao?) — repetir')
else:
    print('  >>> NAO CONFIRMADO: x/y nao mudaram na fase 2. A tecla saiu? Foco na janela?')
if z_moved:
    print('  >>> z mudou: houve troca de andar no meio — registrar como evento, nao erro')

json.dump({'pid': PID, 'base': hex(base), 'localPlayer': hex(lp),
           'offsets': {'x': hex(OFF_X), 'y': hex(OFF_Y), 'z': hex(OFF_Z)},
           'still': still, 'walk': walk},
          open(OUT, 'w', encoding='utf-8'), indent=1)
print()
print('amostras: parado=%d andando=%d' % (len(still), len(walk)))
print('artefato:', OUT)
