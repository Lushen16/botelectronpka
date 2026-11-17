"""Enumerate real thread start addresses via Toolhelp + NtQueryInformationThread.

Win32_Thread from CIM did not return usable StartAddress values. This uses
CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD) and NtQueryInformationThread
(ThreadQuerySetWin32StartAddress = 9) so we can tell whether any thread of the
game still starts inside the injected module. Read-only.

Usage:
  python tools/thread_starts.py --pid 23152 --module-base 0x7ffd09ca0000 --module-size 0x138000
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import struct
import sys

TH32CS_SNAPTHREAD = 0x00000004
THREAD_QUERY_INFORMATION = 0x0040
ThreadQuerySetWin32StartAddress = 9
MAX_PATH = 260

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll", use_last_error=True)


class THREADENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ThreadID", wintypes.DWORD),
        ("th32OwnerProcessID", wintypes.DWORD),
        ("tpBasePri", ctypes.c_long),
        ("tpDeltaPri", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
    ]


k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
k32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
k32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
k32.OpenThread.restype = wintypes.HANDLE
k32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.CloseHandle.argtypes = [wintypes.HANDLE]
ntdll.NtQueryInformationThread.restype = ctypes.c_long
ntdll.NtQueryInformationThread.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                           ctypes.c_void_p, wintypes.ULONG,
                                           ctypes.POINTER(wintypes.ULONG)]


def thread_ids(pid: int) -> list[int]:
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    if snap in (None, -1, 0xFFFFFFFFFFFFFFFF):
        raise SystemExit("CreateToolhelp32Snapshot falhou: %d" % ctypes.get_last_error())
    ids = []
    try:
        entry = THREADENTRY32()
        entry.dwSize = ctypes.sizeof(THREADENTRY32)
        ok = k32.Thread32First(snap, ctypes.byref(entry))
        while ok:
            if entry.th32OwnerProcessID == pid:
                ids.append(int(entry.th32ThreadID))
            ok = k32.Thread32Next(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return ids


def start_address(tid: int) -> int | None:
    handle = k32.OpenThread(THREAD_QUERY_INFORMATION, False, tid)
    if not handle:
        return None
    try:
        value = ctypes.c_void_p(0)
        returned = wintypes.ULONG(0)
        status = ntdll.NtQueryInformationThread(handle, ThreadQuerySetWin32StartAddress,
                                                ctypes.byref(value), ctypes.sizeof(value),
                                                ctypes.byref(returned))
        if status != 0:
            return None
        return int(value.value or 0)
    finally:
        k32.CloseHandle(handle)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--module-base", type=lambda v: int(v, 0), required=True)
    parser.add_argument("--module-size", type=lambda v: int(v, 0), required=True)
    args = parser.parse_args()

    ids = thread_ids(args.pid)
    lo, hi = args.module_base, args.module_base + args.module_size
    inside, unknown, outside = [], 0, 0
    for tid in ids:
        start = start_address(tid)
        if start is None or start == 0:
            unknown += 1
        elif lo <= start < hi:
            inside.append((tid, start))
        else:
            outside += 1

    print("pid=%d threads=%d" % (args.pid, len(ids)))
    print("module range 0x%x..0x%x" % (lo, hi))
    print("inside=%d outside=%d unknown=%d" % (len(inside), outside, unknown))
    for tid, start in inside:
        print("  tid=%d start=0x%x" % (tid, start))
    return 0


if __name__ == "__main__":
    sys.exit(main())
