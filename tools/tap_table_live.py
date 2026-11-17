"""Le a tabela de dispatch do processo vivo e confirma para onde cada entrada
aponta de verdade.

A tabela em msftedit RVA 0xe53b0 tem entradas de 0x20 bytes. O primeiro dword
de cada entrada parece ser um RVA dentro do PokeAlliance_dx.exe. Em arquivo
esses RVAs estao zerados (secao nao inicializada / relocada), entao a leitura
tem que ser no processo.

  python tools/tap_table_live.py <pid>
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

TABLE_START = 0xE53B0
TABLE_END = 0xE5730
STRIDE = 0x20


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

    def read(address, size):
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t()
        if not k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size,
                                     ctypes.byref(got)):
            return None
        return buf.raw[:got.value]

    snap = k32.CreateToolhelp32Snapshot(0x8, pid)
    entry = ME()
    entry.dwSize = ctypes.sizeof(entry)
    mods = []
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        mods.append((entry.modBaseAddr or 0, entry.modBaseSize or 0,
                     entry.szModule.decode("latin1")))
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)

    def owner(value):
        for base, size, name in mods:
            if base <= value < base + size:
                return name, value - base
        return None, None

    stomped = next((m for m in mods if "msftedit" in m[2].lower()), None)
    exe = next((m for m in mods if m[2].lower().startswith("pokealliance_dx")), None)
    if not stomped or not exe:
        print("modulos faltando")
        return
    base = stomped[0]
    exe_base = exe[0]
    print(f"msftedit base = 0x{base:x}")
    print(f"exe base      = 0x{exe_base:x}")

    raw = read(base + TABLE_START, TABLE_END - TABLE_START)
    if not raw:
        print("nao consegui ler a tabela")
        return

    print(f"\n=== tabela live 0x{TABLE_START:x}..0x{TABLE_END:x} ===")
    valid = 0
    for offset in range(0, len(raw), STRIDE):
        if offset + 8 > len(raw):
            break
        first, second = struct.unpack_from("<II", raw, offset)
        if first == 0 and second == 0:
            continue
        valid += 1
        rva = TABLE_START + offset
        print(f"  [{valid:2d}] rva 0x{rva:06x}  first=0x{first:08x} second=0x{second:08x}")
        for label, value in (("first", first), ("second", second)):
            addr = exe_base + value
            name, inner = owner(addr)
            if name:
                code = read(addr, 8)
                hint = code.hex(" ") if code else "ilegivel"
                zero = " ZERADO" if code and not any(code) else ""
                print(f"        {label} -> {name}+0x{inner:x}  {hint}{zero}")
            else:
                # pode ser RVA no proprio msftedit
                alt_name, alt_inner = owner(base + value)
                if alt_name:
                    code = read(base + value, 8)
                    print(f"        {label} -> {alt_name}+0x{alt_inner:x}  "
                          f"{code.hex(' ') if code else 'ilegivel'}")
                else:
                    print(f"        {label} -> fora de modulo")
    print(f"\nentradas nao-nulas: {valid}")


main()
