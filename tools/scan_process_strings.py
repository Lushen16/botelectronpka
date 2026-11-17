"""Read-only string scan of a live process (never writes to the target).

Searches committed private/mapped regions for ASCII and UTF-16LE patterns and
dumps a small window around each hit.

Usage:
  python tools/scan_process_strings.py --pid 27700 --pattern "PKA_CHANNEL_KEY" --pattern "PKA2/client"
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import os
import sys

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100

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
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]
k32.ReadProcessMemory.restype = wintypes.BOOL
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def preview(data: bytes) -> str:
    text = "".join(chr(b) if 32 <= b < 127 else "." for b in data)
    return text


def scan(pid: int, patterns: list[str], window: int, max_hits: int):
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise SystemExit(f"OpenProcess failed: {ctypes.get_last_error()}")
    needles = []
    for pattern in patterns:
        needles.append((pattern + " [ascii]", pattern.encode("ascii")))
        needles.append((pattern + " [utf16]", pattern.encode("utf-16le")))
    hits = 0
    address = 0
    try:
        while hits < max_hits:
            mbi = MBI()
            if not k32.VirtualQueryEx(handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)):
                break
            base = int(mbi.BaseAddress or 0)
            size = int(mbi.RegionSize)
            if size == 0:
                break
            readable = (mbi.State == MEM_COMMIT and not (mbi.Protect & PAGE_GUARD)
                        and mbi.Protect != PAGE_NOACCESS)
            if readable and size <= 512 * 1024 * 1024:
                buf = ctypes.create_string_buffer(size)
                read = ctypes.c_size_t(0)
                ok = k32.ReadProcessMemory(handle, ctypes.c_void_p(base), buf,
                                           ctypes.c_size_t(size), ctypes.byref(read))
                if ok:
                    data = buf.raw[: read.value]
                    for label, needle in needles:
                        start = 0
                        while hits < max_hits:
                            idx = data.find(needle, start)
                            if idx < 0:
                                break
                            lo = max(0, idx - window)
                            hi = min(len(data), idx + len(needle) + window)
                            print(f"--- hit {label} va=0x{base + idx:x} region=0x{base:x} size=0x{size:x} "
                                  f"protect=0x{mbi.Protect:x} type=0x{mbi.Type:x}")
                            print("   ", preview(data[lo:hi]))
                            hits += 1
                            start = idx + 1
            address = base + size
    finally:
        k32.CloseHandle(handle)
    print(f"total_hits={hits}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--pattern", action="append", required=True)
    parser.add_argument("--window", type=int, default=160)
    parser.add_argument("--max-hits", type=int, default=40)
    args = parser.parse_args()
    scan(args.pid, args.pattern, args.window, args.max_hits)
    return 0


if __name__ == "__main__":
    sys.exit(main())
