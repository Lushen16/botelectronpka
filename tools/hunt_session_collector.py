import sys
import os
import time
import json
import datetime
from pathlib import Path

root = Path(r"C:\Users\yago\Documents\Clone\RECONSTRUÇAO OFIcial")
snap_path = root / "live-snapshot.json"
creat_path = root / "live-creatures.json"
log_path = root / "hunt_session_40min.jsonl"
summary_path = root / "hunt_session_summary.json"

DURATION_MINUTES = 40
start_time = time.time()
end_time = start_time + (DURATION_MINUTES * 60)

print(f"[*] Iniciando Coletor de Telemetria Passiva por {DURATION_MINUTES} minutos...")
print(f"[*] Monitorando {snap_path.name} e {creat_path.name}")
print(f"[*] Gravando histórico em {log_path.name}")

stats = {
    "status": "RECORDING_ACTIVE",
    "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "pid": None,
    "player_name": None,
    "ticks": 0,
    "unique_waypoints": set(),
    "monsters_encountered": set(),
    "lowest_hp": 100,
    "highest_hp": 100,
    "floors_visited": set(),
    "combat_events": 0,
    "target_history": []
}

last_target = None
last_pos = None

try:
    with open(log_path, "a", encoding="utf-8") as out_f:
        while time.time() < end_time:
            tick_now = time.time()
            elapsed_s = round(tick_now - start_time, 1)

            # Ler snapshot do jogador
            player_data = None
            if snap_path.exists():
                try:
                    with open(snap_path, "r", encoding="utf-8") as f:
                        snap = json.load(f)
                        stats["pid"] = snap.get("pid")
                        player_data = snap.get("player")
                except Exception:
                    pass

            # Ler snapshot de criaturas
            creatures = []
            if creat_path.exists():
                try:
                    with open(creat_path, "r", encoding="utf-8") as f:
                        cdata = json.load(f)
                        creatures = cdata.get("creatures", [])
                except Exception:
                    pass

            if player_data:
                stats["player_name"] = player_data.get("name")
                pos = player_data.get("pos", {})
                hp = player_data.get("hp", player_data.get("healthPercent", 100))
                stats["ticks"] += 1

                pos_key = (pos.get("x"), pos.get("y"), pos.get("z"))
                stats["unique_waypoints"].add(pos_key)
                if pos.get("z") is not None:
                    stats["floors_visited"].add(pos.get("z"))

                if hp < stats["lowest_hp"]:
                    stats["lowest_hp"] = hp

                moved = (last_pos != pos_key)
                last_pos = pos_key

                # Identificar criaturas próximas
                nearby_names = []
                for c in creatures:
                    name = c.get("name")
                    chp = c.get("hp")
                    if name:
                        stats["monsters_encountered"].add(name)
                        nearby_names.append(f"{name}({chp}%)")

                entry = {
                    "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "elapsed_s": elapsed_s,
                    "pos": pos,
                    "hp": hp,
                    "moved": moved,
                    "creatures_count": len(creatures),
                    "nearby": nearby_names[:6]
                }
                out_f.write(json.dumps(entry) + "\n")
                out_f.flush()

                # Atualizar sumario a cada 5 segundos
                if stats["ticks"] % 5 == 0:
                    summary = {
                        "status": "RECORDING_ACTIVE",
                        "started_at": stats["started_at"],
                        "last_update": entry["ts"],
                        "elapsed_minutes": round(elapsed_s / 60, 2),
                        "remaining_minutes": round(max(0, end_time - tick_now) / 60, 2),
                        "total_ticks": stats["ticks"],
                        "unique_waypoints_walked": len(stats["unique_waypoints"]),
                        "current_pos": pos,
                        "current_hp": hp,
                        "lowest_hp_seen": stats["lowest_hp"],
                        "floors_visited": list(stats["floors_visited"]),
                        "all_monsters_encountered": sorted(list(stats["monsters_encountered"])),
                        "monsters_around_now": nearby_names
                    }
                    with open(summary_path, "w", encoding="utf-8") as sf:
                        json.dump(summary, sf, indent=2)

            time.sleep(1.0)

except KeyboardInterrupt:
    print("[!] Monitoramento encerrado pelo operador.")
finally:
    print(f"[+] Finalizado. {stats['ticks']} registros salvos em {log_path.name}")
