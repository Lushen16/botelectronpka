"""Inspeciona os candidatos de Creature no processo vivo.

Para cada instância com a vtable do wrapper, mostra os primeiros bytes e testa
os filtros do scanner um a um, para saber qual rejeita.

Uso:
  python tools/diag_creature_candidates.py --pid 25876 --limit 8
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import struct
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

import otclient_rtti as rtti
import pointer_scan_entities as pe

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [wintypes.HANDLE]

LAYOUT = {
    "pos_offset": 0x30,
    "z_offset": 0x38,
    "id_offset": 0x5C,
    "name_offset": 0x80,
    "hp_offset": 0xC0,
    "type_offset": 0x186,
}


def read(handle, va, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t(0)
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(va), buf,
                                 ctypes.c_size_t(size), ctypes.byref(got)):
        return None
    return buf.raw[: got.value]


def describe(handle, va, monster_vtable):
    data = read(handle, va, 0x190)
    if not data or len(data) < 0x190:
        return {"va": hex(va), "read": "FAIL"}
    vtable = struct.unpack_from("<Q", data, 0)[0]
    x, y = struct.unpack_from("<ii", data, LAYOUT["pos_offset"])
    z = struct.unpack_from("<h", data, LAYOUT["z_offset"])[0]
    cid = struct.unpack_from("<I", data, LAYOUT["id_offset"])[0]
    raw_name = data[LAYOUT["name_offset"]:LAYOUT["name_offset"] + 32].split(b"\x00")[0]
    hp = data[LAYOUT["hp_offset"]]
    ctype = data[LAYOUT["type_offset"]]
    head = read(handle, va, 24) or b""
    ref = struct.unpack_from("<I", head + b"\x00" * 12, 8)[0] if len(head) >= 12 else None
    at16 = struct.unpack_from("<Q", head + b"\x00" * 24, 16)[0] if len(head) >= 24 else None
    return {
        "va": hex(va),
        "vtable": hex(vtable),
        "id": cid,
        "name": raw_name.decode("ascii", "replace"),
        "pos": (x, y, z),
        "hp": hp,
        "type": ctype,
        "refcount@8": ref,
        "ptr@16": hex(at16) if at16 is not None else None,
        "ptr@16==monster": at16 == monster_vtable,
        "head24": head.hex() if head else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--limit", type=int, default=8)
    args = parser.parse_args()

    modules = pe.enum_modules(args.pid)
    module = next(m for m in modules if m["name"].lower() == "pokealliance_dx.exe")
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, args.pid)
    if not handle:
        raise SystemExit("OpenProcess falhou: %d" % ctypes.get_last_error())
    try:
        image = rtti.read_module_image(handle, module["base"], module["size"])
        control = rtti.resolve_class(image, module["base"], "?$_Ref_count_obj2@VMonster@@@std")
        monster = rtti.resolve_class(image, module["base"], "Monster")
        creature = rtti.resolve_class(image, module["base"], "Creature")
        print("control vtable =", hex(control["vtable"]))
        print("monster vtable =", hex(monster["vtable"]))
        print("creature vtable=", hex(creature["vtable"]))

        wrappers = rtti.scan_instances(handle, control["vtable"])
        print("\nwrapper instances:", len(wrappers))
        print("\nprimeiros %d candidatos:" % args.limit)
        ok = 0
        for va in wrappers[: args.limit]:
            info = describe(handle, va, monster["vtable"])
            print("  ", info)
            if info.get("ptr@16==monster"):
                ok += 1
        print("\ncom ptr@16 == monsterVtable:", ok, "de", min(len(wrappers), args.limit))

        # Também testa a vtable de Creature direto, caso o layout tenha mudado.
        creatures = rtti.scan_instances(handle, creature["vtable"])
        print("\ninstancias da vtable Creature:", len(creatures))
        for va in creatures[: args.limit]:
            print("  ", describe(handle, va, monster["vtable"]))
    finally:
        k32.CloseHandle(handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
