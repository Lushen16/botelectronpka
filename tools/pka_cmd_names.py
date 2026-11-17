"""Confere se certos nomes de comando existem como literal no payload."""
from pathlib import Path
import pefile

ROOT = Path(__file__).resolve().parent.parent
img = pefile.PE(str(ROOT / "dumps" / "payload_reconstructed.dll")).get_memory_mapped_image()

names = ["combo", "talkPrivate", "attack", "walk", "order", "orderGround", "chase",
         "fight", "action", "useWith", "hotkey", "revive", "potion", "stop",
         "follow", "focus", "turn", "refreshCombo", "switchPokemon", "recallPokemon",
         "guildDaily", "walkable"]

for name in names:
    for variant in (name.encode() + b"\x00", b"\x00" + name.encode()):
        off = img.find(variant)
        if off > 0:
            print(f"{name:<16} presente  RVA 0x{off:x}")
            break
    else:
        print(f"{name:<16} AUSENTE")
