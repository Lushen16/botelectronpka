"""Resolve o alvo final do dispatch em 0x1db40.

A cadeia, do desmonte da build live:

    0x1db94  mov ecx, [rip+0x20717a]   ; RVA 0x224d14  (tipo/indice)
    0x1db9a  call 0x284b0              ; lookup -> rax aponta para o offset
    0x1db9f  mov edx, [rax]            ; edx = offset do campo
    0x1dbaa  call 0x284b0              ; outro lookup
    0x1dbb5  mov r10d, [rax]           ; r10d = offset
    0x1dbb8  add r10, [rip+0x207111]   ; + RVA 0x224cd0  (base)
    0x1dbdd  call r10                  ; <<< CHAMADA FINAL

Ou seja: alvo = base_runtime(0x224cd0) + offset_do_lookup(tipo).

  python tools/tap_resolve_dispatch.py <pid>
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

BASE_RVA = 0x224CD0
TYPE_RVA = 0x224D14


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
        return None

    stomped = next((m for m in mods if "msftedit" in m[2].lower()), None)
    if not stomped:
        print("msftedit nao carregada")
        return
    base, size, name = stomped
    print(f"{name} base=0x{base:x}")

    base_raw = read(base + BASE_RVA, 8)
    type_raw = read(base + TYPE_RVA, 4)
    if not base_raw:
        print("nao consegui ler a base em 0x224cd0")
        return
    dispatch_base = struct.unpack("<Q", base_raw)[0]
    current_type = struct.unpack("<I", type_raw)[0] if type_raw else None

    print(f"\nbase de dispatch [0x{BASE_RVA:x}] = 0x{dispatch_base:x}")
    where = owner(dispatch_base)
    print(f"  dono: {where or 'fora de modulo'}")

    print(f"tipo corrente [0x{TYPE_RVA:x}] = {current_type}")

    # le a tabela de lookup: 0xe53b0..0xe5730 e 0xe5990..0xe5ad0 (passo 0x20)
    print("\n=== tabela de lookup (tipo -> offset) ===")
    for start, end, label in ((0xE53B0, 0xE5730, "faixa A"),
                              (0xE5990, 0xE5AD0, "faixa B"),
                              (0xE6970, 0xE6CF0, "faixa C")):
        raw = read(base + start, end - start)
        if not raw:
            print(f"  {label}: ilegivel")
            continue
        count = 0
        for offset in range(0, len(raw), 0x20):
            if offset + 4 > len(raw):
                break
            key = struct.unpack_from("<I", raw, offset)[0]
            if key == 0 or key > 0x1000:
                continue
            count += 1
            if count <= 6:
                print(f"  {label} tipo={key:3d} @ RVA 0x{start + offset:x}")
        print(f"  {label}: {count} entradas validas")

    # candidato: alvo = base + offset. testa com o tipo corrente
    if current_type is not None:
        print(f"\n=== candidatos de alvo para tipo={current_type} ===")
        for start, end in ((0xE53B0, 0xE5730), (0xE5990, 0xE5AD0), (0xE6970, 0xE6CF0)):
            raw = read(base + start, end - start)
            if not raw:
                continue
            for offset in range(0, len(raw), 0x20):
                if offset + 4 > len(raw):
                    break
                key = struct.unpack_from("<I", raw, offset)[0]
                if key != current_type:
                    continue
                field = struct.unpack_from("<I", raw, offset + 4)[0] if offset + 8 <= len(raw) else 0
                target = dispatch_base + field
                print(f"  RVA 0x{start + offset:x}: tipo={key} offset=0x{field:x} "
                      f"-> alvo 0x{target:x} ({owner(target) or 'fora'})")
                code = read(target, 16)
                if code:
                    print(f"      bytes: {code.hex(' ')}")

    # tambem mostra o valor cru da base, para nao depender de suposicao
    print("\n=== primeiros 32 bytes da base de dispatch ===")
    data = read(dispatch_base, 32)
    if data:
        for i in range(0, 32, 8):
            value = struct.unpack_from("<Q", data, i)[0]
            label = owner(value) if value > 0x10000 else "escalar"
            print(f"  +0x{i:x}: 0x{value:016x}  {label}")


main()
