"""Inspect the live PKA pipes: open, peek, read, and report exact Win32 state.

Read-only: it never writes a byte. Used to distinguish "pipe connected but
silent" from "pipe not connected" before attempting any handshake.

Usage:
  python tools/pipe_inspect.py --pid 23152
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
INVALID = (None, -1, 0xFFFFFFFFFFFFFFFF)
ERROR_PIPE_NOT_CONNECTED = 233
ERROR_PIPE_BUSY = 231

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                            wintypes.HANDLE]
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k32.ReadFile.restype = wintypes.BOOL
k32.PeekNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                              ctypes.POINTER(wintypes.DWORD),
                              ctypes.POINTER(wintypes.DWORD),
                              ctypes.POINTER(wintypes.DWORD)]
k32.PeekNamedPipe.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.GetNamedPipeInfo = None  # unused placeholder


def pipe_path(name: str) -> str:
    return "\\\\" + "." + "\\" + "pipe" + "\\" + name


def inspect(name: str, mode: str) -> None:
    path = pipe_path(name)
    access = GENERIC_READ if mode == "READ" else GENERIC_READ | GENERIC_WRITE
    handle = k32.CreateFileW(path, access, 0, None, OPEN_EXISTING, 0, None)
    if handle in INVALID:
        print("%-24s %-5s open -> error=%d" % (name, mode, ctypes.get_last_error()))
        return
    try:
        avail = wintypes.DWORD(0)
        peeked = k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(avail), None)
        peek_error = ctypes.get_last_error()
        print("%-24s %-5s open OK  peek=%s avail=%d err=%d" % (
            name, mode, bool(peeked), avail.value, peek_error))

        buf = ctypes.create_string_buffer(8192)
        got = wintypes.DWORD(0)
        started = time.time()
        ok = k32.ReadFile(handle, buf, 8192, ctypes.byref(got), None)
        elapsed = time.time() - started
        read_error = ctypes.get_last_error()
        print("%-24s %-5s read ok=%s bytes=%d err=%d %.3fs" % (
            name, mode, bool(ok), got.value, read_error, elapsed))
        if ok and got.value >= 8:
            data = buf.raw[: got.value]
            length, kind = struct.unpack_from("<II", data, 0)
            print("%-24s %-5s frame len=%d kind=%d" % (name, mode, length, kind))
            print("%-24s %-5s payload=%s" % (name, mode,
                                             data[8:8 + min(length, 32)].hex()))
    finally:
        k32.CloseHandle(handle)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    args = parser.parse_args()
    for name in ("pka-runtime-2-%d" % args.pid, "pka-security-%d" % args.pid):
        for mode in ("READ", "RW"):
            inspect(name, mode)
            time.sleep(0.05)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
