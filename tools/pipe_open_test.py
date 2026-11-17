"""Attempt one CreateFileW on the PKA runtime pipe and report the exact error.

Uses a correctly escaped path built in code (no shell escaping involved).

Usage:
  python tools/pipe_open_test.py --pid 23152
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
INVALID_VALUE = ctypes.c_void_p(-1).value

ERRORS = {
    2: "ERROR_FILE_NOT_FOUND",
    5: "ERROR_ACCESS_DENIED",
    161: "ERROR_BAD_PATHNAME",
    231: "ERROR_PIPE_BUSY",
    232: "ERROR_NO_DATA",
    233: "ERROR_PIPE_NOT_CONNECTED",
}

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                            wintypes.HANDLE]
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.WaitNamedPipeW.restype = wintypes.BOOL
k32.WaitNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]


def make_path(name: str) -> str:
    # '\\\\.\\pipe\\' + name  ->  "\\.\pipe\name"
    return "\\\\" + "." + "\\" + "pipe" + "\\" + name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--wait-ms", type=int, default=0)
    args = parser.parse_args()

    for name in ("pka-runtime-2-%d" % args.pid, "pka-security-%d" % args.pid):
        path = make_path(name)
        print("path repr:", repr(path))
        if args.wait_ms:
            print("  WaitNamedPipe:", bool(k32.WaitNamedPipeW(path, args.wait_ms)))
        for access, label in ((GENERIC_READ, "READ"),
                              (GENERIC_READ | GENERIC_WRITE, "RW")):
            handle = k32.CreateFileW(path, access, 0, None, OPEN_EXISTING, 0, None)
            if handle in (None, INVALID_VALUE):
                code = ctypes.get_last_error()
                print("  %-4s -> error=%d %s" % (label, code, ERRORS.get(code, "")))
            else:
                print("  %-4s -> OPENED" % label)
                k32.CloseHandle(handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
