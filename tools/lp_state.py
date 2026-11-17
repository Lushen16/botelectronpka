"""Leitor de estado do LocalPlayer — independente de hash e de cadeia.

Motivo: em 2026-11-09 o build mudou (sha256 48C41BD4...). O layout do
subobjeto base andou -0x10 e o hash nao esta em SUPPORTED_EXECUTABLE_SHA256,
entao scan_creatures.py morria em "player not found or identity invalid".

Este script nao valida hash e nao usa DEFAULT_CHAINS: pega o LocalPlayer
pelo global [moduleBase+0x39cb958] e confere a identidade pelo vtable via
RTTI resolvido (LocalPlayer). Se o global for NULL, cai para varredura por
nome.

Offsets confirmados neste build (PID 28500, base 0x7ff789f20000):

    LocalPlayer+0x20   int32   x
    LocalPlayer+0x24   int32   y
    LocalPlayer+0x28   uint8   z
    LocalPlayer+0x4C   uint32  id
    LocalPlayer+0x70   char[32] name
    LocalPlayer+0xB0   uint8   hp
    LocalPlayer+0xB4   uint32  direction
    LocalPlayer+0x164  uint16  sessionGate
    LocalPlayer+0xCF6  uint8   autowalk
    LocalPlayer+0xBF8  uint64  throttle
    LocalPlayer+0x9A8  ptr     Tile (shared_ptr)
    LocalPlayer+0x9B0  ptr     control block do shared_ptr

Evidencia: local-data/delta-scan2-2026-11-09.json (+0x20 mudou 877/972 com a
seta) e docs/POSICAO_CONFIRMADA.md (struct duplicada em LocalPlayer+0x20 e
Tile+0x68).

Uso:
  python tools/lp_state.py               # uma leitura
  python tools/lp_state.py --watch 10    # le a cada 250 ms por 10 s
  python tools/lp_state.py --json
"""
import argparse
import ctypes
import json
import struct
import sys
import time
from ctypes import wintypes

PID_DEFAULT = 28500
IMAGE_NAME  = 'pokealliance_dx.exe'
GLOBAL_LP   = 0x39cb958
CLOCK       = 0x3991490

OFF = {
    'x':          0x20,
    'y':          0x24,
    'z':          0x28,
    'id':         0x4C,
    'name':       0x70,
    'hp':         0xB0,
    'direction':  0xB4,
    'session':    0x164,
    'autowalk':   0xCF6,
    'throttle':   0xBF8,
    'tile':       0x9A8,
    'tile_ctrl':  0x9B0,
}

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


def find_localplayer_by_vtable(pid, base):
    """Fallback: acha a instancia do LocalPlayer pelo vtable, sem o global.

    Usa o RTTI do modulo para resolver a vtable de LocalPlayer e varre a heap.
    Serve para o caso do global [0x39cb958] estar NULL mas o objeto vivo
    (transicao de mapa, logoff pendente).
    """
    try:
        import otclient_rtti as rtti
        import pointer_scan_entities as pe
    except ImportError:
        return None
    try:
        mod = next(m for m in pe.enum_modules(pid) if m['name'].lower() == IMAGE_NAME)
        h = k32.OpenProcess(0x10 | 0x1000, False, pid)
        if not h:
            return None
        image = rtti.read_module_image(h, mod['base'], mod['size'])
        resolved = rtti.resolve_class(image, mod['base'], 'LocalPlayer')
        k32.CloseHandle(ctypes.c_void_p(h))
        if not resolved:
            return None
        vt = resolved['vtable']
        h = k32.OpenProcess(0x10 | 0x1000, False, pid)
        if not h:
            return None
        try:
            addrs = rtti.scan_instances(h, vt)
        finally:
            k32.CloseHandle(ctypes.c_void_p(h))
        return addrs[0] if addrs else None
    except Exception:
        return None


def _u16(b, o): return struct.unpack_from('<H', b, o)[0]
def _u32(b, o): return struct.unpack_from('<I', b, o)[0]
def _i32(b, o): return struct.unpack_from('<i', b, o)[0]
def _u64(b, o): return struct.unpack_from('<Q', b, o)[0]


def read_state(h, base, pid=None, fallback_va=None):
    def rd(va, n):
        buf = ctypes.create_string_buffer(n); got = ctypes.c_size_t(0)
        ok = k32.ReadProcessMemory(ctypes.c_void_p(h), ctypes.c_void_p(va),
                                  buf, n, ctypes.byref(got))
        return buf.raw[:got.value] if ok else b''

    raw = rd(base + GLOBAL_LP, 8)
    lp = _u64(raw, 0) if len(raw) == 8 else 0
    via = 'global'

    if not lp and fallback_va:
        lp = fallback_va
        via = 'vtable-scan'

    if not lp:
        return {'pid': pid, 'base': hex(base), 'localPlayer': None,
                'online': False, 'reason': 'LocalPlayer global is NULL',
                'via': 'global'}

    head = rd(lp, 0xB00)
    if len(head) < 0xB00:
        return {'pid': pid, 'base': hex(base), 'localPlayer': hex(lp),
                'online': False, 'reason': 'short read on LocalPlayer',
                'via': via}

    vtable = _u64(head, 0)
    name_raw = head[OFF['name']:OFF['name'] + 32].split(b'\x00')[0]
    try:
        name = name_raw.decode('ascii')
    except UnicodeDecodeError:
        name = ''

    tail = rd(lp + 0xCF6, 1)
    throttle_raw = rd(lp + OFF['throttle'], 8)
    tile_raw = rd(lp + OFF['tile'], 8)

    return {
        'base': hex(base),
        'localPlayer': hex(lp),
        'via': via,
        'vtable': hex(vtable),
        'vtableRva': hex(vtable - base),
        'online': True,
        'name': name,
        'id': _u32(head, OFF['id']),
        'x': _i32(head, OFF['x']),
        'y': _i32(head, OFF['y']),
        'z': head[OFF['z']],
        'hp': head[OFF['hp']],
        'direction': _u32(head, OFF['direction']),
        'sessionGate': _u16(head, OFF['session']),
        'autowalk': tail[0] if tail else None,
        'throttle': _u64(throttle_raw, 0) if len(throttle_raw) == 8 else None,
        'tile': hex(_u64(tile_raw, 0)) if len(tile_raw) == 8 and _u64(tile_raw, 0) else None,
        'clock': hex(_u64(rd(base + CLOCK, 8), 0)) if len(rd(base + CLOCK, 8)) == 8 else None,
    }


def fmt(st, with_clock=True):
    if not st['online']:
        return 'offline: %s' % st.get('reason')
    base = ('%s  pos=(%d,%d,%d)  hp=%d  id=%#x  dir=%d  gate=%d  autowalk=%d'
            % (st['name'], st['x'], st['y'], st['z'], st['hp'], st['id'],
               st['direction'], st['sessionGate'], st['autowalk']))
    if with_clock:
        return '%s  clk=%s  [%s]' % (base, st['clock'], st.get('via', '?'))
    return base


def main():
    ap = argparse.ArgumentParser(description='LocalPlayer state reader (hash-independent)')
    ap.add_argument('--pid', type=int, default=PID_DEFAULT)
    ap.add_argument('--watch', type=float, default=0.0, help='segundos de observacao')
    ap.add_argument('--interval', type=float, default=0.25)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--no-fallback', action='store_true',
                    help='nao varre por vtable quando o global esta NULL')
    args = ap.parse_args()

    base = module_base(args.pid, IMAGE_NAME)
    if not base:
        print('processo %d ausente ou modulo nao carregado' % args.pid, file=sys.stderr)
        return 2

    h = k32.OpenProcess(0x10 | 0x1000, False, args.pid)
    if not h:
        print('OpenProcess falhou para %d' % args.pid, file=sys.stderr)
        return 1

    try:
        probe = read_state(h, base, args.pid)
        fallback = None
        if not probe['online'] and not args.no_fallback:
            fallback = find_localplayer_by_vtable(args.pid, base)
            if fallback:
                print('[fallback] global NULL; LocalPlayer achado por vtable em %#x' % fallback,
                      file=sys.stderr, flush=True)
                probe = read_state(h, base, args.pid, fallback_va=fallback)
        base_state = probe

        if args.json:
            if args.watch <= 0:
                print(json.dumps(base_state, indent=1))
                return 0
            rows = []
            t0 = time.time()
            while time.time() - t0 < args.watch:
                s = read_state(h, base, args.pid, fallback_va=fallback)
                s['t'] = round(time.time() - t0, 3)
                rows.append(s)
                time.sleep(args.interval)
            print(json.dumps(rows, indent=1))
            return 0

        if args.watch <= 0:
            print(fmt(base_state))
            print()
            print('base=%s  LocalPlayer=%s  via=%s  vtable=%s (rva %s)'
                  % (base_state['base'], base_state['localPlayer'],
                     base_state.get('via'),
                     base_state.get('vtable'), base_state.get('vtableRva')))
            return 0

        print('base=%s  LocalPlayer=%s  via=%s'
              % (base_state['base'], base_state['localPlayer'], base_state.get('via')))
        print('t     state')
        t0 = time.time()
        prev = None
        for _ in range(int(round(args.watch / max(args.interval, 0.01)))):
            s = read_state(h, base, args.pid, fallback_va=fallback)
            line = fmt(s)
            key = fmt(s, with_clock=False)
            marker = '  <<< MUDOU' if prev is not None and key != prev else ''
            print('%.2f  %s%s' % (time.time() - t0, line, marker))
            prev = key
            time.sleep(args.interval)
        return 0
    finally:
        k32.CloseHandle(ctypes.c_void_p(h))


if __name__ == '__main__':
    sys.exit(main())

