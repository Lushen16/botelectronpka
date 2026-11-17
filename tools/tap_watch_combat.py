"""Mede a tabela de dispatch enquanto o bot esta' em combate.

O bot esta' com core.phase=combat agora. Se o dispatcher for chamado, algum
estado muda. Este script monitora TUDO que pode mudar:

  - a estrutura de tipo (0xe5158) e seu primeiro dword
  - o tipo corrente (0x224d14)
  - as entradas das 3 faixas da tabela (1o e 2o dword)
  - a flag ready/reentry

O que mudar durante combate e nao em idle e' o caminho do dispatch.

  python tools/tap_watch_combat.py <pid> [segundos]
"""
import ctypes
import struct
import sys
import time
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

RANGES = ((0xE53B0, 0xE5730), (0xE5990, 0xE5AD0), (0xE6970, 0xE6CF0))
WATCH = (0xE5158, 0x224D14, 0x224D10, 0x22474F, 0x224A32)


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
    seconds = int(sys.argv[2]) if len(sys.argv) > 2 else 30
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

    print(f"msftedit 0x{base:x} | observando {seconds}s\n")

    # estado inicial da tabela
    baseline = {}
    for start, end in RANGES:
        raw = read(base + start, end - start)
        if not raw:
            continue
        for index in range(0, len(raw), 0x20):
            if index + 8 > len(raw):
                break
            first, second = struct.unpack_from("<II", raw, index)
            if first or second:
                baseline[start + index] = (first, second)

    print(f"entradas na baseline: {len(baseline)}")
    changes = {}
    samples = 0
    deadline = time.time() + seconds

    while time.time() < deadline:
        samples += 1
        for rva in WATCH:
            value = read(base + rva, 4)
            if value:
                key = ("watch", rva)
                current = struct.unpack("<I", value)[0]
                if key not in baseline:
                    baseline[key] = current
                elif baseline[key] != current:
                    changes.setdefault(key, []).append(current)
        for start, end in RANGES:
            raw = read(base + start, end - start)
            if not raw:
                continue
            for index in range(0, len(raw), 0x20):
                if index + 8 > len(raw):
                    break
                first, second = struct.unpack_from("<II", raw, index)
                if not first and not second:
                    continue
                key = ("entry", start + index)
                value = (first, second)
                if key not in baseline:
                    baseline[key] = value
                elif baseline[key] != value:
                    changes.setdefault(key, []).append(value)
        time.sleep(0.1)

    print(f"amostras: {samples}")
    print(f"\n=== o que mudou durante a observacao ({len(changes)} chaves) ===")
    if not changes:
        print("  NADA mudou.")
        print("  A tabela e a estrutura de tipo sao estaticas em runtime:")
        print("  sao dados de build, nao estado de combate.")
        return
    for key, values in changes.items():
        distinct = sorted(set(values), key=str)
        if key[0] == "watch":
            print(f"  flag 0x{key[1]:06x}: {len(distinct)} valores distintos: "
                  f"{[hex(v) if isinstance(v, int) else v for v in distinct[:8]]}")
        else:
            print(f"  entrada 0x{key[1]:06x}: {len(distinct)} valores distintos")


main()
