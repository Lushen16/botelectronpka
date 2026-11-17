"""Executa um ciclo do stream com as exceções visíveis.

O stream real engole qualquer erro dentro de `except Exception: pass`, então o
arquivo fica vazio e não se sabe por quê. Este diagnóstico repete o laço sem o
silenciamento.

Uso:
  python tools/diag_stream_once.py --pid 25876 --player-name Nobutdopai
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import sys
import traceback

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

import scan_creatures as scanner
import otclient_rtti as rtti


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--player-name", required=True)
    args = parser.parse_args()

    handle = scanner.k32.OpenProcess(
        scanner.PROCESS_QUERY_INFORMATION | scanner.PROCESS_VM_READ, False, args.pid)
    if not handle:
        print("OpenProcess falhou: %d" % ctypes.get_last_error(), file=sys.stderr)
        return 1

    layout, filters = scanner.Layout(), scanner.Filters()
    try:
        print("1 localizando jogador")
        player = scanner.locate_player(handle, args.pid, args.player_name, layout, filters)
        print("   ok:", player["struct_va"], player["name"], player["pos"])

        print("2 resolvendo perfil do stream")
        profile = scanner.resolve_stream_profile(handle, args.pid, int(player["vtable"], 16))
        print("   creatureVtable:", profile["creatureVtable"])
        print("   monsterVtable :", profile["monsterVtable"])
        print("   sha           :", profile["executableSha256"])

        print("3 varrendo instancias")
        addresses = rtti.scan_instances(handle, int(profile["creatureVtable"], 16))
        print("   candidatos:", len(addresses))

        print("4 lendo criaturas")
        creatures = scanner.read_creatures(handle, addresses, profile, layout, filters)
        print("   aprovadas:", len(creatures))
        for row in creatures[:5]:
            print("   ", row)

        print("5 relendo jogador")
        current = scanner.read_entity(handle, int(player["struct_va"], 16), layout)
        print("   valido:", scanner.valid_player(current, args.player_name, filters))
        if current:
            print("   ", current["name"], current["pos"], "hp", current["healthPercent"])

        print("6 montando snapshot")
        snapshot = scanner.build_creature_snapshot(args.pid, current, creatures, profile, layout)
        print("   creatures no snapshot:", len(snapshot["creatures"]))
        return 0
    except Exception:
        print("\nERRO:", file=sys.stderr)
        traceback.print_exc()
        return 2
    finally:
        scanner.k32.CloseHandle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
