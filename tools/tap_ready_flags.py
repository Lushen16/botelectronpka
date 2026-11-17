"""O runtime do jogo esta' "pronto" para dispatch?

0x1db40 so' despacha se [0x22474f] != 0 e [0x224a32] == 0. Se a primeira flag
estiver ligada no processo vivo, chamar o dispatcher e' viavel. Se estiver
desligada, o runtime nao inicializou e nao ha o que chamar.

  python tools/tap_ready_flags.py <pid>
"""
import ctypes
import struct
import sys
import time
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

READY_FLAG = 0x22474F
REENTRY_FLAG = 0x224A32
BASE_PTR = 0x224CD0
TYPE = 0x224D14


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
    base = None
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        if "msftedit" in entry.szModule.decode("latin1").lower():
            base = entry.modBaseAddr
            break
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    if not base:
        print("msftedit nao carregada")
        return

    print(f"msftedit base = 0x{base:x}\n")
    print("monitorando as flags por 10 s (muda durante o combate?)\n")
    print(f"{'t':>4}  {'ready':>6} {'reentry':>8} {'base':>14} {'tipo':>5}")

    seen = set()
    for tick in range(20):
        ready = read(base + READY_FLAG, 1)
        reentry = read(base + REENTRY_FLAG, 1)
        base_raw = read(base + BASE_PTR, 8)
        type_raw = read(base + TYPE, 4)
        base_value = struct.unpack("<Q", base_raw)[0] if base_raw else None
        type_value = struct.unpack("<I", type_raw)[0] if type_raw else None
        r = ready[0] if ready else None
        e = reentry[0] if reentry else None
        print(f"{tick:4d}  {str(r):>6} {str(e):>8} "
              f"{(f'0x{base_value:x}' if base_value is not None else 'n/a'):>14} "
              f"{str(type_value):>5}")
        seen.add((r, e))
        time.sleep(0.5)

    print("\n=== veredito ===")
    states = {s[0] for s in seen}
    if states == {0}:
        print("ready = 0 SEMPRE: o runtime do fornecedor nao inicializou o dispatch.")
        print("chamar 0x1db40 agora retorna 0 imediatamente (je 0x1dc08).")
    elif 1 in states:
        print("ready = 1 em algum momento: o dispatch ESTA' armado.")
        print("chamar 0x1db40 e' viavel nesses momentos.")
    else:
        print("nao consegui ler a flag (endereco invalido)")


main()
