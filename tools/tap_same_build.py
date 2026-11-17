"""Confere se o dump que analisamos e' do MESMO processo que esta' rodando.

O bot foi reiniciado. Se o dump for de outra sessao, os RVAs podem ter mudado
(ASLR nao muda RVA, mas build diferente muda). Compara bytes em RVAs chave.

  python tools/tap_same_build.py <pid>
"""
import ctypes
import hashlib
import sys
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "dumps" / "msftedit_live_32036.bin"

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

INTERESTING = [0x11CC0, 0x15280, 0x1DB40, 0xE53B0, 0xE5158]


def main():
    pid = int(sys.argv[1])
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return

    snap = k32.CreateToolhelp32Snapshot(0x8, pid)
    entry = ME()
    entry.dwSize = ctypes.sizeof(entry)
    base = size = None
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        if "msftedit" in entry.szModule.decode("latin1").lower():
            base, size = entry.modBaseAddr, entry.modBaseSize
            break
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    if not base:
        print("msftedit nao carregada")
        return

    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(base), buf, size,
                                 ctypes.byref(got)):
        print("nao consegui ler o modulo")
        return
    live = buf.raw[:got.value]
    dump = DUMP.read_bytes()

    print(f"live sha256: {hashlib.sha256(live).hexdigest()[:24]}")
    print(f"dump sha256: {hashlib.sha256(dump).hexdigest()[:24]}")
    print(f"mesma imagem: {live == dump}\n")

    print("=== bytes em RVAs chave ===")
    for rva in INTERESTING:
        a = live[rva:rva + 16]
        b = dump[rva:rva + 16]
        print(f"  0x{rva:06x}  igual={str(a == b):5}  live={a.hex(' ')}")
        if a != b:
            print(f"           dump={b.hex(' ')}")


main()
