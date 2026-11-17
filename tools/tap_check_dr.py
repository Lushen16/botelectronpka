"""Verifica se o hardware breakpoint de pka_dispatch_trace.dll esta' armado.

Um DR0 mal setado ou o VEH nao registrado faz o tracer rodar "armado" no log e
nao disparar nunca. Este script le os debug registers de cada thread do alvo.

  python tools/tap_check_dr.py <pid>
"""
import ctypes
import sys
from ctypes import wintypes

THREAD_GET_CONTEXT = 0x0008
THREAD_QUERY_INFORMATION = 0x0040
CONTEXT_DEBUG_REGISTERS = 0x00100010

TH32CS_SNAPTHREAD = 0x00000004


class THREADENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ThreadID", wintypes.DWORD), ("th32OwnerProcessID", wintypes.DWORD),
        ("tpBasePri", wintypes.LONG), ("tpDeltaPri", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
    ]


# CONTEXT x64: layout dos debug registers
class CONTEXT64(ctypes.Structure):
    _fields_ = [
        ("P1Home", ctypes.c_uint64 * 6),
        ("ContextFlags", wintypes.DWORD),
        ("MxCsr", wintypes.DWORD),
        ("SegCs", wintypes.WORD), ("SegDs", wintypes.WORD),
        ("SegEs", wintypes.WORD), ("SegFs", wintypes.WORD), ("SegGs", wintypes.WORD),
        ("SegSs", wintypes.WORD), ("EFlags", wintypes.DWORD),
        ("Dr0", ctypes.c_uint64), ("Dr1", ctypes.c_uint64),
        ("Dr2", ctypes.c_uint64), ("Dr3", ctypes.c_uint64),
        ("Dr6", ctypes.c_uint64), ("Dr7", ctypes.c_uint64),
        ("Rax", ctypes.c_uint64), ("Rcx", ctypes.c_uint64),
        ("Rdx", ctypes.c_uint64), ("Rbx", ctypes.c_uint64),
        ("Rsp", ctypes.c_uint64), ("Rbp", ctypes.c_uint64),
        ("Rsi", ctypes.c_uint64), ("Rdi", ctypes.c_uint64),
        ("R8", ctypes.c_uint64), ("R9", ctypes.c_uint64),
        ("R10", ctypes.c_uint64), ("R11", ctypes.c_uint64),
        ("R12", ctypes.c_uint64), ("R13", ctypes.c_uint64),
        ("R14", ctypes.c_uint64), ("R15", ctypes.c_uint64),
        ("Rip", ctypes.c_uint64),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
k32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
k32.OpenThread.restype = wintypes.HANDLE
k32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.GetThreadContext.argtypes = [wintypes.HANDLE, ctypes.POINTER(CONTEXT64)]
k32.GetThreadContext.restype = wintypes.BOOL


def main():
    pid = int(sys.argv[1])
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    if snap == wintypes.HANDLE(-1).value:
        print("snapshot falhou")
        return

    entry = THREADENTRY32()
    entry.dwSize = ctypes.sizeof(entry)
    armed = 0
    total = 0
    ok = k32.Thread32First(snap, ctypes.byref(entry))
    while ok:
        if entry.th32OwnerProcessID == pid:
            total += 1
            handle = k32.OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION,
                                    False, entry.th32ThreadID)
            if handle:
                ctx = CONTEXT64()
                ctx.ContextFlags = CONTEXT_DEBUG_REGISTERS
                if k32.GetThreadContext(handle, ctypes.byref(ctx)):
                    dr7 = ctx.Dr7
                    enabled = dr7 & 1
                    rw = (dr7 >> 16) & 0x3
                    length = (dr7 >> 18) & 0x3
                    state = "ARMADO" if (ctx.Dr0 and enabled) else "livre"
                    if ctx.Dr0 and enabled:
                        armed += 1
                        print(f"  tid={entry.th32ThreadID:<8} {state}  "
                              f"DR0=0x{ctx.Dr0:x} DR7=0x{dr7:x} "
                              f"(L0={enabled} RW={rw} LEN={length})")
                    _ = state
                k32.CloseHandle(handle)
        ok = k32.Thread32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)

    print(f"\nthreads no processo: {total}")
    print(f"com DR0 armado     : {armed}")
    if armed == 0:
        print("\nNENHUM breakpoint ativo. O VEH nunca vai disparar.")
        print("Causa comum: a thread que executa a funcao nasceu depois do")
        print("arm e o rearm de 1.5s nao alcancou, ou SetThreadContext falhou")
        print("por falta de THREAD_SUSPEND_RESUME.")


main()
