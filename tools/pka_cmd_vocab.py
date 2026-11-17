"""
pka_cmd_vocab.py - extrai o vocabulario REAL de comandos do Shiba.

Todos os comandos passam por send() em RVA 0x84340. Cada chamador monta um
json com o nome do comando e um dword de tipo antes de chamar. Este script
lista cada call-site com o comando, o tipo e as strings da mensagem.

Uso: python tools/pka_cmd_vocab.py
Estatico, sem execucao.
"""

import re
from pathlib import Path

import pefile
import capstone
from capstone.x86 import X86_REG_RIP

ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = ROOT / "dumps" / "payload_reconstructed.dll"
SEND_RVA = 0x84340
TEXT_START, TEXT_END = 0x1000, 0x287000

NAME_RE = re.compile(r"^[a-zA-Z!][a-zA-Z0-9_]{1,40}$")


def main():
    pe = pefile.PE(str(PAYLOAD))
    img = pe.get_memory_mapped_image()
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    md.detail = True

    calls = []
    for addr in range(TEXT_START, TEXT_END - 5):
        if img[addr] != 0xE8:
            continue
        rel = int.from_bytes(img[addr + 1:addr + 5], "little", signed=True)
        if (addr + 5 + rel) & 0xFFFFFFFF == SEND_RVA:
            calls.append(addr)

    print(f"call sites de send(0x{SEND_RVA:x}): {len(calls)}\n")
    print(f"{'site':>10}  {'tipo':>6}  {'comando':<16} strings")
    print("-" * 100)

    for site in calls:
        back = max(TEXT_START, site - 0xC0)
        strings = []
        type_value = None
        for insn in md.disasm(img[back:site], back):
            for op in insn.operands:
                if op.type == capstone.CS_OP_MEM and op.mem.base == X86_REG_RIP:
                    target = (insn.address + insn.size + op.mem.disp) & 0xFFFFFFFF
                    end = img.find(b"\x00", target, min(target + 70, len(img)))
                    if end < 0:
                        continue
                    try:
                        text = img[target:end].decode("utf-8")
                    except UnicodeDecodeError:
                        continue
                    if NAME_RE.match(text):
                        strings.append(text)
            if insn.mnemonic == "mov" and "dword ptr [rsp + 0x40]" in insn.op_str:
                type_value = insn.op_str.rsplit(",", 1)[-1].strip()

        command = strings[-1] if strings else "?"
        extra = [s for s in strings[:-1] if len(s) > 3][-2:]
        note = " | ".join(extra)
        print(f"0x{site:08x}  {str(type_value):>6}  {command:<16} {note}")


if __name__ == "__main__":
    main()
