"""Probe the runtime pipe from a child process that *is* an expected client.

The native module imports GetNamedPipeClientProcessId, so it can refuse a
connection based on who is on the other end. This tool just reports what the
module can see: the client PID returned for a normal connection, so we can tell
whether our own PID is the reason a handshake never starts.

Read-only: opens, queries, closes. Writes nothing.

Usage:
  python tools/pipe_client_pid.py --pid 26596
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import os

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
INVALID = (None, -1, 0xFFFFFFFFFFFFFFFF)

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
k32.GetNamedPipeClientProcessId.argtypes = [wintypes.HANDLE,
                                            ctypes.POINTER(wintypes.ULONG)]
k32.GetNamedPipeClientProcessId.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def path_for(name: str) -> str:
    return "\\\\" + "." + "\\" + "pipe" + "\\" + name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    args = parser.parse_args()

    print("este processo (cliente) pid=%d" % os.getpid())
    for name in ("pka-runtime-2-%d" % args.pid, "pka-security-%d" % args.pid):
        handle = k32.CreateFileW(path_for(name), GENERIC_READ | GENERIC_WRITE, 0, None,
                                 OPEN_EXISTING, 0, None)
        if handle in INVALID:
            print("%-24s open error=%d" % (name, ctypes.get_last_error()))
            continue
        try:
            client = wintypes.ULONG(0)
            ok = k32.GetNamedPipeClientProcessId(handle, ctypes.byref(client))
            print("%-24s opened; GetNamedPipeClientProcessId ok=%s pid=%d err=%d" % (
                name, bool(ok), client.value, ctypes.get_last_error()))
        finally:
            k32.CloseHandle(handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
