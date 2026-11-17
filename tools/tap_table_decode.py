"""Decodifica a tabela de dispatch em 0xe53b0.

Cada entrada tem 0x20 bytes. O primeiro dword parece ser uma vtable e o segundo
um handler. Este script verifica se sao RVAs validas dentro do modulo e mostra
o comeco do codigo de cada alvo.

  python tools/tap_table_decode.py
"""
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "dumps" / "msftedit_live_32036.bin"

RANGES = ((0xE53B0, 0xE5730), (0xE5990, 0xE5AD0), (0xE6970, 0xE6CF0))


def describe(data, rva):
    if rva >= len(data):
        return "fora do modulo"
    code = data[rva:rva + 8]
    if not code:
        return "vazio"
    text = code.hex(" ")
    hint = ""
    if code[0] in (0x40, 0x48, 0x4C, 0x53, 0x55, 0x56, 0x57):
        hint = "  <- prologo"
    return text + hint


def main():
    data = DUMP.read_bytes()
    print(f"dump: {DUMP.name} ({len(data)} bytes)\n")

    for start, end in RANGES:
        print(f"=== faixa 0x{start:06x}..0x{end:06x} ===")
        entries = 0
        for i in range(0, end - start, 0x20):
            offset = start + i
            if offset + 8 > len(data):
                break
            first, second = struct.unpack_from("<II", data, offset)
            if first == 0 and second == 0:
                continue
            entries += 1
            if entries > 12:
                continue
            print(f"  0x{offset:06x}  [{first:08x} {second:08x}]")
            print(f"      1o: {describe(data, first)}")
            print(f"      2o: {describe(data, second)}")
        print(f"  entradas nao-nulas: {entries}\n")


main()
