"""Hold a named pipe with maxInstances=1, like the real PKA runtime.

Used to prove the race probe waits for the holder to leave instead of marking
the pid orphaned, then wins the instance when it is freed.

Modes:
  hold    -- create the pipe, wait for a client, then keep it open until closed
  release -- (unused) placeholder

This script is a test fixture only. It is never used against the game.

Usage:
  python tools/pipe_holder.py --pid 64700 --seconds 30
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import time

PIPE_ACCESS_DUPLEX = 0x00000003
PIPE_TYPE_BYTE = 0x00000000
PIPE_READMODE_BYTE = 0x00000000
PIPE_WAIT = 0x00000000
PIPE_UNLIMITED = 255
INVALID = (None, -1, 0xFFFFFFFFFFFFFFFF)

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateNamedPipeW.restype = wintypes.HANDLE
k32.CreateNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                 wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                                 wintypes.DWORD, ctypes.c_void_p]
k32.ConnectNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
k32.ConnectNamedPipe.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def pipe_path(pid: int) -> str:
    return "\\\\" + "." + "\\" + "pipe" + "\\" + ("pka-runtime-2-%d" % pid)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--instances", type=int, default=1,
                        help="nMaxInstances; 1 reproduz o runtime")
    args = parser.parse_args()

    path = pipe_path(args.pid)
    handle = k32.CreateNamedPipeW(path, PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE
                                  | PIPE_WAIT, args.instances, 65536, 65536, 0, None)
    if handle in INVALID:
        print("CreateNamedPipeW falhou: %d" % ctypes.get_last_error(), flush=True)
        return 2
    print("HOLDER ready on %s maxInstances=%d" % (path, args.instances), flush=True)

    deadline = time.monotonic() + args.seconds
    try:
        while time.monotonic() < deadline:
            # ConnectNamedPipe bloqueia ate alguem conectar; usamos timeout curto
            # em laco para poder reportar status periodicamente.
            connected = k32.ConnectNamedPipe(handle, None)
            if connected:
                print("HOLDER accepted a client", flush=True)
            else:
                error = ctypes.get_last_error()
                if error == 535:  # ERROR_PIPE_CONNECTED
                    print("HOLDER already connected", flush=True)
                elif error != 121:  # ERROR_SEM_TIMEOUT
                    print("HOLDER connect error=%d" % error, flush=True)
                    break
            time.sleep(0.3)
    finally:
        k32.CloseHandle(handle)
        print("HOLDER released", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
