"""O endereco real de WriteFile/ReadFile aparece como conteudo de algum slot
em msftedit?

Se aparecer: o scanner deveria casar, e o bug esta no codigo do tap.
Se NAO aparecer: o runtime delimitador nao guarda o ponteiro num slot RIP-
relative, e hook de IAT/thunk nao se aplica.
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
    base = int(sys.argv[2], 16)
    size = int(sys.argv[3], 16)
    k32_base = int(sys.argv[4], 16)

    # offsets reais dentro de kernel32 (calculados no processo atual, que
    # compartilha a base do kernel32 com o alvo)
    local = ctypes.WinDLL("kernel32")
    obj = local._handle
    addresses = {}
    for name in ("WriteFile", "ReadFile"):
        address = ctypes.cast(getattr(local, name), ctypes.c_void_p).value
        addresses[name] = address

    print("=== enderecos no processo atual (kernel32 compartilhado) ===")
    for name, address in addresses.items():
        print(f"  {name:<10} 0x{address:016x}")

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return

    mbi = MBI()
    addr = base
    end = base + size
    slots = set()

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
                    if data[i] == 0xFF and data[i + 1] in (0x15, 0x25):
                        disp = struct.unpack_from("<i", data, i + 2)[0]
                        slots.add((rb + i + 6 + disp) & 0xFFFFFFFFFFFFFFFF)
        if rb + rs <= addr:
            break
        addr = rb + rs

    print(f"\nslots unicos em msftedit: {len(slots)}")

    values = {}
    for slot in slots:
        raw = read(handle, slot, 8)
        if raw:
            values[struct.unpack("<Q", raw)[0]] = slot

    print(f"valores legiveis: {len(values)}")

    print("\n=== procura os enderecos reais entre os slots ===")
    for name, address in addresses.items():
        if address in values:
            print(f"  {name:<10} ENCONTRADO no slot 0x{values[address]:x}")
        else:
            offset = address - k32_base
            print(f"  {name:<10} nao esta nos slots (offset kernel32+0x{offset:x})")

    print("\n=== todos os valores que caem em kernel32 ===")
    inside = sorted(
        ((value, slot) for value, slot in values.items()
         if k32_base <= value < k32_base + 0xcb000),
        key=lambda kv: kv[0],
    )
    for value, slot in inside:
        print(f"  kernel32+0x{value - k32_base:06x}  slot 0x{slot:x}")


main()
