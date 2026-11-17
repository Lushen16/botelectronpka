"""Le a tabela de dispatch dentro do exe do jogo e mostra o que cada entrada
devolve.

O dispatcher (msftedit RVA 0x15280) faz:

    mov r14, [rip+0x20fa05]   ; r14 = &tabela
    lea edx, [rbp+0x253]      ; indice = modo + 0x253
    shl edx, 4                ; * 16
    call 0x1f470              ; valida a tabela (compara rva com 0x39c4d60)
    call 0x4e80               ; resolve o alvo a partir de [tabela + indice]

A tabela vive no PokeAlliance_dx.exe em RVA 0x39c4d60.

  python tools/tap_dispatch_table.py <pid>
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TABLE_RVA = 0x39C4D60


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

    exe = next((m for m in mods if m[2].lower().startswith("pokealliance_dx")), None)
    if not exe:
        print("exe do jogo nao encontrado")
        return
    exe_base = exe[0]
    table = exe_base + TABLE_RVA
    print(f"exe base     = 0x{exe_base:x}")
    print(f"tabela       = exe + 0x{TABLE_RVA:x} = 0x{table:x}")

    def owner(value):
        for base, size, name in mods:
            if base <= value < base + size:
                return f"{name}+0x{value - base:x}"
        return "fora de modulo"

    print("\n=== entradas por modo ===")
    for mode in range(0, 8):
        index = (mode + 0x253) << 4
        raw = read(table + index, 16)
        if not raw:
            print(f"  modo={mode}  idx=0x{index:x}  ilegivel")
            continue
        q0, q1 = struct.unpack("<QQ", raw)
        print(f"  modo={mode}  idx=0x{index:x}  q0=0x{q0:016x} q1=0x{q1:016x}")
        for label, value in (("q0", q0), ("q1", q1)):
            if value > 0x10000:
                print(f"      {label} -> {owner(value)}")
                data = read(value, 32)
                if data:
                    print(f"           {data.hex(' ')}")

    # varre uma faixa maior para ver o formato da tabela
    print("\n=== faixa da tabela (modo -4..+8) ===")
    for mode in range(-4, 9):
        index = (mode + 0x253) << 4
        raw = read(table + index, 16)
        if not raw:
            continue
        q0, q1 = struct.unpack("<QQ", raw)
        if q0 or q1:
            print(f"  modo={mode:3d}  q0=0x{q0:016x}  q1=0x{q1:016x}  "
                  f"{owner(q1) if q1 > 0x10000 else ''}")


main()
