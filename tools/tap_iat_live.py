"""Le a IAT de um modulo DENTRO do processo vivo e diz se o slot de
ReadFile/WriteFile aponta para o nosso thunk ou para o sistema.

Usa Toolhelp para a base real (nada de adivinhar por tamanho de imagem).

  python tools/tap_iat_live.py <pid> [nome-do-modulo]
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
TH32CS_SNAPMODULE = 0x00000008

KNOWN_BAD = 0x9  # ERROR_INVALID_HANDLE etc, so para debug


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD),
        ("modBaseAddr", ctypes.c_void_p),
        ("modBaseSize", wintypes.DWORD),
        ("hModule", wintypes.HMODULE),
        ("szModule", ctypes.c_char * 256),
        ("szExePath", ctypes.c_char * 260),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_size_t,
                                  ctypes.POINTER(ctypes.c_size_t)]
k32.Module32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
k32.Module32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]


def read(handle, address, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size,
                                 ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def modules(pid):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid)
    if snap == wintypes.HANDLE(-1).value:
        return []
    entry = MODULEENTRY32()
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
        print("uso: python tools/tap_iat_live.py <pid> [modulo]")
        return
    pid = int(sys.argv[1])
    only = sys.argv[2] if len(sys.argv) > 2 else None

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess falhou:", ctypes.get_last_error())
        return

    mods = modules(pid)
    names = [m[2] for m in mods]
    print(f"pid {pid}: {len(mods)} modulos")
    print("pka_tap carregado:", any("pka_tap" in n for n in names))
    tap_base = next((b for b, s, n in mods if "pka_tap" in n), None)
    tap_size = next((s for b, s, n in mods if "pka_tap" in n), 0)
    if tap_base:
        print(f"pka_tap: base=0x{tap_base:x} size=0x{tap_size:x}")

    targets = [m for m in mods if only is None or only.lower() in m[2].lower()]
    for base, size, name in targets:
        head = read(handle, base, 0x1000)
        if not head or head[:2] != b"MZ":
            continue
        pe_off = struct.unpack_from("<I", head, 0x3C)[0]
        if head[pe_off:pe_off + 4] != b"PE\0\0":
            continue
        opt = pe_off + 24
        import_rva, import_size = struct.unpack_from("<II", head, opt + 112)
        if not import_rva:
            continue

        raw = read(handle, base + import_rva, max(import_size, 20 * 64))
        if not raw:
            continue

        index = 0
        hits = []
        while index * 20 + 20 <= len(raw):
            oft, _, _, name_rva, ft = struct.unpack_from("<IIIII", raw, index * 20)
            if not name_rva:
                break
            dll = read(handle, base + name_rva, 64)
            if not dll:
                break
            dll_name = dll.split(b"\0")[0].decode("latin1")
            if oft and ft:
                thunk_raw = read(handle, base + oft, 8 * 64)
                slot_raw = read(handle, base + ft, 8 * 64)
                if thunk_raw and slot_raw:
                    for i in range(64):
                        thunk = struct.unpack_from("<Q", thunk_raw, i * 8)[0]
                        if thunk == 0:
                            break
                        if thunk & 0x8000000000000000:
                            continue
                        hint = read(handle, base + (thunk & 0x7FFFFFFF), 64)
                        if not hint:
                            continue
                        fn = hint[2:].split(b"\0")[0].decode("latin1")
                        if fn not in ("ReadFile", "WriteFile"):
                            continue
                        slot = struct.unpack_from("<Q", slot_raw, i * 8)[0]
                        hits.append((dll_name, fn, slot))
            index += 1
            if index > 400:
                break

        if not hits:
            continue
        print(f"\n=== {name} (base 0x{base:x}) ===")
        for dll_name, fn, slot in hits:
            owner, offset = owner_of(slot, mods)
            if owner and "pka_tap" in owner:
                verdict = f"NOSSO HOOK (pka_tap+0x{offset:x})"
            elif owner:
                verdict = f"{owner}+0x{offset:x}"
            else:
                verdict = "fora de modulo conhecido"
            print(f"  {dll_name:<42} {fn:<10} -> 0x{slot:x}  {verdict}")


main()
