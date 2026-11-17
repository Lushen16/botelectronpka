"""Resolve o alvo do dispatch medindo o que o codigo ja gravou.

Cadeia em 0x1db40 (build live):

    0x1db9a  call 0x284b0          ; lookup(tipo) -> rax
    0x1db9f  mov edx, [rax]        ; edx = OFFSET
    0x1dba1  mov [0x224d10], edx   ; <<< grava o offset usado
    0x1dbdd  call r10              ; r10 = [0x224cd0] (exe base) + offset

Portanto, sem precisar reverter o lookup:
  - [0x224d10] guarda o ULTIMO offset despachado
  - alvo real = [0x224cd0] + [0x224d10]

Isso e' medicao, nao inferencia. Se o bot atacou ao menos uma vez, o valor
esta' la'.

  python tools/tap_dispatch_measured.py <pid>
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

BASE_PTR_RVA = 0x224CD0     # [rip+0x207111]
LAST_OFFSET_RVA = 0x224D10  # [rip+0x207169] / [rip+0x207122]
TYPE_RVA = 0x224D14         # [rip+0x20717a]


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
                return f"{name}+0x{value - base:x}"
        return "fora de modulo"

    stomped = next((m for m in mods if "msftedit" in m[2].lower()), None)
    if not stomped:
        print("msftedit nao carregada")
        return
    base = stomped[0]

    raw_base = read(base + BASE_PTR_RVA, 8)
    raw_offset = read(base + LAST_OFFSET_RVA, 4)
    raw_type = read(base + TYPE_RVA, 4)
    if not raw_base:
        print("nao consegui ler a base")
        return

    dispatch_base = struct.unpack("<Q", raw_base)[0]
    last_offset = struct.unpack("<I", raw_offset)[0] if raw_offset else None
    current_type = struct.unpack("<I", raw_type)[0] if raw_type else None

    print(f"msftedit base        = 0x{base:x}")
    print(f"[0x{BASE_PTR_RVA:x}] base de dispatch = 0x{dispatch_base:x} "
          f"({owner(dispatch_base)})")
    print(f"[0x{TYPE_RVA:x}] tipo corrente       = {current_type}")
    print(f"[0x{LAST_OFFSET_RVA:x}] ultimo offset     = "
          + (f"0x{last_offset:x}" if last_offset is not None else "ilegivel"))

    if not last_offset:
        print("\noffset ainda é 0: o dispatcher nao despachou nada desde que subiu.")
        print("ataque um monstro no jogo e rode de novo.")
        return

    target = dispatch_base + last_offset
    print(f"\n>>> ALVO DO ULTIMO DISPATCH = 0x{target:x}")
    print(f"    = exe base + 0x{last_offset:x}")
    print(f"    dono: {owner(target)}")

    code = read(target, 48)
    if code:
        print(f"\n    bytes: {code.hex(' ')}")
        print(f"    comeca com: {code[:4].hex(' ')}"
              + ("  (prologo push/mov tipico)" if code[0] in (0x40, 0x48, 0x4C, 0x55, 0x53) else ""))
    else:
        print("\n    nao consegui ler o alvo (pode ser thunk em outra pagina)")

    # le tambem os 3 dwords vizinhos para contexto
    print("\n=== estado do dispatcher ===")
    block = read(base + 0x224D00, 0x20)
    if block:
        for i in range(0, 0x20, 4):
            value = struct.unpack_from("<I", block, i)[0]
            mark = ""
            if 0x224D00 + i == LAST_OFFSET_RVA:
                mark = "  <- ultimo offset"
            elif 0x224D00 + i == TYPE_RVA:
                mark = "  <- tipo"
            print(f"  0x{0x224D00 + i:06x}: {value:12d} 0x{value:08x}{mark}")


main()
