"""Verifica, no processo vivo, se a IAT de ReadFile/WriteFile de msftedit.dll
aponta para o thunk do pka_tap.dll ou para a implementacao real.

Se apontar para a real, o hook nao pegou (por isso a captura fica em 0 bytes).
Se apontar para dentro do pka_tap, o hook esta instalado e o problema e outro
(filtro, flush ou handle).
"""
import ctypes
import struct
import sys
from ctypes import wintypes

import pefile

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


class MEMORY_BASIC_INFORMATION64(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_ulonglong),
        ("AllocationBase", ctypes.c_ulonglong),
        ("AllocationProtect", wintypes.DWORD),
        ("__alignment1", wintypes.DWORD),
        ("RegionSize", ctypes.c_ulonglong),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("__alignment2", wintypes.DWORD),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.restype = wintypes.BOOL
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                               ctypes.POINTER(MEMORY_BASIC_INFORMATION64), ctypes.c_size_t]


def read(handle, address, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    ok = k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size, ctypes.byref(got))
    if not ok:
        return None
    return buf.raw[:got.value]


def module_base(handle, image):
    """Acha a base real do modulo procurando o MZ/PE cujo tamanho de imagem bate
    com o arquivo. Simples: enumera regioes e procura assinatura PE, casando
    por nome via Toolhelp seria melhor, mas aqui basta achar 'msftedit' pelo
    tamanho do modulo (0x328000)."""
    address = 0x10000
    mbi = MEMORY_BASIC_INFORMATION64()
    while address < 0x7FFFFFFFFFFF:
        if not k32.VirtualQueryEx(handle, ctypes.c_void_p(address),
                                  ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        if mbi.State == 0x1000 and mbi.Type == 0x1000000:  # MEM_COMMIT | MEM_IMAGE
            if mbi.RegionSize and mbi.AllocationBase == mbi.BaseAddress:
                head = read(handle, mbi.BaseAddress, 0x1000)
                if head and head[:2] == b"MZ":
                    pe_off = struct.unpack_from("<I", head, 0x3C)[0]
                    if pe_off + 0x40 < len(head) and head[pe_off:pe_off + 4] == b"PE\0\0":
                        size_of_image = struct.unpack_from("<I", head, pe_off + 0x50)[0]
                        if size_of_image == image:
                            return mbi.BaseAddress
        address = mbi.BaseAddress + mbi.RegionSize
    return None


def main():
    if len(sys.argv) < 2:
        print("uso: python tools/tap_iat_check.py <pid>")
        return
    pid = int(sys.argv[1])
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess falhou:", ctypes.get_last_error())
        return

    # msftedit stompada: 0x328000 bytes de imagem
    base = module_base(handle, 0x328000)
    if not base:
        print("msftedit (imagem 0x328000) nao encontrada no processo")
        return
    print(f"msftedit base = 0x{base:x}")

    # le o header do modulo vivo para achar a IAT
    head = read(handle, base, 0x1000)
    pe_off = struct.unpack_from("<I", head, 0x3C)[0]
    ntsig_off = pe_off + 4
    section_count = struct.unpack_from("<H", head, ntsig_off + 2)[0]
    opt_size = struct.unpack_from("<H", head, ntsig_off + 16)[0]
    opt_off = ntsig_off + 20
    import_rva, import_size = struct.unpack_from("<II", head, opt_off + 112)
    print(f"import dir: rva=0x{import_rva:x} size=0x{import_size:x}")

    data = read(handle, base + import_rva, import_size)
    if not data:
        print("nao consegui ler a tabela de import")
        return

    index = 0
    while True:
        entry = data[index * 20: index * 20 + 20]
        if len(entry) < 20:
            break
        oft, _, _, name_rva, ft = struct.unpack("<IIIII", entry)
        if not name_rva:
            break
        dll_name = read(handle, base + name_rva, 64).split(b"\0")[0].decode("latin1")
        if "api-ms-win-core-file" in dll_name or "kernel32" in dll_name.lower():
            thunks = read(handle, base + oft, 8 * 40)
            names = read(handle, base + ft, 8 * 40) if ft else None
            for i in range(40):
                thunk = struct.unpack_from("<Q", thunks, i * 8)[0]
                if thunk == 0:
                    break
                if thunk & 0x8000000000000000:
                    continue
                hint_name = read(handle, base + (thunk & 0x7FFFFFFF), 64)
                fn = hint_name[2:].split(b"\0")[0].decode("latin1")
                if fn in ("ReadFile", "WriteFile"):
                    slot = struct.unpack_from("<Q", names, i * 8)[0]
                    print(f"{dll_name:<38} {fn:<10} IAT aponta para 0x{slot:x}")
        index += 1
        if index > 200:
            break


main()
