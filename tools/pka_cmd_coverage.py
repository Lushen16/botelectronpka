"""
pka_cmd_coverage.py - compara o vocabulario de comandos do payload com o nosso
protocol.cjs.

Le os nomes candidatos APENAS da regiao de JSON do runtime (0xe4000..0xeb000),
que e onde o payload guarda as chaves de config/comando, e cruza com
reconstruction/protocol.cjs.

Uso: python tools/pka_cmd_coverage.py
"""

import re
from pathlib import Path

import pefile

ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = ROOT / "dumps" / "payload_reconstructed.dll"
PROTOCOL = ROOT / "reconstruction" / "protocol.cjs"

# faixa de rdata onde ficam as chaves json do runtime (ver pka_re_map.py)
JSON_START, JSON_END = 0xE4000, 0xEB000


def main():
    img = pefile.PE(str(PAYLOAD)).get_memory_mapped_image()
    region = img[JSON_START:JSON_END]

    names = set()
    for match in re.finditer(rb"[A-Za-z][A-Za-z0-9]{2,28}", region):
        names.add(match.group().decode())

    source = PROTOCOL.read_text(encoding="utf-8")
    match = re.search(r"const COMMANDS = \{([^}]*)\}", source)
    if not match:
        raise SystemExit("COMMANDS nao encontrado em protocol.cjs")
    ours = set()
    for pair in match.group(1).split(","):
        if ":" in pair:
            ours.add(pair.split(":")[0].strip().strip("'\""))

    print(f"comandos no nosso protocol.cjs: {len(ours)}")
    print(f"identificadores na faixa json do payload: {len(names)}\n")

    # um comando do payload que nao exista no nosso protocol.cjs e' divergencia
    command_like = sorted(n for n in names
                          if n in ("walk", "attack", "follow", "stop", "focus", "talk",
                                   "combo", "switchPokemon", "action", "fight", "potion",
                                   "revive", "useWith", "recallPokemon", "order", "turn",
                                   "refreshCombo", "chase", "hotkey", "orderGround",
                                   "guildDaily", "talkPrivate", "walkPrivate")
                          or re.fullmatch(r"(talk|walk|order|chase|fight|action)[A-Z][A-Za-z]+", n))

    print("=== comandos que o payload conhece ===")
    for name in command_like:
        off = img.find(name.encode() + b"\x00")
        mark = "OK   " if name in ours else "FALTA"
        print(f"  {mark} {name:<18} RVA 0x{off:x}")

    missing = [n for n in command_like if n not in ours]
    print(f"\nfaltando no nosso protocol.cjs: {missing or '(nenhum)'}")


if __name__ == "__main__":
    main()
