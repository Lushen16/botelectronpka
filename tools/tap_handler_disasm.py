"""Desmonta o handler de dispatch (exe+0x7bc2f0) e resolve suas referencias.

Este e' o alvo final da cadeia:

    msftedit 0xe5158 (estrutura de tipo)
      -> chave 0x7496e0
      -> indice 12 na tabela 0xe53b0
      -> handler exe+0x7bc2f0

Se ele for o handler de attack, deve mexer com targetId/alvo. As referencias
(globais, strings, chamadas) dizem isso.

  python tools/tap_handler_disasm.py <pid> [rva]
"""
import ctypes
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


class ME(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD), ("modBaseAddr", ctypes.c_void_p),
        ("modBaseSize", wintypes.DWORD), ("hModule", wintypes.HMODULE),
        ("szModule", ctypes.c_char * 256), ("szExePath", ctypes.c_char * 260),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.Module32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(ME)]
k32.Module32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(ME)]
k32.ReadProcessMemory.restype = wintypes.BOOL


def main():
    pid = int(sys.argv[1])
    rva = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0x7BC2F0
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return

    snap = k32.CreateToolhelp32Snapshot(0x8, pid)
    entry = ME()
    entry.dwSize = ctypes.sizeof(entry)
    exe_base = exe_size = None
    ok = k32.Module32First(snap, ctypes.byref(entry))
    while ok:
        if entry.szModule.decode("latin1").lower().startswith("pokealliance_dx"):
            exe_base, exe_size = entry.modBaseAddr, entry.modBaseSize
            break
        ok = k32.Module32Next(snap, ctypes.byref(entry))
    k32.CloseHandle(snap)
    if not exe_base:
        print("exe nao encontrado")
        return

    def read(address, size):
        buf = ctypes.create_string_buffer(size)
        got = ctypes.c_size_t()
        if not k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size,
                                     ctypes.byref(got)):
            return None
        return buf.raw[:got.value]

    va = exe_base + rva
    print(f"exe base   = 0x{exe_base:x} (size 0x{exe_size:x})")
    print(f"handler VA = 0x{va:x}  (exe+0x{rva:x})")

    code = read(va, 0x200)
    if not code:
        print("nao consegui ler o handler")
        return

    try:
        import capstone
        from capstone.x86 import X86_REG_RIP
    except ImportError:
        print("capstone ausente")
        return

    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    md.detail = True

    print("\n=== disassembly ===")
    count = 0
    refs = []
    for insn in md.disasm(code, va):
        mark = ""
        for op in insn.operands:
            if op.type == capstone.CS_OP_MEM and op.mem.base == X86_REG_RIP:
                target = (insn.address + insn.size + op.mem.disp) & 0xFFFFFFFFFFFFFFFF
                # tentar string
                text = read(target, 80)
                label = ""
                if text:
                    terminated = text.split(b"\x00")[0]
                    if len(terminated) >= 4 and all(32 <= b < 127 for b in terminated):
                        label = repr(terminated.decode("latin1"))[:60]
                rva_target = target - exe_base
                mark = f"   ; exe+0x{rva_target:x}" + (f" {label}" if label else "")
                refs.append((insn.address - exe_base, rva_target, label))
                break
        if insn.mnemonic == "call" and insn.op_str.startswith("0x"):
            try:
                dest = int(insn.op_str, 16)
                mark += f"   -> exe+0x{dest - exe_base:x}"
            except ValueError:
                pass
        print(f"  +0x{insn.address - exe_base:06x}  {insn.mnemonic:<8} {insn.op_str}{mark}")
        count += 1
        if count > 60:
            print("  ... (truncado)")
            break

    print(f"\n=== resumo ({len(refs)} referencias de dados) ===")
    strings = [(site, rva_t, label) for site, rva_t, label in refs if label]
    if strings:
        print("strings:")
        for site, rva_t, label in strings[:12]:
            print(f"  +0x{site:06x} -> {label}")
    globals_ = [(site, rva_t) for site, rva_t, label in refs if not label]
    if globals_:
        print("globais/outros:")
        for site, rva_t in globals_[:12]:
            print(f"  +0x{site:06x} -> exe+0x{rva_t:x}")


main()
