"""Localiza o campo de tipo de criatura no build ativo.

Le a entidade e imprime os bytes em volta de 0x180, alem de comparar os
candidatos com o que o scanner classifica hoje. Tambem tenta descobrir o
offset do campo de tipo comparando monstros selvagens com o pet.

Uso: python -B tools/diag_type_offset.py --pid 25876
"""
from __future__ import annotations

import argparse
import ctypes
import struct
import sys
from ctypes import wintypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import otclient_rtti as rtti
import pointer_scan_entities as pe

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [wintypes.HANDLE]

POS, Z, ID, NAME, HP, TYPE = 0x30, 0x38, 0x5C, 0x80, 0xC0, 0x186


def read(handle, va, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(va), buf,
                                 ctypes.c_size_t(size), ctypes.byref(got)):
        return None
    return buf.raw[:got.value]


def dump(handle, va):
    data = read(handle, va, 0x200)
    if not data or len(data) < 0x200:
        return None
    vtable = struct.unpack_from("<Q", data, 0)[0]
    x, y = struct.unpack_from("<ii", data, POS)
    z = struct.unpack_from("<h", data, Z)[0]
    cid = struct.unpack_from("<I", data, ID)[0]
    name = data[NAME:NAME + 32].split(b"\x00")[0].decode("ascii", "replace")
    hp = data[HP]
    return {"va": va, "vtable": vtable, "pos": (x, y, z), "id": cid,
            "name": name, "hp": hp, "data": data}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    args = parser.parse_args()

    modules = pe.enum_modules(args.pid)
    module = next(m for m in modules if m["name"].lower() == "pokealliance_dx.exe")
    handle = k32.OpenProcess(0x0400 | 0x0010, False, args.pid)
    if not handle:
        raise SystemExit("OpenProcess falhou: %d" % ctypes.get_last_error())
    try:
        image = rtti.read_module_image(handle, module["base"], module["size"])
        control = rtti.resolve_class(image, module["base"], "?$_Ref_count_obj2@VMonster@@@std")
        monster = rtti.resolve_class(image, module["base"], "Monster")

        wrappers = rtti.scan_instances(handle, control["vtable"])
        print("wrappers:", len(wrappers))

        rows = []
        for va in wrappers:
            info = dump(handle, va)
            if not info:
                continue
            head = read(handle, va, 24)
            if not head or len(head) != 24:
                continue
            if struct.unpack_from("<Q", head, 16)[0] != monster["vtable"]:
                print("  [skip] ptr@16 != monsterVtable at", hex(va))
                continue
            rows.append(info)

        print("com ptr@16 == monsterVtable:", len(rows))
        for row in rows:
            d = row["data"]
            # mapa de bytes interessantes entre 0x178 e 0x1A0
            window = {hex(off): d[off] for off in range(0x178, 0x1A0)}
            print("  %-12s id=%-11s pos=%-18s hp=%-4s type@0x186=%s" % (
                row["name"] or "(sem nome)", row["id"], str(row["pos"]), row["hp"], d[TYPE]))
            print("      bytes 0x178..0x1A0:", " ".join(
                "%02x" % d[off] for off in range(0x178, 0x1A0)))
        return 0
    finally:
        k32.CloseHandle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
