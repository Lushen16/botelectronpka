"""Dumpa os campos ao redor do offset de tipo das criaturas reais do stream.

Compara criaturas do snapshot vivo com o jogador para descobrir qual byte
distingue selvagem de pet neste build.

Uso: python -B tools/diag_type_bytes.py --pid 25876 --snapshot local-data/live-creatures.json
"""
from __future__ import annotations

import argparse
import ctypes
import json
import struct
import sys
from ctypes import wintypes
from pathlib import Path

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def read(handle, va, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(va), buf,
                                 ctypes.c_size_t(size), ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--snapshot", default="local-data/live-creatures.json")
    args = parser.parse_args()

    snapshot = json.loads(Path(args.snapshot).read_text(encoding="utf-8"))
    handle = k32.OpenProcess(0x0400 | 0x0010, False, args.pid)
    if not handle:
        raise SystemExit("OpenProcess falhou: %d" % ctypes.get_last_error())
    try:
        targets = [("PLAYER", snapshot.get("player"))] + [
            ("CREATURE", row) for row in snapshot.get("creatures", [])]
        for label, row in targets:
            if not row or not row.get("struct_va"):
                continue
            va = int(row["struct_va"], 16)
            data = read(handle, va, 0x1A0)
            if not data:
                print(label, hex(va), "READ FAIL")
                continue
            print("%s %s id=%s name=%s pos=%s hp=%s type@0x186=%s" % (
                label, hex(va), row.get("id"), row.get("name"), row.get("pos"),
                row.get("healthPercent"), data[0x186]))
            for base in (0x0, 0x40, 0xC0, 0x170, 0x180, 0x190):
                chunk = data[base:base + 32]
                print("  0x%03x: %s  |%s|" % (
                    base, " ".join("%02x" % b for b in chunk),
                    "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)))
        return 0
    finally:
        k32.CloseHandle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
