"""Read-only dump of a single committed region from a live process.

Copies bytes out with ReadProcessMemory (no writes, no injection) so the
region can be analysed offline. Sizes are capped to avoid runaway buffers.

Usage:
  python tools/dump_region.py --pid 23152 --base 0x1d6301c6000 --size 0x150000 --out captures/r.bin
  python tools/dump_region.py --pid 23152 --scan-string "PKA_CHANNEL_KEY" --out captures/r.bin
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import sys

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100
MAX_REGION = 512 * 1024 * 1024

k32 = ctypes.WinDLL("kernel32", use_last_error=True)


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                               ctypes.POINTER(MBI), ctypes.c_size_t]
k32.ReadProcessMemory.restype = wintypes.BOOL
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_size_t,
                                  ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def read_region(handle, base: int, size: int) -> bytes:
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(base), buf,
                                 ctypes.c_size_t(size), ctypes.byref(got)):
        raise SystemExit("ReadProcessMemory falhou: %d" % ctypes.get_last_error())
    return buf.raw[: got.value]


def find_region_with(handle, needle: bytes) -> tuple[int, int]:
    address = 0
    while True:
        mbi = MBI()
        if not k32.VirtualQueryEx(handle, ctypes.c_void_p(address),
                                  ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        base = int(mbi.BaseAddress or 0)
        size = int(mbi.RegionSize)
        if not size:
            break
        readable = (mbi.State == MEM_COMMIT and not (mbi.Protect & PAGE_GUARD)
                    and mbi.Protect != PAGE_NOACCESS and size <= MAX_REGION)
        if readable:
            try:
                data = read_region(handle, base, size)
            except SystemExit:
                data = b""
            if needle in data:
                return base, size
        address = base + size
    raise SystemExit("padrao nao encontrado em nenhuma regiao legivel")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--base", type=lambda v: int(v, 0))
    parser.add_argument("--size", type=lambda v: int(v, 0))
    parser.add_argument("--scan-string")
    parser.add_argument("--encoding", choices=("ascii", "utf16"), default="ascii")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
                             False, args.pid)
    if not handle:
        raise SystemExit("OpenProcess falhou: %d" % ctypes.get_last_error())
    try:
        if args.base is not None:
            base = args.base
            size = args.size
            if size is None:
                mbi = MBI()
                if not k32.VirtualQueryEx(handle, ctypes.c_void_p(base),
                                          ctypes.byref(mbi), ctypes.sizeof(mbi)):
                    raise SystemExit("VirtualQueryEx falhou.")
                size = int(mbi.RegionSize)
        elif args.scan_string:
            needle = (args.scan_string.encode("utf-16le")
                      if args.encoding == "utf16" else args.scan_string.encode("ascii"))
            base, size = find_region_with(handle, needle)
            print("region base=0x%x size=0x%x" % (base, size))
        else:
            raise SystemExit("informe --base/--size ou --scan-string")
        if size > MAX_REGION:
            raise SystemExit("regiao grande demais: 0x%x" % size)
        data = read_region(handle, base, size)
        with open(args.out, "wb") as fh:
            fh.write(data)
        print("wrote %s bytes=%d base=0x%x size=0x%x" % (args.out, len(data), base, size))
    finally:
        k32.CloseHandle(handle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
