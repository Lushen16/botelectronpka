"""Descobre COMO o payload chama WriteFile/ReadFile.

Zero `call [rip+slot]` para a IAT foi um resultado forte: o payload nao usa o
slot da IAT como alvo de call direto. Entao precisamos ver as outras formas:

  1. mov reg, [rip+slot]  ; call reg        (ponteiro carregado em registrador)
  2. lea reg, [rip+slot]  ; ...             (endereco do slot)
  3. jmp [rip+slot]                         (tail call)
  4. o compilador pode ter usado um thunk interno (_guard_...)
"""
from pathlib import Path
import pefile
import capstone
from capstone.x86 import X86_REG_RIP

ROOT = Path(__file__).resolve().parent.parent
pe = pefile.PE(str(ROOT / "dumps" / "payload_reconstructed.dll"))
img = pe.get_memory_mapped_image()
base = pe.OPTIONAL_HEADER.ImageBase

slots = {}
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    for imp in entry.imports:
        if imp.name and imp.name.decode() in ("WriteFile", "ReadFile"):
            slots[imp.address - base] = imp.name.decode()

md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.detail = True

found = {name: [] for name in slots.values()}
operands_of_interest = {}

for insn in md.disasm(img[0x1000:0x287000], 0x1000):
    for op in insn.operands:
        if op.type != capstone.CS_OP_MEM or op.mem.base != X86_REG_RIP:
            continue
        target = (insn.address + insn.size + op.mem.disp) & 0xFFFFFFFF
        if target not in slots:
            continue
        name = slots[target]
        found[name].append((insn.address, insn.mnemonic, insn.op_str))
        operands_of_interest[insn.address] = name

for name, hits in found.items():
    print(f"=== {name}: {len(hits)} referencias ao slot da IAT ===")
    for site, mnemonic, ops in hits[:14]:
        print(f"  0x{site:06x}  {mnemonic:<8} {ops}")
    print()

# Mostra o contexto das 3 primeiras referencias para ver o padrao de chamada
sites = sorted(operands_of_interest)[:3]
for site in sites:
    name = operands_of_interest[site]
    print(f"--- contexto de 0x{site:x} ({name}) ---")
    window = max(0x1000, site - 32)
    for insn in md.disasm(img[window:site + 24], window):
        mark = " <<<" if insn.address in operands_of_interest else ""
        print(f"  0x{insn.address:06x}  {insn.mnemonic:<8} {insn.op_str}{mark}")
    print()
