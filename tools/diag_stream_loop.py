"""Chama stream_snapshot com timeout e mostra o que acontece de verdade.

Copia o laço do stream mas imprimindo cada exceção em vez de silenciar.

Uso:
  python tools/diag_stream_loop.py --pid 25876 --player-name Nobutdopai --seconds 4
"""
from __future__ import annotations

import argparse
import ctypes
import sys
import time
import traceback

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))

import scan_creatures as scanner
import otclient_rtti as rtti


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--player-name", required=True)
    parser.add_argument("--seconds", type=float, default=4)
    args = parser.parse_args()

    handle = scanner.k32.OpenProcess(
        scanner.PROCESS_QUERY_INFORMATION | scanner.PROCESS_VM_READ, False, args.pid)
    if not handle:
        print("OpenProcess falhou: %d" % ctypes.get_last_error(), file=sys.stderr)
        return 1

    layout, filters = scanner.Layout(), scanner.Filters()
    try:
        player = scanner.locate_player(handle, args.pid, args.player_name, layout, filters)
        player_va = int(player["struct_va"], 16)
        profile = scanner.resolve_stream_profile(handle, args.pid, int(player["vtable"], 16))
        creature_vtable = int(profile["creatureVtable"], 16)
        state = {"creature_vas": [], "player_va": player_va}
        state["creature_vas"] = rtti.scan_instances(handle, creature_vtable)
        print("scan inicial: %d candidatos" % len(state["creature_vas"]))

        deadline = time.time() + args.seconds
        loop = 0
        while time.time() < deadline:
            loop += 1
            try:
                current = scanner.read_entity(handle, state["player_va"], layout)
                if not scanner.valid_player(current, args.player_name, filters):
                    raise ValueError("player identity unavailable")
                creatures = scanner.read_creatures(
                    handle, list(state["creature_vas"]), profile, layout, filters)
                current["ownershipVerified"] = True
                snapshot = scanner.build_creature_snapshot(
                    args.pid, current, creatures, profile, layout)
                text = scanner.json.dumps(snapshot, ensure_ascii=False)
                print("loop %d: creatures=%d bytes=%d" % (loop, len(creatures), len(text)))
            except Exception:
                print("loop %d FALHOU:" % loop, file=sys.stderr)
                traceback.print_exc()
            time.sleep(0.7)
        return 0
    finally:
        scanner.k32.CloseHandle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
