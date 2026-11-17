"""Identifica a entrada de dispatch de attack/follow.

O dispatcher (msftedit 0x15280) recebe `dl` = modo:
    dl = 0  -> "attack"
    dl = 1  -> "follow"

E indexa a tabela com `(modo + 0x253) << 4`. Mas a tabela de 0xe53b0 tem
stride 0x20 e e' indexada por um lookup em 0x284b0 que usa o TIPO do alvo,
nao o modo. Sao duas coisas diferentes:

  - modo (dl): attack vs follow
  - tipo: qual funcao do jogo executar

Este script lista todas as entradas com o codigo do handler, para localizar
qual delas e' a de ataque.

  python tools/tap_classify_entries.py <pid>
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

RANGES = ((0xE53B0, 0xE5730), (0xE5990, 0xE5AD0), (0xE6970, 0xE6CF0))
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

    stomped = next((m for m in mods if "msftedit" in m[2].lower()), None)
    exe = next((m for m in mods if m[2].lower().startswith("pokealliance_dx")), None)
    if not stomped or not exe:
        print("modulos faltando")
        return
    base, exe_base = stomped[0], exe[0]

    total = 0
    for start, end in RANGES:
        raw = read(base + start, end - start)
        if not raw:
            continue
        print(f"\n=== 0x{start:06x}..0x{end:06x} ===")
        print(f"{'idx':>3} {'rva':>10} {'handler RVA':>12}  bytes")
        for index in range(0, len(raw), STRIDE):
            if index + 8 > len(raw):
                break
            first, second = struct.unpack_from("<II", raw, index)
            if first == 0 and second == 0:
                continue
            total += 1
            code = read(exe_base + second, 12)
            hint = code.hex(" ") if code else "ilegivel"
            zero = " (ZERADO)" if code and not any(code) else ""
            print(f"{total:3d} 0x{start + index:08x} 0x{second:08x}  {hint}{zero}")

    print(f"\ntotal de entradas: {total}")
    print("\nO handler e' o SEGUNDO dword; o primeiro e' provavelmente vtable/typeinfo.")


main()
