"""Descobre o endereco REAL de WriteFile/ReadFile dentro do processo do jogo,
lendo a IAT de PokeAlliance_dx.exe (que importa as duas em kernel32).

Depois compara com o que esta nos slots de msftedit. Se for igual, o scanner
compara certo. Se nao for, a comparacao precisa mudar.
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TH32CS_SNAPMODULE = 0x8


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


def main():
    pid = int(sys.argv[1])
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return
    mods = modules(pid)

    print("=== bases dos modulos relevantes ===")
    for base, size, name in mods:
        if name.lower() in ("kernel32.dll", "kernelbase.dll", "msftedit.dll",
                            "pokealliance_dx.exe"):
            print(f"  {name:<26} 0x{base:016x} size=0x{size:x}")

    # le a IAT do exe do jogo
    exe = next((m for m in mods if m[2].lower().startswith("pokealliance_dx")), None)
    if not exe:
        print("exe do jogo nao encontrado na lista de modulos")
        return
    base, size, name = exe
    head = read(handle, base, 0x1000)
    pe_off = struct.unpack_from("<I", head, 0x3C)[0]
    opt = pe_off + 24
    import_rva, import_size = struct.unpack_from("<II", head, opt + 112)

    table = read(handle, base + import_rva, max(import_size, 20 * 200))
    found = {}
    index = 0
    while index * 20 + 20 <= len(table):
        oft, _, _, name_rva, ft = struct.unpack_from("<IIIII", table, index * 20)
        if not name_rva:
            break
        dll = read(handle, base + name_rva, 64)
        dll_name = dll.split(b"\0")[0].decode("latin1") if dll else "?"
        if oft and ft and "kernel32" in dll_name.lower():
            thunks = read(handle, base + oft, 8 * 200)
            slots = read(handle, base + ft, 8 * 200)
            if thunks and slots:
                for i in range(200):
                    thunk = struct.unpack_from("<Q", thunks, i * 8)[0]
                    if thunk == 0:
                        break
                    if thunk & 0x8000000000000000:
                        continue
                    hint = read(handle, base + (thunk & 0x7FFFFFFF), 64)
                    if not hint:
                        continue
                    fn = hint[2:].split(b"\0")[0].decode("latin1")
                    if fn in ("WriteFile", "ReadFile"):
                        value = struct.unpack_from("<Q", slots, i * 8)[0]
                        found[fn] = value
        index += 1

    print("\n=== endereco REAL no processo (via IAT do exe) ===")
    for fn, value in found.items():
        print(f"  {fn:<10} 0x{value:016x}")


main()
