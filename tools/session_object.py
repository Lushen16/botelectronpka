"""Check for the runtime's named session object (read-only).

The injected module contains the literal "Local\\PKA.Session.2." — a per-client
kernel object. If the runtime session is alive the object exists; if the worker
died when the menu closed, it may be gone. This opens (never creates) candidate
names and reports which ones exist.

Read-only: OpenMutexW/OpenEventW/OpenSemaphoreW with SYNCHRONIZE only.

Usage:
  python tools/session_object.py --pid 26596
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes

SYNCHRONIZE = 0x00100000
ERROR_FILE_NOT_FOUND = 2
ERROR_PATH_NOT_FOUND = 3

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
for fn in ("OpenMutexW", "OpenEventW", "OpenSemaphoreW"):
    getattr(k32, fn).restype = wintypes.HANDLE
    getattr(k32, fn).argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def candidates(pid: int) -> list[str]:
    names = []
    for base in ("PKA.Session.2.", "PKA.Session.", "PKA.Session.2"):
        for suffix in (str(pid), str(pid) + ".runtime", str(pid) + ".client"):
            names.append("Local\\" + base + suffix)
            names.append("Global\\" + base + suffix)
    names += ["Local\\PKA.Session.2.", "Local\\PKA.Session.2", "Local\\PKA.Session.",
              "Global\\PKA.Session.2."]
    return names


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    args = parser.parse_args()

    found = 0
    for name in candidates(args.pid):
        for label, fn in (("mutex", k32.OpenMutexW),
                          ("event", k32.OpenEventW),
                          ("semaphore", k32.OpenSemaphoreW)):
            handle = fn(SYNCHRONIZE, False, name)
            if handle:
                print("EXISTS %-24s %s" % (label, name))
                k32.CloseHandle(handle)
                found += 1
            else:
                error = ctypes.get_last_error()
                if error not in (ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND):
                    print("  %-9s %-40s error=%d" % (label, name, error))
    print("total_existing=%d of %d names x 3 types" % (found, len(candidates(args.pid))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
