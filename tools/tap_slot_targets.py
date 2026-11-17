"""Resolve os call [rip+disp] de msftedit e mostra o que cada slot contém.

Compara com o endereço real de WriteFile/ReadFile do processo. Se os slots
apontarem para algo diferente, o stomp scanner nunca vai casar - e precisamos
saber para onde apontam (kernelbase? outro módulo? um thunk interno?).
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100

TH32CS_SNAPMODULE = 0x8


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
        ("AllocationProtect", wintypes.DWORD), ("__a1", wintypes.DWORD),
        ("RegionSize", ctypes.c_ulonglong), ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD), ("__a2", wintypes.DWORD),
    ]


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
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                               ctypes.POINTER(MBI), ctypes.c_size_t]
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


def modules(pid):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid)
    entry = ME()
    entry.dwSize = ctypes.sizeof(entry)
    out = []
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        out.append((entry.modBaseAddr or 0, entry.modBaseSize or 0,
                    entry.szModule.decode("latin1")))
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    return out


def owner_of(address, mods):
    for base, size, name in mods:
        if base <= address < base + size:
            return name, address - base
    return None, None


def main():
    pid = int(sys.argv[1])
    target_base = int(sys.argv[2], 16)
    target_size = int(sys.argv[3], 16)

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return
    mods = modules(pid)

    mbi = MBI()
    addr = target_base
    end = target_base + target_size
    slots = {}

    while addr < end:
        if not k32.VirtualQueryEx(handle, ctypes.c_void_p(addr), ctypes.byref(mbi),
                                  ctypes.sizeof(mbi)):
            break
        region_base, region_size = mbi.BaseAddress, mbi.RegionSize
        is_exec = (mbi.State == MEM_COMMIT
                   and (mbi.Protect & (0x10 | 0x20 | 0x40 | 0x80))
                   and not (mbi.Protect & PAGE_GUARD))
        if is_exec and region_size:
            data = read(handle, region_base, min(region_size, 0x400000))
            if data:
                for i in range(len(data) - 6):
                    if data[i] == 0xFF and data[i + 1] in (0x15, 0x25):
                        disp = struct.unpack_from("<i", data, i + 2)[0]
                        site = region_base + i
                        slot_addr = (site + 6 + disp) & 0xFFFFFFFFFFFFFFFF
                        slots.setdefault(slot_addr, []).append(site)
        if region_base + region_size <= addr:
            break
        addr = region_base + region_size

    print(f"call/jmp [rip+disp] encontrados: {sum(len(v) for v in slots.values())}")
    print(f"slots unicos: {len(slots)}")

    # le cada slot unico
    resolved = {}
    for slot_addr, sites in slots.items():
        raw = read(handle, slot_addr, 8)
        if not raw:
            resolved[slot_addr] = ("ilegivel", 0, sites)
            continue
        value = struct.unpack("<Q", raw)[0]
        owner, offset = owner_of(value, mods)
        resolved[slot_addr] = (owner or "fora de modulo", offset, sites)

    # agrupa por dono
    summary = {}
    for slot_addr, (owner, offset, sites) in resolved.items():
        summary.setdefault(owner, []).append((slot_addr, offset, len(sites)))

    print("\n=== destinos dos slots (por modulo) ===")
    for owner, items in sorted(summary.items(), key=lambda kv: -len(kv[1])):
        print(f"  {owner:<30} {len(items)} slots")

    print("\n=== amostra de 12 slots com endereco ===")
    for slot_addr, (owner, offset, sites) in list(resolved.items())[:12]:
        print(f"  slot 0x{slot_addr:x} -> {owner}+0x{offset or 0:x}  ({len(sites)} sites)")

    handle_close = k32.CloseHandle(handle)


main()
