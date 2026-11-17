"""Query named-pipe metadata for the live PKA pipes (read-only).

Reports GetNamedPipeInfo details (type, read/write mode, max instances) and
GetNamedPipeHandleState, which explains why an open succeeds but every read
returns ERROR_PIPE_NOT_CONNECTED (233): the instance exists but has no live
peer.

Usage:
  python tools/pipe_info.py --pid 23152
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
INVALID = (None, -1, 0xFFFFFFFFFFFFFFFF)

PIPE_TYPE = {0: "BYTE", 1: "MESSAGE"}
PIPE_MODE = {0: "WAIT", 1: "NOWAIT"}

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                            wintypes.HANDLE]
k32.GetNamedPipeInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD),
                                 ctypes.POINTER(wintypes.DWORD),
                                 ctypes.POINTER(wintypes.DWORD),
                                 ctypes.POINTER(wintypes.DWORD)]
k32.GetNamedPipeInfo.restype = wintypes.BOOL
k32.GetNamedPipeHandleStateW.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD),
                                         ctypes.POINTER(wintypes.DWORD),
                                         ctypes.POINTER(wintypes.DWORD),
                                         ctypes.c_void_p, ctypes.c_void_p,
                                         wintypes.DWORD]
k32.GetNamedPipeHandleStateW.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def path_for(name: str) -> str:
    return "\\\\" + "." + "\\" + "pipe" + "\\" + name


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    args = parser.parse_args()

    for name in ("pka-runtime-2-%d" % args.pid, "pka-security-%d" % args.pid):
        full = path_for(name)
        handle = k32.CreateFileW(full, GENERIC_READ | GENERIC_WRITE, 0, None,
                                 OPEN_EXISTING, 0, None)
        if handle in INVALID:
            print("%s: open error=%d" % (name, ctypes.get_last_error()))
            continue
        try:
            flags = wintypes.DWORD(0)
            out_buf = wintypes.DWORD(0)
            in_buf = wintypes.DWORD(0)
            max_inst = wintypes.DWORD(0)
            ok = k32.GetNamedPipeInfo(handle, ctypes.byref(flags),
                                      ctypes.byref(out_buf), ctypes.byref(in_buf),
                                      ctypes.byref(max_inst))
            print("%s: GetNamedPipeInfo ok=%s flags=0x%x type=%s mode=%s "
                  "outBuf=%d inBuf=%d maxInstances=%s" % (
                      name, bool(ok), flags.value,
                      PIPE_TYPE.get(flags.value & 0x1, "?"),
                      PIPE_MODE.get(flags.value & 0x1, "?"),
                      out_buf.value, in_buf.value,
                      "UNLIMITED" if max_inst.value == 255 else max_inst.value))

            state = wintypes.DWORD(0)
            cur_inst = wintypes.DWORD(0)
            ok2 = k32.GetNamedPipeHandleStateW(handle, ctypes.byref(state),
                                               ctypes.byref(cur_inst), None,
                                               None, None, 0)
            print("%s: handleState ok=%s state=0x%x curInstances=%d" % (
                name, bool(ok2), state.value, cur_inst.value))
        finally:
            k32.CloseHandle(handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
