"""Como o payload chama WriteFile/ReadFile?

Procura `call qword ptr [rip+disp]` cujo alvo cai na faixa da IAT. Se achar,
e' chamada via IAT (hook de IAT funciona). Se nao achar, o payload resolve o
endereco de outra forma e a IAT nao e' o caminho.
"""
from pathlib import Path
import struct
import pefile
import capstone
from capstone.x86 import X86_REG_RIP

ROOT = Path(__file__).resolve().parent.parent
pe = pefile.PE(str(ROOT / "dumps" / "payload_reconstructed.dll"))
img = pe.get_memory_mapped_image()
base = pe.OPTIONAL_HEADER.ImageBase

iat = pe.OPTIONAL_HEADER.DATA_DIRECTORY[12]
print(f"IAT: rva=0x{iat.VirtualAddress:x} size=0x{iat.Size:x}")
lo, hi = iat.VirtualAddress, iat.VirtualAddress + iat.Size

# quais slots sao WriteFile / ReadFile
slots = {}
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    for imp in entry.imports:
        if imp.name and imp.name.decode() in ("WriteFile", "ReadFile"):
            slots[imp.address - base] = imp.name.decode()
for rva, name in slots.items():
    print(f"  slot {name:<10} rva=0x{rva:x} (dentro da IAT: {lo <= rva < hi})")

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.detail = True

calls = []
for insn in md.disasm(img[0x1000:0x287000], 0x1000):
    if insn.mnemonic != "call":
        continue
    for op in insn.operands:
        if op.type == capstone.CS_OP_MEM and op.mem.base == X86_REG_RIP:
            target = (insn.address + insn.size + op.mem.disp) & 0xFFFFFFFF
            if lo <= target < hi:
                calls.append((insn.address, target, slots.get(target, "outro")))

print(f"\ncall qword [rip+..] para a IAT: {len(calls)}")
by_name = {}
for site, target, name in calls:
    by_name.setdefault(name, []).append(site)
for name, sites in sorted(by_name.items(), key=lambda kv: -len(kv[1])):
    sample = ", ".join(hex(s) for s in sites[:6])
    print(f"  {name:<12} {len(sites):4d} sites   ex: {sample}")
