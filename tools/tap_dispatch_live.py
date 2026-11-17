"""Resolve o ponteiro da tabela do dispatcher na build LIVE.

A funcao esta' em ~0x15200..0x15400 (as tres strings do dispatcher sao
referenciadas ali). O padrao no dump antigo era:

    mov r14, [rip+disp]      ; 4c 8b 35
    lea rcx, [rbp+0x253]
    shl rcx, 4
    add rcx, r14
    call <resolve>

Procuramos `4c 8b 35` (ou `48 8b 35`) nessa regiao e lemos o destino.

  python tools/tap_dispatch_live.py [pid]
"""
import ctypes
import struct
import sys
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "dumps" / "msftedit_live_32036.bin"
SEARCH_START, SEARCH_END = 0x15000, 0x15500

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


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


def live_module(pid, name_part):
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        return None, None, None
    snap = k32.CreateToolhelp32Snapshot(0x8, pid)
    entry = ME()
    entry.dwSize = ctypes.sizeof(entry)
    base = size = None
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        if name_part in entry.szModule.decode("latin1").lower():
            base, size = entry.modBaseAddr, entry.modBaseSize
            break
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    if not base:
        return None, None, None
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    k32.ReadProcessMemory(handle, ctypes.c_void_p(base), buf, size, ctypes.byref(got))
    k32.CloseHandle(handle)
    return base, size, buf.raw[:got.value]


def main():
    data = DUMP.read_bytes()
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else None
    live = None
    live_base = None
    if pid:
        live_base, _size, live = live_module(pid, "msftedit")
        print(f"processo {pid}: msftedit base=0x{live_base:x}" if live_base
              else f"processo {pid}: msftedit nao encontrada")

    print(f"\nvarrendo 0x{SEARCH_START:x}..0x{SEARCH_END:x} por carregamento de ponteiro:")
    for i in range(SEARCH_START, SEARCH_END - 7):
        # mov rXX, [rip+disp] : 48/4c 8b 05/0d/15/1d/25/2d/35/3d
        if data[i] in (0x48, 0x4C) and data[i + 1] == 0x8B and \
                data[i + 2] in (0x05, 0x0D, 0x15, 0x1D, 0x25, 0x2D, 0x35, 0x3D):
            disp = struct.unpack_from("<i", data, i + 3)[0]
            target = (i + 7 + disp) & 0xFFFFFFFF
            static_value = struct.unpack_from("<Q", data, target)[0] if target + 8 <= len(data) else 0
            line = f"  0x{i:06x}  mov -> RVA 0x{target:06x}"
            if static_value:
                line += f"  dump=0x{static_value:016x}"
                if live_base and static_value < 0x328000:
                    line += f"  live=0x{live_base + static_value:x}"
                    if live:
                        table = struct.unpack_from("<Q", live, static_value)[0] if static_value + 8 <= len(live) else 0
                        line += f"  [0]=0x{table:016x}"
            print(line)

    # tambem procura o padrao shl 4 / add (indice de 16 bytes)
    print("\npadrao 'shl rcx,4' perto (indica tabela de 16 bytes):")
    for i in range(SEARCH_START, SEARCH_END - 4):
        if data[i] == 0x48 and data[i + 1] == 0xC1 and data[i + 2] == 0xE1 and data[i + 3] == 0x04:
            print(f"  0x{i:06x}  shl rcx, 4")


main()
