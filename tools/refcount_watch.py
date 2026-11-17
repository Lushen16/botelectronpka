"""Le o refcount do control block do shared_ptr<Tile> do LocalPlayer.

POR QUE EXISTE
==============
O handler de attack (exe+0x784be0) DESTROI o shared_ptr que recebe: no
epilogo ele faz `mov rcx,[rdi+8]` / `call <destrutor>`. Ou seja, toma
ownership da copia.

Se o chamador incrementar ANTES e decrementar DEPOIS, cada chamada custa
-1 no refcount:

    ++meu (2->3)  ->  handler -- (3->2)  ->  --meu (2->1)     = NET -1

Tres chamadas zeraram o refcount do Tile do LocalPlayer e o cliente morreu
~9 min depois, sem log (2026-11-09 22:49 attacks, 23:59 morte).

Este script observa o refcount para provar se o vazamento foi corrigido,
ANTES de arriscar outro ataque.

Layout do control block (medido):
    +0x00 vtable
    +0x08 refcount forte  (u32)   <<< o que interessa
    +0x0c refcount fraco  (u32)

Uso:
  python tools/refcount_watch.py --pid 15264
  python tools/refcount_watch.py --pid 15264 --watch 30
"""
import argparse
import ctypes
import struct
import sys
import time
from ctypes import wintypes

IMAGE = 'pokealliance_dx.exe'

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


def read(handle, va, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t(0)
    ok = k32.ReadProcessMemory(ctypes.c_void_p(handle), ctypes.c_void_p(va),
                               buf, size, ctypes.byref(got))
    return buf.raw[:got.value] if ok else b''


def u64(data, off=0):
    return struct.unpack_from('<Q', data, off)[0] if len(data) >= off + 8 else None


def find_localplayer(handle, base):
    """Le [base+0x39cb958]; se NULL, procura por RTTI nao e' possivel aqui,
    entao devolve None e o chamador decide."""
    d = read(handle, base + 0x39cb958, 8)
    return u64(d) if d else None


def snapshot(handle, base):
    lp = find_localplayer(handle, base)
    if not lp:
        return {'lp': None}
    d = read(handle, lp + 0x9a8, 0x20)
    if len(d) < 0x20:
        return {'lp': lp, 'err': 'leitura curta'}
    tile = u64(d, 0)          # +0x9a8 shared_ptr<Tile>.obj
    ctrl = u64(d, 8)          # +0x9b0 shared_ptr<Tile>.ctrl
    c = read(handle, ctrl, 0x10) if ctrl else b''
    strong = struct.unpack_from('<I', c, 8)[0] if len(c) >= 12 else None
    weak = struct.unpack_from('<I', c, 12)[0] if len(c) >= 16 else None
    return {'lp': lp, 'tile': tile, 'ctrl': ctrl, 'strong': strong, 'weak': weak}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pid', type=int, required=True)
    ap.add_argument('--watch', type=float, default=0.0)
    ap.add_argument('--interval', type=float, default=1.0)
    args = ap.parse_args()

    base = module_base(args.pid, IMAGE)
    if not base:
        print('processo/modulo ausente'); return 2
    handle = k32.OpenProcess(0x10 | 0x1000, False, args.pid)
    if not handle:
        print('OpenProcess falhou'); return 1

    try:
        s0 = snapshot(handle, base)
        if not s0.get('lp'):
            print('LocalPlayer global NULL — entre no mundo primeiro')
            print('(a leitura por RTTI nao esta implementada aqui de proposito:')
            print(' este script mede so o refcount, sem tocar no jogo)')
            return 3

        print('base=%#x  LocalPlayer=%#x' % (base, s0['lp']))
        print('  tile  = %s' % (hex(s0['tile']) if s0['tile'] else None))
        print('  ctrl  = %s' % (hex(s0['ctrl']) if s0['ctrl'] else None))
        print('  refcount forte = %s   fraco = %s' % (s0['strong'], s0['weak']))
        print()

        if not args.watch:
            print('Refcount inicial registrado. Agora:')
            print('  1. rode o attack')
            print('  2. rode este script de novo')
            print('  3. o forte tem que estar IGUAL, nao 1 a menos')
            return 0

        print('observando por %.0fs (Ctrl+C para parar)' % args.watch)
        print('  t     forte  fraco')
        t0 = time.time()
        prev = s0['strong']
        while time.time() - t0 < args.watch:
            s = snapshot(handle, base)
            if s.get('lp') and s.get('strong') is not None:
                delta = ''
                if prev is not None and s['strong'] != prev:
                    delta = '   <<< %+d' % (s['strong'] - prev)
                print('  %5.1f  %-6s %-6s%s' % (time.time() - t0, s['strong'], s['weak'], delta))
                prev = s['strong']
            else:
                print('  %5.1f  (leitura falhou / fora do mundo)' % (time.time() - t0))
            time.sleep(args.interval)

        s1 = snapshot(handle, base)
        print()
        print('=== veredito ===')
        if s1.get('strong') is None:
            print('  nao consegui reler')
            return 3
        if s0['strong'] == s1['strong']:
            print('  refcount ESTAVEL (%d). OK' % s0['strong'])
            return 0
        drop = s0['strong'] - s1['strong']
        print('  refcount CAIU %d -> %d (delta %+d)' % (s0['strong'], s1['strong'], -drop))
        if drop > 0:
            print('  >>> VAZAMENTO ATIVO. Nao ataque mais ate corrigir.')
        else:
            print('  subiu — algo mais tomou referencia; investigar')
        return 1
    finally:
        k32.CloseHandle(ctypes.c_void_p(handle))


if __name__ == '__main__':
    sys.exit(main())
