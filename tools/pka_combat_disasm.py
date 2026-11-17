"""
pka_combat_disasm.py - desmonta uma funcao do payload do Shiba resolvendo
referencias RIP-relative para string e para double.

Sem Ghidra: o .pdata da os limites exatos da funcao, o capstone decodifica, e
nos mesmos resolvemos lea/movsd/movups [rip+disp] para o valor real. O
resultado parece pseudo-codigo com nomes, que e o que importa para reconstruir.

Uso:
  python tools/pka_combat_disasm.py 0xa93d0
  python tools/pka_combat_disasm.py 0xa93d0 --callers   # quem chama esta funcao
  python tools/pka_combat_disasm.py --grep attack       # funcoes que usam 'attack'

Estatico. Nenhuma execucao.
"""

import struct
import sys
from pathlib import Path

import pefile
from capstone import Cs, CS_ARCH_X86, CS_MODE_64, CS_OP_IMM, CS_OP_MEM
from capstone.x86 import X86_REG_RIP

ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = ROOT / "dumps" / "payload_reconstructed.dll"
EVIDENCE = ROOT / "native_remaining_rules_evidence.json"

FUNC_NAMES = {
    0x12884: "win32-window-helpers?",
    0x84420: "capture-send-thunk",
    0x99278: "capture-rank?",
    0x9e7a4: "tickHoenn (main)",
    0xa93d0: "comboTick-attack-dispatch",
    0xa9ca4: "revive",
    0xa46e0: "tickLoot",
    0x57020: "medicine-gate",
    0x92bf8: "tickBestTile",
}


class Payload:
    def __init__(self):
        self.pe = pefile.PE(str(PAYLOAD))
        self.img = self.pe.get_memory_mapped_image()
        self.base = self.pe.OPTIONAL_HEADER.ImageBase
        exc = self.pe.OPTIONAL_HEADER.DATA_DIRECTORY[3]
        data = self.img[exc.VirtualAddress:exc.VirtualAddress + exc.Size]
        funcs = []
        for i in range(exc.Size // 12):
            start, end, _ = struct.unpack_from("<III", data, i * 12)
            if start:
                funcs.append((start, end))
        self.funcs = sorted(set(funcs))
        self.md = Cs(CS_ARCH_X86, CS_MODE_64)
        self.md.detail = True

    def func_at(self, rva):
        for start, end in self.funcs:
            if start <= rva < end:
                return start, end
        return None

    def cstr(self, rva, limit=160):
        if rva <= 0 or rva >= len(self.img):
            return None
        end = self.img.find(b"\x00", rva, min(rva + limit, len(self.img)))
        if end < 0:
            return None
        raw = self.img[rva:end]
        if len(raw) < 3:
            return None
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
        if not all(32 <= ord(c) < 127 or c in "\n\t" for c in text):
            return None
        return text

    def double_at(self, rva):
        if rva + 8 > len(self.img):
            return None
        value = struct.unpack_from("<d", self.img, rva)[0]
        if value != value or value in (float("inf"), float("-inf")):
            return None
        if abs(value) < 1e-6 or abs(value) > 1e9:
            return None
        if value == int(value) and abs(value) < 1e9:
            return value
        return value

    def func_name(self, rva):
        if rva in FUNC_NAMES:
            return FUNC_NAMES[rva]
        hit = self.func_at(rva)
        return f"sub_{hit[0]:x}" if hit else f"0x{rva:x}"


def annotations(payload, rva_start, rva_end):
    """RVA da instrucao -> anotacao legivel do alvo RIP-relative."""
    notes = {}
    for insn in payload.md.disasm(payload.img[rva_start:rva_end], rva_start):
        if not insn.operands:
            continue
        for op in insn.operands:
            if op.type != CS_OP_MEM or op.mem.base != X86_REG_RIP:
                continue
            target = (insn.address + insn.size + op.mem.disp) & 0xFFFFFFFF
            text = payload.cstr(target)
            if text:
                notes[insn.address] = ("str", target, text)
                break
            value = payload.double_at(target)
            if value is not None:
                notes[insn.address] = ("num", target, value)
                break
            hit = payload.func_at(target)
            if hit and hit[0] == target:
                notes[insn.address] = ("fn", target, payload.func_name(target))
                break
    return notes


def show(payload, rva):
    hit = payload.func_at(rva)
    if not hit:
        print(f"0x{rva:x} nao esta em funcao")
        return
    start, end = hit
    print(f"--- {payload.func_name(start)}  RVA 0x{start:x}..0x{end:x} "
          f"({end - start} bytes) ---")
    notes = annotations(payload, start, end)
    for insn in payload.md.disasm(payload.img[start:end], start):
        note = notes.get(insn.address)
        suffix = ""
        if note:
            kind, target, value = note
            if kind == "str":
                suffix = f"   ; -> 0x{target:x} {value!r}"
            elif kind == "num":
                suffix = f"   ; -> 0x{target:x} {value}"
            else:
                suffix = f"   ; -> {value}"
        print(f"0x{insn.address:06x}  {insn.mnemonic:<8} {insn.op_str}{suffix}")


def callers(payload, rva_target):
    """Funcoes que fazem call rel32 para o inicio da funcao alvo."""
    target = payload.func_at(rva_target)
    if not target:
        return
    start_target = target[0]
    found = []
    for start, end in payload.funcs:
        if end - start > 200000:
            continue
        for insn in payload.md.disasm(payload.img[start:end], start):
            if insn.mnemonic != "call":
                continue
            if insn.operands and insn.operands[0].type == CS_OP_IMM:
                if insn.operands[0].imm == start_target:
                    found.append((start, insn.address))
    print(f"chamadores de {payload.func_name(start_target)} (0x{start_target:x}):")
    for start, site in found:
        print(f"  0x{start:x}..{payload.func_at(start)[1]:x}  call em 0x{site:x}")


def grep(payload, needle):
    idx = payload.img.find(needle.encode())
    if idx < 0:
        print(f"string {needle!r} ausente")
        return
    print(f"{needle!r} em RVA 0x{idx:x}")
    seen = set()
    for start, end in payload.funcs:
        if end - start > 200000:
            continue
        for insn in payload.md.disasm(payload.img[start:end], start):
            for op in insn.operands:
                if op.type != CS_OP_MEM or op.mem.base != 0:
                    continue
                target = (insn.address + insn.size + op.mem.disp) & 0xFFFFFFFF
                if target == idx and start not in seen:
                    seen.add(start)
                    print(f"  {payload.func_name(start)}  0x{start:x}..0x{end:x}  (site 0x{insn.address:x})")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    payload = Payload()
    if sys.argv[1] == "--grep":
        grep(payload, sys.argv[2])
        return
    rva = int(sys.argv[1], 16)
    if "--callers" in sys.argv:
        callers(payload, rva)
    else:
        show(payload, rva)


if __name__ == "__main__":
    main()

