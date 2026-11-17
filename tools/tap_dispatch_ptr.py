"""Resolve, no processo vivo, o ponteiro que o dispatcher nativo usa.

No desmonte estatico (dumps/payload_reconstructed.dll):

    0x12c64  mov r14, qword ptr [rip + 0x210a95]

Esse `r14` e' a base usada para achar a funcao de dispatch:

    0x12c6b  lea rcx, [rbp + 0x253]
    0x12c72  shl rcx, 4
    0x12c78  add rcx, r14
    0x12c7b  call 0x4dc0          ; resolve

Logo, `r14` e' uma tabela. O que esta' gravado naquele endereco so' existe em
runtime - o dump estatico tem zero ali. Este script le o valor real.

  python tools/tap_dispatch_ptr.py <pid>
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TH32CS_SNAPMODULE = 0x8

# RVA calculado do desmonte estatico: 0x12c64 + 7 + 0x210a95
DISPATCH_PTR_RVA = 0x12c64 + 7 + 0x210a95


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
    if len(sys.argv) < 2:
        print("uso: python tools/tap_dispatch_ptr.py <pid>")
        return
    pid = int(sys.argv[1])

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return

    mods = modules(pid)
    stomped = next((m for m in mods if "msftedit" in m[2].lower()), None)
    if not stomped:
        print("msftedit nao carregada neste processo")
        return
    base, size, name = stomped
    print(f"{name} base=0x{base:x} size=0x{size:x}")

    ptr_addr = base + DISPATCH_PTR_RVA
    print(f"endereco do ponteiro: base + 0x{DISPATCH_PTR_RVA:x} = 0x{ptr_addr:x}")

    raw = read(handle, ptr_addr, 8)
    if not raw:
        print("nao consegui ler (regiao nao mapeada ou sem permissao)")
        return

    value = struct.unpack("<Q", raw)[0]
    print(f"valor: 0x{value:016x}")

    if value == 0:
        print("\nPONTEIRO NULO: a tabela so' e' preenchida quando o runtime "
              "inicializa. O bot precisa ter rodado ao menos uma vez.")
        return

    owner, offset = owner_of(value, mods)
    if owner:
        print(f"\naponta para: {owner}+0x{offset:x}")
    else:
        print("\naponta para fora de qualquer modulo (heap alocado em runtime)")

    # despeja os primeiros slots da tabela
    print("\nprimeiros 8 qwords da tabela (o dispatcher indexa com <<4):")
    table = read(handle, value, 8 * 12)
    if table:
        for i in range(0, min(len(table), 8 * 12), 8):
            entry = struct.unpack_from("<Q", table, i)[0]
            entry_owner, entry_offset = owner_of(entry, mods)
            label = f"{entry_owner}+0x{entry_offset:x}" if entry_owner else "?"
            print(f"  [{i // 8:2d}] 0x{entry:016x}  {label}")


main()
