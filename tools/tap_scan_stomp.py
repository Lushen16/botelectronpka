"""Existe `call qword [rip+disp32]` dentro das regioes executaveis de msftedit?

O stomp scanner do tap depende desse padrao. Se nao houver nenhum, o runtime
delimitador nao chama WriteFile pela IAT nem por thunk — usa outro caminho.
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
PAGE_EXECUTE = 0x10


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_ulonglong),
        ("AllocationBase", ctypes.c_ulonglong),
        ("AllocationProtect", wintypes.DWORD),
        ("__a1", wintypes.DWORD),
        ("RegionSize", ctypes.c_ulonglong),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("__a2", wintypes.DWORD),
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
    size = int(sys.argv[3], 16) if len(sys.argv) > 3 else 0x328000

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess falhou:", ctypes.get_last_error())
        return

    print(f"msftedit base=0x{base:x} size=0x{size:x}")
    head = read(handle, base, 0x1000)
    print("header MZ?", head[:2] if head else None,
          "| zeros nos primeiros 0x1000:", head and all(b == 0 for b in head))

    mbi = MBI()
    addr = base
    end = base + size
    total_call = 0
    total_jmp = 0
    exec_regions = 0

    while addr < end:
        if not k32.VirtualQueryEx(handle, ctypes.c_void_p(addr), ctypes.byref(mbi),
                                  ctypes.sizeof(mbi)):
            break
        region_base = mbi.BaseAddress
        region_size = mbi.RegionSize
        is_exec = (mbi.State == MEM_COMMIT
                   and (mbi.Protect & (PAGE_EXECUTE | 0x20 | 0x40 | 0x80))
                   and not (mbi.Protect & PAGE_GUARD))
        if is_exec and region_size:
            data = read(handle, region_base, min(region_size, 0x400000))
            if data:
                exec_regions += 1
                for i in range(len(data) - 6):
                    if data[i] == 0xFF and data[i + 1] == 0x15:
                        total_call += 1
                    elif data[i] == 0xFF and data[i + 1] == 0x25:
                        total_jmp += 1
        if region_base + region_size <= addr:
            break
        addr = region_base + region_size

    print(f"regioes executaveis varridas: {exec_regions}")
    print(f"call qword [rip+disp] (ff 15): {total_call}")
    print(f"jmp  qword [rip+disp] (ff 25): {total_jmp}")
    if total_call == 0 and total_jmp == 0:
        print("\nNAO HA leitura indireta por slot nesse modulo.")
        print("O runtime nao chama WriteFile pela IAT nem por thunk de import.")


main()
