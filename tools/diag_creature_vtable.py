"""Diagnóstico: a varredura de criaturas está usando a vtable certa?

Compara a vtable que o scanner publicou com a que o RTTI resolve agora, e conta
instâncias vivas de cada uma. Read-only.

Uso:
  python tools/diag_creature_vtable.py --pid 25876
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

import otclient_rtti as rtti
import pointer_scan_entities as pe

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.CloseHandle.argtypes = [wintypes.HANDLE]

CLASSES = (
    "Creature",
    "Player",
    "Monster",
    "?$_Ref_count_obj2@VMonster@@@std",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--scan", help="JSON do scan_creatures.py para comparar")
    args = parser.parse_args()

    modules = pe.enum_modules(args.pid)
    module = next(m for m in modules if m["name"].lower() == "pokealliance_dx.exe")
    print("module base=0x%x size=0x%x" % (module["base"], module["size"]))

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, args.pid)
    if not handle:
        raise SystemExit("OpenProcess falhou: %d" % ctypes.get_last_error())
    try:
        image = rtti.read_module_image(handle, module["base"], module["size"])
        print("image bytes=%d" % len(image))
        resolved = {}
        for name in CLASSES:
            value = rtti.resolve_class(image, module["base"], name)
            vtable = value["vtable"] if value else None
            resolved[name] = vtable
            print("  %-34s %s" % (name, hex(vtable) if vtable else "NOT FOUND"))

        print("\ninstancias por vtable resolvida:")
        for name, vtable in resolved.items():
            if not vtable:
                continue
            hits = rtti.scan_instances(handle, vtable)
            print("  %-34s %d instancia(s)" % (name, len(hits)))

        if args.scan:
            with open(args.scan, "r", encoding="utf-8") as fh:
                scan = json.load(fh)
            published = (scan.get("layout") or {}).get("identityProfile") or {}
            print("\npublicado pelo scan:")
            for key in ("creatureVtable", "playerVtable", "monsterVtable"):
                print("  %-18s %s" % (key, published.get(key)))
            print("  creatures no json: %d" % len(scan.get("creatures") or []))

            for key, cls in (("creatureVtable", "Creature"), ("monsterVtable", "Monster")):
                value = published.get(key)
                if not value:
                    continue
                actual = int(value, 16)
                hits = rtti.scan_instances(handle, actual)
                match = "IGUAL ao RTTI" if resolved.get(cls) == actual else "DIVERGENTE do RTTI"
                print("  %s %s -> %d instancia(s) [%s]" % (key, value, len(hits), match))
    finally:
        k32.CloseHandle(handle)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
