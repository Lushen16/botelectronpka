"""Read Electron fuse states from a binary (read-only).

Electron embeds a "fuse wire": [version][count][32-byte sentinel][state bytes].
The sentinel is the ASCII string dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX. State bytes:
0x30 disabled, 0x31 enabled, 0x72 removed.

This matters because EnableEmbeddedAsarIntegrityValidation and
OnlyLoadAppFromAsar decide whether the app payload can be replaced on disk.

Usage:
  python tools/read_fuses.py "path\\to\\PKA Tools.exe"
"""
from __future__ import annotations

import argparse
import sys

SENTINEL = b"dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"
FUSES = [
    "RunAsNode",
    "EnableNodeOptionsEnvironmentVariable",
    "EnableNodeCliInspectArguments",
    "EnableEmbeddedAsarIntegrityValidation",
    "OnlyLoadAppFromAsar",
    "LoadBrowserProcessSpecificV8Snapshot",
    "GrantFileProtocolExtraPrivileges",
]
STATE = {0x30: "disabled", 0x31: "enabled", 0x72: "removed"}


def describe(value: int) -> str:
    return STATE.get(value, "0x%02x" % value)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--raw", action="store_true", help="dump raw wire bytes")
    args = parser.parse_args()

    with open(args.path, "rb") as fh:
        data = fh.read()

    index = data.find(SENTINEL)
    if index < 0:
        print("no fuse sentinel found; not an Electron binary or fuses stripped")
        return 2

    version = data[index + 32]
    count = data[index + 33]
    print("file      :", args.path)
    print("sentinel  : 0x%x" % index)
    print("wire ver  :", version)
    print("fuse count:", count)
    if args.raw:
        print("raw states:", data[index + 34: index + 34 + count].hex())

    for offset in range(count):
        value = data[index + 34 + offset]
        name = FUSES[offset] if offset < len(FUSES) else "fuse-%d" % offset
        print("  %-44s %s" % (name, describe(value)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
