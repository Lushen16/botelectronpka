"""Dumpa o msftedit.dll do processo vivo para um arquivo, para analise.

O dump que a gente tinha (dumps/payload_reconstructed.dll, 22/10) e' de outra
build: 74,6% dos blocos diferem do modulo que roda hoje (v3.3.1). Todo RVA
derivado dele aponta para o lugar errado - foi por isso que o ponteiro do
dispatcher deu "_string@".

Sem header PE (module stomping), entao o dump e' a IMAGEM CRUA, nao um PE
valido. A analise tem que ser por offset de imagem, que e' o que os scripts
tap_* ja fazem.

  python tools/tap_dump_live.py <pid> [arquivo-saida]
"""
import ctypes
import hashlib
import os
import sys
from ctypes import wintypes
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "dumps"

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


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    pid = int(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else OUT_DIR / f"msftedit_live_{pid}.bin"

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
        print("msftedit nao carregada neste processo")
        return

    print(f"msftedit base=0x{base:x} size=0x{size:x}")
    data = bytearray()
    for offset in range(0, size, 0x10000):
        chunk = min(0x10000, size - offset)
        buf = ctypes.create_string_buffer(chunk)
        got = ctypes.c_size_t()
        if k32.ReadProcessMemory(handle, ctypes.c_void_p(base + offset), buf,
                                 chunk, ctypes.byref(got)):
            data.extend(buf.raw[:got.value])
        else:
            data.extend(b"\x00" * chunk)
            print(f"  aviso: regiao 0x{offset:x} ilegivel, preenchida com zero")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out.write_bytes(bytes(data))
    digest = hashlib.sha256(bytes(data)).hexdigest()
    print(f"\nsalvo: {out}")
    print(f"bytes: {len(data)}")
    print(f"sha256: {digest}")

    # metadados ao lado, para nao confundir com o dump velho
    meta = out.with_suffix(".json")
    meta.write_text(
        '{\n'
        f'  "source": "live process dump",\n'
        f'  "pid": {pid},\n'
        f'  "module": "msftedit.dll",\n'
        f'  "base": "0x{base:x}",\n'
        f'  "size": "0x{size:x}",\n'
        f'  "sha256": "{digest}",\n'
        f'  "note": "imagem crua, sem header PE (module stomping). offsets sao de imagem."\n'
        '}\n',
        encoding="utf-8")
    print(f"meta : {meta}")


main()
