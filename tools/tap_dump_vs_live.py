"""O dump estatico corresponde ao modulo que esta' rodando?

O dump (dumps/payload_reconstructed.dll, de 22/10) tem hash diferente do modulo
live (v3.3.1 de hoje). Se o codigo tambem diferir, TODO RVA derivado da analise
estatica (dispatcher 0x12c40, regras em 0x57020/0x9d240, etc) aponta para o
lugar errado no processo atual.

Compara por blocos para dizer se e' deslocamento (mesmo codigo, offset
diferente) ou build diferente (codigo distinto).

  python tools/tap_dump_vs_live.py <pid>
"""
import ctypes
import hashlib
import struct
import sys
from ctypes import wintypes
from pathlib import Path

import pefile

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "dumps" / "payload_reconstructed.dll"

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
BLOCK = 0x1000


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
    if not base:
        print("msftedit nao encontrada")
        return

    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(base), buf, size,
                                 ctypes.byref(got)):
        print("nao consegui ler o modulo")
        return
    live = buf.raw[:got.value]

    dump = pefile.PE(str(DUMP)).get_memory_mapped_image()
    print(f"live : {len(live)} bytes  sha={hashlib.sha256(live).hexdigest()[:16]}")
    print(f"dump : {len(dump)} bytes  sha={hashlib.sha256(dump).hexdigest()[:16]}")
    print(f"tamanhos iguais: {len(live) == len(dump)}")

    n = min(len(live), len(dump))
    same = 0
    diff = 0
    first_diff = None
    zero_live = 0
    for offset in range(0, n, BLOCK):
        a = live[offset:offset + BLOCK]
        b = dump[offset:offset + BLOCK]
        if a == b:
            same += 1
        else:
            diff += 1
            if first_diff is None:
                first_diff = offset
        if not any(a):
            zero_live += 1

    total = same + diff
    print(f"\nblocos de 0x{BLOCK:x}: {total}")
    print(f"  iguais    : {same} ({100 * same / total:.1f}%)")
    print(f"  diferentes: {diff} ({100 * diff / total:.1f}%)")
    print(f"  zerados no live: {zero_live}")
    if first_diff is not None:
        print(f"  primeiro bloco diferente: 0x{first_diff:x}")

    # o mesmo codigo aparece deslocado? procura o prologo do dispatcher
    print("\nprocurando o dispatcher estatico (0x12c40) no live...")
    signature = dump[0x12c40:0x12c40 + 16]
    hits = []
    start = 0
    while True:
        index = live.find(signature, start)
        if index < 0:
            break
        hits.append(index)
        start = index + 1
    if hits:
        print(f"  assinatura achada em: {[hex(h) for h in hits[:6]]}")
        shift = hits[0] - 0x12c40
        print(f"  deslocamento: 0x{shift:x}")
    else:
        print("  nao achada: o codigo do dispatcher mudou entre as builds")

    # e os slots que o tap patcheou? estao no mesmo lugar?
    print("\nslots de import patcheados pelo tap:")
    for site in (0x223f8, 0x22653):
        pass
    print("  (ver tap_slot_targets.py para os enderecos atuais)")


main()
