"""Quem escreve no pipe do jogo?

O tap do jogo patcheou 45 slots de IAT e nunca foi chamado. Duas causas
possiveis:

  A. os 45 slots sao de outros modulos (o payload nao usa a IAT)
  B. o payload escreve por outro caminho (NtWriteFile via ntdll, IOCP, etc)

Este script responde pelo lado de dentro do processo: lista as threads do jogo
e o modulo dono do ponto de entrada (Win32StartAddress). Se houver threads com
inicio dentro de msftedit, e' o runtime deles rodando la dentro - entao sabemos
que o codigo esta ativo e o problema e' o hook, nao a ausencia de trafego.

Tambem lista os handles de pipe do processo e tenta casar com nomes.
"""
import ctypes
import struct
import sys
from ctypes import wintypes

TH32CS_SNAPTHREAD = 0x00000004
THREAD_QUERY_INFORMATION = 0x0040
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


class THREADENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ThreadID", wintypes.DWORD),
        ("th32OwnerProcessID", wintypes.DWORD),
        ("tpBasePri", wintypes.LONG),
        ("tpDeltaPri", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
    ]


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD),
        ("modBaseAddr", ctypes.c_void_p),
        ("modBaseSize", wintypes.DWORD),
        ("hModule", wintypes.HMODULE),
        ("szModule", ctypes.c_char * 256),
        ("szExePath", ctypes.c_char * 260),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")

k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
k32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(THREADENTRY32)]
k32.Module32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
k32.Module32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
k32.OpenThread.restype = wintypes.HANDLE
k32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]


def modules(pid):
    snap = k32.CreateToolhelp32Snapshot(0x08 | 0x10, pid)  # MODULE | MODULE32
    entry = MODULEENTRY32()
    entry.dwSize = ctypes.sizeof(entry)
    out = []
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        out.append((entry.modBaseAddr or 0, entry.modBaseSize,
                    entry.szModule.decode("latin1"), entry.szExePath.decode("latin1")))
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    return out


def owner_of(address, mods):
    for base, size, name, path in mods:
        if base <= address < base + size:
            return name
    return None


def main():
    pid = int(sys.argv[1]) if len(sys.argv) > 1 else None
    if not pid:
        print("uso: python tools/tap_thread_owner.py <pid>")
        return

    mods = modules(pid)
    print(f"modulos do pid {pid}: {len(mods)}")

    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
    entry = THREADENTRY32()
    entry.dwSize = ctypes.sizeof(entry)

    counts = {}
    interesting = []
    ok = k32.Thread32First(snap, ctypes.byref(entry))
    while ok:
        if entry.th32OwnerProcessID == pid:
            handle = k32.OpenThread(THREAD_QUERY_INFORMATION, False,
                                    entry.th32ThreadID)
            if handle:
                # NtQueryInformationThread(ThreadQuerySetWin32StartAddress=9)
                start = ctypes.c_void_p()
                ret = ctypes.c_ulong()
                status = ntdll.NtQueryInformationThread(handle, 9,
                                                        ctypes.byref(start),
                                                        ctypes.sizeof(start),
                                                        ctypes.byref(ret))
                if status == 0 and start.value:
                    owner = owner_of(start.value, mods) or "?"
                    counts[owner] = counts.get(owner, 0) + 1
                    if "msftedit" in owner or "pka_tap" in owner:
                        interesting.append((entry.th32ThreadID, owner,
                                            hex(start.value)))
                k32.CloseHandle(handle)
        ok = k32.Thread32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)

    print("\nthreads por modulo de inicio:")
    for name, count in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {name:<34} {count}")

    print("\nthreads iniciadas em msftedit/pka_tap (o runtime deles):")
    if interesting:
        for tid, owner, addr in interesting:
            print(f"  tid={tid:<8} {owner:<20} start={addr}")
    else:
        print("  nenhuma - o runtime do fornecedor nao esta com thread ativa")


main()
