"""Quais handles de pipe o jogo tem, e para onde apontam?

Se o processo só tem UM handle de pipe com I/O, o security pipe nao e' usado
para comandos - e nao ha nada a tapar la'.
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_DUP_HANDLE = 0x0040


class UNICODE_STRING(ctypes.Structure):
    _fields_ = [("Length", wintypes.USHORT), ("MaximumLength", wintypes.USHORT),
                ("Buffer", ctypes.c_void_p)]


class OBJECT_NAME_INFORMATION(ctypes.Structure):
    _fields_ = [("Name", UNICODE_STRING)]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")

k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.DuplicateHandle.argtypes = [wintypes.HANDLE, wintypes.HANDLE, wintypes.HANDLE,
                                ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
                                wintypes.BOOL, wintypes.DWORD]
k32.GetFileType.argtypes = [wintypes.HANDLE]
k32.GetFileType.restype = wintypes.DWORD
ntdll.NtQueryObject.restype = ctypes.c_long
ntdll.NtQueryObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong)]

FILE_TYPE_PIPE = 3
OBJ_NAME_INFORMATION = 1


def name_of(handle):
    buf = ctypes.create_string_buffer(4096)
    used = ctypes.c_ulong(0)
    status = ntdll.NtQueryObject(handle, OBJ_NAME_INFORMATION, buf,
                                 ctypes.sizeof(buf), ctypes.byref(used))
    if status < 0:
        return None
    info = OBJECT_NAME_INFORMATION.from_buffer(buf)
    if not info.Name.Buffer or not info.Name.Length:
        return None
    raw = ctypes.string_at(info.Name.Buffer, info.Name.Length)
    return raw.decode("utf-16-le", "ignore")


def main():
    pid = int(sys.argv[1])
    me = k32.GetCurrentProcess()
    target = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_DUP_HANDLE, False, pid)
    if not target:
        print("OpenProcess:", ctypes.get_last_error())
        return

    # varre a tabela de handles do alvo
    found = []
    for value in range(0x4, 0x10000, 4):
        dup = wintypes.HANDLE()
        ok = k32.DuplicateHandle(target, value, me, ctypes.byref(dup),
                                 0, False, 0x00000002)
        if not ok:
            continue
        try:
            if k32.GetFileType(dup) != FILE_TYPE_PIPE:
                continue
            name = name_of(dup)
            found.append((value, name))
        finally:
            k32.CloseHandle(dup)

    print(f"handles de PIPE no pid {pid}: {len(found)}")
    for value, name in found:
        label = name or "(sem nome - anonimo)"
        print(f"  0x{value:04x}  {label}")


main()
