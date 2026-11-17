"""Report wait state + user/kernel time of threads that start in the module.

Answers one question: are the injected module's threads parked in a pipe wait
(server listening) or idle/blocked elsewhere? Read-only.

Usage:
  python tools/thread_wait.py --pid 26596 --module-base 0x7ffd09bc0000 --module-size 0x328000
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import struct
import sys

TH32CS_SNAPTHREAD = 0x00000004
THREAD_QUERY_LIMITED_INFORMATION = 0x0800
THREAD_QUERY_INFORMATION = 0x0040
ThreadQuerySetWin32StartAddress = 9
ThreadBasicInformation = 0

# KWAIT_REASON values we care about.
WAIT_REASONS = {
    0: "Executive", 1: "FreePage", 2: "PageIn", 3: "PoolAllocation", 4: "DelayExecution",
    5: "Suspended", 6: "UserRequest", 7: "WrExecutive", 8: "WrFreePage", 9: "WrPageIn",
    10: "WrPoolAllocation", 11: "WrDelayExecution", 12: "WrSuspended", 13: "WrUserRequest",
    14: "WrEventPair", 15: "WrQueue", 16: "WrLpcReceive", 17: "WrLpcReply",
    18: "WrVirtualMemory", 19: "WrPageOut", 20: "WrRendezvous", 21: "WrKeyedEvent",
    22: "WrTerminated", 23: "WrProcessInSwap", 24: "WrCpuRateControl",
    25: "WrCalloutStack", 26: "WrKernel", 27: "WrResource", 28: "WrPushLock",
    29: "WrMutex", 30: "WrQuantumEnd", 31: "WrDispatchInt", 32: "WrPreempted",
    33: "WrYieldExecution", 34: "WrFastMutex", 35: "WrGuardedMutex",
    36: "WrRundown", 37: "WrAlertByThreadId", 38: "WrDeferredPreempt",
}

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll", use_last_error=True)


class THREADENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ThreadID", wintypes.DWORD), ("th32OwnerProcessID", wintypes.DWORD),
                ("tpBasePri", ctypes.c_long), ("tpDeltaPri", ctypes.c_long),
                ("dwFlags", wintypes.DWORD)]


k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
k32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
k32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
k32.OpenThread.restype = wintypes.HANDLE
k32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.GetThreadTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME),
                               ctypes.POINTER(wintypes.FILETIME),
                               ctypes.POINTER(wintypes.FILETIME),
                               ctypes.POINTER(wintypes.FILETIME)]
ntdll.NtQueryInformationThread.restype = ctypes.c_long
ntdll.NtQueryInformationThread.argtypes = [wintypes.HANDLE, ctypes.c_int,
                                           ctypes.c_void_p, wintypes.ULONG,
                                           ctypes.POINTER(wintypes.ULONG)]


def thread_ids(pid: int) -> list[int]:
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    if snap in (None, -1, 0xFFFFFFFFFFFFFFFF):
        raise SystemExit("snapshot falhou: %d" % ctypes.get_last_error())
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


def start_address(handle) -> int | None:
    value = ctypes.c_void_p(0)
    returned = wintypes.ULONG(0)
    status = ntdll.NtQueryInformationThread(handle, ThreadQuerySetWin32StartAddress,
                                            ctypes.byref(value), ctypes.sizeof(value),
                                            ctypes.byref(returned))
    return int(value.value or 0) if status == 0 else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--module-base", type=lambda v: int(v, 0), required=True)
    parser.add_argument("--module-size", type=lambda v: int(v, 0), required=True)
    args = parser.parse_args()

    lo, hi = args.module_base, args.module_base + args.module_size
    wanted = []
    for tid in thread_ids(args.pid):
        handle = k32.OpenThread(THREAD_QUERY_INFORMATION, False, tid)
        if not handle:
            continue
        try:
            start = start_address(handle)
            if start is None or not (lo <= start < hi):
                continue
            kernel = wintypes.FILETIME()
            user = wintypes.FILETIME()
            created = wintypes.FILETIME()
            exited = wintypes.FILETIME()
            k32.GetThreadTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                               ctypes.byref(kernel), ctypes.byref(user))
            cpu_ms = ((kernel.dwHighDateTime << 32 | kernel.dwLowDateTime) +
                      (user.dwHighDateTime << 32 | user.dwLowDateTime)) / 10000.0
            wanted.append((tid, start, cpu_ms))
        finally:
            k32.CloseHandle(handle)

    print("module 0x%x..0x%x" % (lo, hi))
    print("threads starting in module: %d" % len(wanted))
    for tid, start, cpu_ms in wanted:
        print("  tid=%-6d start=0x%x cpu=%.1fms" % (tid, start, cpu_ms))

    # Sample CPU twice to see whether these threads are active or parked.
    if wanted:
        import time
        before = {tid: cpu for tid, _, cpu in wanted}
        time.sleep(2.0)
        print("after 2s:")
        for tid in before:
            handle = k32.OpenThread(THREAD_QUERY_INFORMATION, False, tid)
            if not handle:
                continue
            try:
                kernel = wintypes.FILETIME()
                user = wintypes.FILETIME()
                created = wintypes.FILETIME()
                exited = wintypes.FILETIME()
                k32.GetThreadTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                   ctypes.byref(kernel), ctypes.byref(user))
                cpu = ((kernel.dwHighDateTime << 32 | kernel.dwLowDateTime) +
                       (user.dwHighDateTime << 32 | user.dwLowDateTime)) / 10000.0
                print("  tid=%-6d delta=%+.2fms" % (tid, cpu - before[tid]))
            finally:
                k32.CloseHandle(handle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
