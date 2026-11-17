"""Confirma o deslocamento entre o dump estatico e o modulo live, e recalcula
os RVAs importantes.

Descoberta: a assinatura do dispatcher (bytes de 0x12c40 do dump) aparece no
live em 0x11cc0. Deslocamento = -0xf80. Se isso se sustentar em varios pontos,
podemos traduzir todo RVA do dump para o live com uma conta.

  python tools/tap_rebase.py <pid>
"""
import ctypes
import struct
import sys
from ctypes import wintypes
from pathlib import Path

import pefile

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "dumps" / "payload_reconstructed.dll"

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


class ME(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD), ("modBaseAddr", ctypes.c_void_p),
        ("modBaseSize", wintypes.DWORD), ("hModule", wintypes.HMODULE),
        ("szModule", ctypes.c_char * 256), ("szExePath", ctypes.c_char * 260),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.Module32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ME)]
k32.Module32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ME)]

# RVAs do dump estatico que a analise usou
KNOWN = {
    "dispatcher": 0x12c40,
    "comboTick-attack": 0xa93d0,
    "tickHoenn": 0x9e7a4,
    "medicine-gate": 0x57020,
    "deploy-gate": 0x9cf84,
    "send": 0x84340,
    "tickLoot": 0xa46e0,
}


def main():
    pid = int(sys.argv[1])
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return

    snap = k32.CreateToolhelp32Snapshot(0x8, pid)
    entry = ME()
    entry.dwSize = ctypes.sizeof(entry)
    base = size = None
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        if "msftedit" in entry.szModule.decode("latin1").lower():
            base, size = entry.modBaseAddr, entry.modBaseSize
            break
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)

    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    k32.ReadProcessMemory(handle, ctypes.c_void_p(base), buf, size, ctypes.byref(got))
    live = buf.raw[:got.value]
    dump = pefile.PE(str(DUMP)).get_memory_mapped_image()

    # Descobre o deslocamento testando cada RVA conhecido.
    print("=== teste de deslocamento por assinatura ===")
    shifts = {}
    for name, rva in KNOWN.items():
        signature = dump[rva:rva + 24]
        if len(signature) < 24:
            continue
        found = []
        start = 0
        while True:
            index = live.find(signature, start)
            if index < 0:
                break
            found.append(index)
            start = index + 1
        if found:
            shifts[name] = [index - rva for index in found]
            print(f"  {name:<20} rva 0x{rva:06x}  achado em "
                  f"{[hex(i) for i in found[:3]]}  shift={[hex(s & 0xFFFFFFFF) for s in shifts[name][:3]]}")
        else:
            print(f"  {name:<20} rva 0x{rva:06x}  NAO encontrado")

    # vota no deslocamento mais comum
    votes = {}
    for name, deltas in shifts.items():
        for delta in deltas:
            votes[delta] = votes.get(delta, 0) + 1
    if not votes:
        print("\nnenhum deslocamento consistente: builds incompativeis")
        return

    best = max(votes.items(), key=lambda kv: kv[1])
    delta, count = best
    print(f"\ndeslocamento vencedor: {delta:+d} (0x{delta & 0xFFFFFFFF:x}) "
          f"com {count} de {sum(votes.values())} votos")

    # valida: com esse delta, os RVAs batem?
    print("\n=== RVAs traduzidos para a build live ===")
    for name, rva in KNOWN.items():
        live_rva = rva + delta
        if 0 <= live_rva < len(live):
            same = dump[rva:rva + 16] == live[live_rva:live_rva + 16]
            print(f"  {name:<20} dump 0x{rva:06x} -> live 0x{live_rva:06x} "
                  f"({'OK' if same else 'DIFERE'})")

    # resolve o ponteiro do dispatcher com o RVA corrigido
    print("\n=== ponteiro do dispatcher (RVA corrigido) ===")
    dispatcher_rva = 0x12c40 + delta
    code = live[dispatcher_rva:dispatcher_rva + 32]
    print(f"  live 0x{dispatcher_rva:06x}: {code[:16].hex(' ')}")
    if code[:3] == b"\x4c\x8b\x35":
        disp = struct.unpack_from("<i", code, 3)[0]
        ptr_rva = dispatcher_rva + 7 + disp
        value = struct.unpack_from("<Q", live, ptr_rva)[0]
        print(f"  mov r14,[rip+0x{disp & 0xFFFFFFFF:x}] -> RVA 0x{ptr_rva:x}")
        print(f"  valor: 0x{value:016x}")
        if value:
            print(f"  ENDERECO LIVE: 0x{base + value:x}" if value < 0x328000
                  else f"  (aponta para fora do modulo: 0x{value:x})")


main()
