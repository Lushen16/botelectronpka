"""Confere se GetProcAddress(kernel32,WriteFile) == conteudo do slot de msftedit.

Se nao for igual, o scanner nunca casa mesmo com real_WriteFile preenchido, e a
comparacao precisa ser por faixa (dentro de KERNEL32) em vez de igualdade exata.
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
        ("AllocationProtect", wintypes.DWORD), ("__a1", wintypes.DWORD),
        ("RegionSize", ctypes.c_ulonglong), ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD), ("__a2", wintypes.DWORD),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                               ctypes.POINTER(MBI), ctypes.c_size_t]


def read(handle, address, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size,
                                 ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def main():
    pid = int(sys.argv[1])
    target_base = int(sys.argv[2], 16)
    target_size = int(sys.argv[3], 16)

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return

    # endereco real visto de DENTRO do alvo: le a IAT do proprio jogo
    # (PokeAlliance_dx.exe importa WriteFile tambem)
    mbi = MBI()
    addr = target_base
    end = target_base + target_size
    slots = {}

    while addr < end:
        if not k32.VirtualQueryEx(handle, ctypes.c_void_p(addr), ctypes.byref(mbi),
                                  ctypes.sizeof(mbi)):
            break
        rb, rs = mbi.BaseAddress, mbi.RegionSize
        is_exec = (mbi.State == MEM_COMMIT
                   and (mbi.Protect & (0x10 | 0x20 | 0x40 | 0x80))
                   and not (mbi.Protect & PAGE_GUARD))
        if is_exec and rs:
            data = read(handle, rb, min(rs, 0x400000))
            if data:
                for i in range(len(data) - 6):
                    if data[i] == 0xFF and data[i + 1] == 0x15:
                        disp = struct.unpack_from("<i", data, i + 2)[0]
                        slot = (rb + i + 6 + disp) & 0xFFFFFFFFFFFFFFFF
                        slots[slot] = slots.get(slot, 0) + 1
        if rb + rs <= addr:
            break
        addr = rb + rs

    # agrupa valores de slot
    values = {}
    for slot in slots:
        raw = read(handle, slot, 8)
        if not raw:
            continue
        value = struct.unpack("<Q", raw)[0]
        values[value] = values.get(value, 0) + 1

    top = sorted(values.items(), key=lambda kv: -kv[1])[:14]
    print("=== valores de slot mais frequentes em msftedit ===")
    for value, count in top:
        print(f"  0x{value:016x}  {count} slots")


main()
