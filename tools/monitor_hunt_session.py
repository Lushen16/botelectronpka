import sys
import os
import time
import json
import datetime

root = r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial"
sys.path.insert(0, os.path.join(root, "tools"))

import pka_live_session as pls
import scan_creatures as sc

PID = 37936
DURATION_MINUTES = 40
LOG_FILE = os.path.join(root, "hunt_session_40min.jsonl")
SUMMARY_FILE = os.path.join(root, "hunt_session_summary.json")

print(f"[*] Iniciando Monitoramento de 40 Minutos para PID {PID}...")
print(f"[*] Arquivo de log: {LOG_FILE}")

handle = sc.k32.OpenProcess(sc.PROCESS_QUERY_INFORMATION | sc.PROCESS_VM_READ, False, PID)
if not handle:
    print(f"[-] Erro: Nao foi possivel abrir o processo {PID}")
    sys.exit(1)

# Descobrir layout e base
player_va, layout, filters = pls.find_player(lambda va, sz: pls.rpm(handle, va, sz))
if not player_va:
    print("[-] Erro: Player nao encontrado na memoria.")
    sys.exit(1)

print(f"[+] Player encontrado em VA: {hex(player_va)}")

start_time = time.time()
end_time = start_time + (DURATION_MINUTES * 60)

stats = {
    "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "pid": PID,
    "ticks": 0,
    "positions_recorded": 0,
    "monsters_encountered": set(),
    "lowest_hp": 100,
    "floors_visited": set(),
}

last_pos = None

try:
    with open(LOG_FILE, "a", encoding="utf-8") as out_f:
        while time.time() < end_time:
            tick_now = time.time()
            player = pls.read_entity(lambda va, sz: pls.rpm(handle, va, sz), player_va, layout, filters)
            if not player:
                player_va, layout, filters = pls.find_player(lambda va, sz: pls.rpm(handle, va, sz))
                player = pls.read_entity(lambda va, sz: pls.rpm(handle, va, sz), player_va, layout, filters) if player_va else None

            if player:
                pos = player["pos"]
                hp = player.get("hp", 100)
                stats["ticks"] += 1
                stats["floors_visited"].add(pos["z"])
                if hp < stats["lowest_hp"]:
                    stats["lowest_hp"] = hp

                moved = False
                if last_pos != (pos["x"], pos["y"], pos["z"]):
                    moved = True
                    stats["positions_recorded"] += 1
                    last_pos = (pos["x"], pos["y"], pos["z"])

                record = {
                    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "elapsed_s": round(tick_now - start_time, 1),
                    "player": player,
                    "moved": moved
                }

                out_f.write(json.dumps(record) + "\n")
                out_f.flush()

                # Escrever sumario atualizado a cada 5 segundos
                if stats["ticks"] % 5 == 0:
                    summary_data = {
                        "status": "MONITORING_ACTIVE",
                        "started_at": stats["started_at"],
                        "last_update": record["ts"],
                        "elapsed_minutes": round((tick_now - start_time) / 60, 2),
                        "total_ticks": stats["ticks"],
                        "waypoints_walked": stats["positions_recorded"],
                        "lowest_hp": stats["lowest_hp"],
                        "current_hp": hp,
                        "current_pos": pos,
                        "floors_visited": list(stats["floors_visited"])
                    }
                    with open(SUMMARY_FILE, "w", encoding="utf-8") as sf:
                        json.dump(summary_data, sf, indent=2)

            time.sleep(1.0)

except KeyboardInterrupt:
    print("[!] Monitoramento interrompido manualmente.")
finally:
    sc.k32.CloseHandle(handle)
    print(f"[+] Monitoramento finalizado. Total de ticks: {stats['ticks']}")
