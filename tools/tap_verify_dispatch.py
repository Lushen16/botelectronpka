"""Compara o codigo do dispatcher no dump estatico com o processo vivo.

Se os bytes em 0x12c64 forem diferentes, o dump nao corresponde a build que
esta rodando - e todo RVA calculado nele e' invalido.

  python tools/tap_verify_dispatch.py <pid>
"""
import ctypes
import struct
import sys
from ctypes import wintypes
from pathlib import Path

import pefile

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "dumps" / "payload_reconstructed.dll"
RVA = 0x12c64

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


def read(handle, address, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size,
                                 ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def main():
    pid = int(sys.argv[1])
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return

    snap = k32.CreateToolhelp32Snapshot(0x8, pid)
    entry = ME()
    entry.dwSize = ctypes.sizeof(entry)
    base = None
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        if "msftedit" in entry.szModule.decode("latin1").lower():
            base = entry.modBaseAddr
            break
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    if not base:
        print("msftedit nao encontrada")
        return

    static = pefile.PE(str(DUMP)).get_memory_mapped_image()
    print(f"msftedit live base = 0x{base:x}")
    print(f"RVA verificada     = 0x{RVA:x}")

    live = read(handle, base + RVA, 32)
    dump = static[RVA:RVA + 32]
    print(f"\nlive : {live.hex(' ')}")
    print(f"dump : {dump.hex(' ')}")
    print(f"iguais: {live == dump}")

    if live and live[:3] == b"\x4c\x8b\x35":
        disp = struct.unpack_from("<i", live, 3)[0]
        target = RVA + 7 + disp
        print(f"\nlive disp = 0x{disp & 0xFFFFFFFF:x} -> RVA 0x{target:x}")
        value_bytes = read(handle, base + target, 8)
        if value_bytes:
            value = struct.unpack("<Q", value_bytes)[0]
            print(f"valor live nesse RVA: 0x{value:016x}")
        dump_value = struct.unpack_from("<Q", static, target)[0]
        print(f"valor no dump       : 0x{dump_value:016x}")

    # procura o padrao do dispatcher em qualquer lugar do modulo live
    print("\nprocurando 'mov r14,[rip+disp]' (4c 8b 35) em msftedit live...")
    code = read(handle, base, 0x328000)
    if code:
        hits = []
        for i in range(len(code) - 7):
            if code[i:i + 3] == b"\x4c\x8b\x35":
                disp = struct.unpack_from("<i", code, i + 3)[0]
                target = (i + 7 + disp) & 0xFFFFFFFF
                hits.append((i, target))
        print(f"encontrados: {len(hits)}")
        for site, target in hits[:10]:
            raw = read(handle, base + target, 8)
            value = struct.unpack("<Q", raw)[0] if raw else 0
            print(f"  0x{site:06x} -> RVA 0x{target:06x} = 0x{value:016x}")


main()
