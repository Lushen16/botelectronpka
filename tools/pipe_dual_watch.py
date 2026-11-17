"""Open both PKA pipes at once and dump any bytes for N seconds (read-only).

Tests whether the runtime pipe needs the security pipe connected first, and
whether either side ever pushes a challenge. Nothing is written to either pipe.

Usage:
  python tools/pipe_dual_watch.py --pid 26596 --seconds 15
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import struct
import time

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
INVALID = (None, -1, 0xFFFFFFFFFFFFFFFF)
ERROR_IO_PENDING = 997
WAIT_OBJECT_0 = 0

k32 = ctypes.WinDLL("kernel32", use_last_error=True)


class OV(ctypes.Structure):
    _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                ("hEvent", wintypes.HANDLE)]


k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(OV)]
k32.GetOverlappedResult.argtypes = [wintypes.HANDLE, ctypes.POINTER(OV),
                                    ctypes.POINTER(wintypes.DWORD), wintypes.BOOL]
k32.CreateEventW.restype = wintypes.HANDLE
k32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def path_for(name: str) -> str:
    return "\\\\" + "." + "\\" + "pipe" + "\\" + name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--seconds", type=float, default=15)
    args = parser.parse_args()

    pipes = ["pka-runtime-2-%d" % args.pid, "pka-security-%d" % args.pid]
    handles = {}
    for name in pipes:
        handle = k32.CreateFileW(path_for(name), GENERIC_READ | GENERIC_WRITE, 0, None,
                                 OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None)
        if handle in INVALID:
            print("%-24s open error=%d" % (name, ctypes.get_last_error()), flush=True)
            continue
        handles[name] = handle
        print("%-24s opened and held" % name, flush=True)

    if not handles:
        return 2

    event = k32.CreateEventW(None, True, False, None)
    deadline = time.monotonic() + args.seconds
    totals = {name: 0 for name in handles}
    try:
        while time.monotonic() < deadline:
            for name, handle in handles.items():
                buffer = ctypes.create_string_buffer(65536)
                got = wintypes.DWORD(0)
                overlapped = OV()
                overlapped.hEvent = event
                ok = k32.ReadFile(handle, buffer, 65536, ctypes.byref(got), ctypes.byref(overlapped))
                if not ok:
                    error = ctypes.get_last_error()
                    if error != ERROR_IO_PENDING:
                        if totals[name] == 0:
                            print("%-24s read error=%d" % (name, error), flush=True)
                        totals[name] = totals[name] or -1
                        continue
                    if k32.WaitForSingleObject(event, 200) != WAIT_OBJECT_0:
                        k32.CancelIo(handle)
                        continue
                    if not k32.GetOverlappedResult(handle, ctypes.byref(overlapped),
                                                   ctypes.byref(got), False):
                        continue
                if got.value:
                    print("%-24s GOT %d bytes: %s" % (name, got.value,
                          buffer.raw[: min(got.value, 64)].hex()), flush=True)
                    if got.value >= 8:
                        length, kind = struct.unpack_from("<II", buffer.raw, 0)
                        print("%-24s frame len=%d kind=%d" % (name, length, kind), flush=True)
                    totals[name] += got.value
            time.sleep(0.05)
        print("totals: %s" % totals, flush=True)
        return 0 if any(v > 0 for v in totals.values()) else 1
    finally:
        k32.CloseHandle(event)
        for handle in handles.values():
            k32.CloseHandle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
