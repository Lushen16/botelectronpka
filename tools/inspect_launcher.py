"""Inspect a PE launcher: sections, imports, resources and embedded PE images.

Read-only. Helps identify how the Shiba/PKA launcher stores and injects the
native payload and which Windows APIs it resolves.

Usage:
  python tools/inspect_launcher.py "path\\to\\launcher.exe"
"""

from __future__ import annotations

import argparse
import math
import struct
from pathlib import Path

import pefile


def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = [0] * 256
    for byte in data:
        counts[byte] += 1
    total = len(data)
    return -sum((c / total) * math.log2(c / total) for c in counts if c)


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    args = parser.parse_args()
    path = Path(args.path)
    data = path.read_bytes()
    pe = pefile.PE(data=bytes(data), fast_load=False)

    print("FILE %s bytes=%d" % (path, len(data)))
    print("MACHINE 0x%X SUBSYSTEM %s TS %d" % (
        pe.FILE_HEADER.Machine,
        getattr(pe.OPTIONAL_HEADER, "Subsystem", None),
        pe.FILE_HEADER.TimeDateStamp))
    print("ENTRY 0x%X IMAGEBASE 0x%X SIZEOFIMAGE 0x%X" % (
        pe.OPTIONAL_HEADER.AddressOfEntryPoint,
        pe.OPTIONAL_HEADER.ImageBase,
        pe.OPTIONAL_HEADER.SizeOfImage))

    print("\nSECTIONS")
    last_end = 0
    for section in pe.sections:
        name = section.Name.rstrip(b"\x00").decode("latin-1")
        raw = section.get_data()
        last_end = max(last_end, section.PointerToRawData + section.SizeOfRawData)
        print("  %-10s VA=0x%08X VSize=0x%08X Ptr=0x%08X RSize=0x%08X ent=%.3f" % (
            name, section.VirtualAddress, section.Misc_VirtualSize,
            section.PointerToRawData, section.SizeOfRawData, entropy(raw)))
    print("  OVERLAY offset=0x%X bytes=%d" % (last_end, max(0, len(data) - last_end)))

    print("\nIMPORTS")
    wanted = ("kernel32", "ntdll", "advapi32", "user32", "shell32", "ole32",
              "combase", "crypt32", "bcrypt", "ws2_32", "psapi", "dbghelp")
    if hasattr(pe, "DIRECTORY_ENTRY_IMPORT"):
        for entry in pe.DIRECTORY_ENTRY_IMPORT:
            dll = entry.dll.decode("latin-1")
            names = []
            for imp in entry.imports:
                if imp.name:
                    names.append(imp.name.decode("latin-1"))
                else:
                    names.append("ord#%d" % imp.ordinal if imp.ordinal else "?")
            if any(token in dll.lower() for token in wanted):
                print("  %s: %s" % (dll, ", ".join(names)))
            else:
                print("  %s: %d functions" % (dll, len(names)))
    else:
        print("  (no import directory)")

    print("\nDELAY IMPORTS")
    if hasattr(pe, "DIRECTORY_ENTRY_DELAY_IMPORT"):
        for entry in pe.DIRECTORY_ENTRY_DELAY_IMPORT:
            names = [imp.name.decode("latin-1") if imp.name else "?" for imp in entry.imports]
            print("  %s: %s" % (entry.dll.decode("latin-1"), ", ".join(names)))
    else:
        print("  (none)")

    print("\nRESOURCES")
    if hasattr(pe, "DIRECTORY_ENTRY_RESOURCE"):
        for type_entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
            type_name = type_entry.name.string.decode("utf-8", "replace") if type_entry.name else getattr(type_entry, "id", "?")
            for name_entry in getattr(type_entry.directory, "entries", []):
                label = name_entry.name.string.decode("utf-8", "replace") if name_entry.name else getattr(name_entry, "id", "?")
                for lang_entry in getattr(name_entry.directory, "entries", []):
                    d = lang_entry.data.struct
                    print("  type=%-14s name=%-12s lang=%-6s offset=0x%08X size=%d" % (
                        type_name, label, getattr(lang_entry, "id", "?"), d.OffsetToData, d.Size))
    else:
        print("  (none)")

    print("\nEMBEDDED PE CANDIDATES")
    limit = min(len(data), 64 * 1024 * 1024)
    offset = 0
    found = 0
    while True:
        offset = data.find(b"MZ", offset)
        if offset < 0 or offset >= limit:
            break
        if offset + 0x40 <= len(data):
            e_lfanew = u32(data, offset + 0x3C)
            at = offset + e_lfanew
            if 0 < e_lfanew < 0x1000 and at + 0x18 <= len(data) and data[at:at + 4] == b"PE\x00\x00":
                machine, sections = struct.unpack_from("<HH", data, at + 4)
                if machine in (0x14C, 0x8664, 0xAA64):
                    found += 1
                    print("  off=0x%08X machine=0x%X sections=%d e_lfanew=0x%X" % (
                        offset, machine, sections, e_lfanew))
        offset += 1
    print("  total=%d" % found)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
