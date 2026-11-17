"""Acha o dispatcher nativo na build LIVE, sem header PE.

Mesma tecnica do tap: varre as regioes executaveis procurando as instrucoes que
carregam o endereco das strings do dispatcher (`lea reg,[rip+disp]`) e resolve
o alvo. As strings sao:

  [native] Client profile %s verified ... dispatcher RVA %llX
  [native] Resolving %s target %u.
  [native] Dispatching %s target %u.

Quem referencia as tres juntas e' o dispatcher.

  python tools/tap_find_dispatch_live.py
"""
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DUMP = ROOT / "dumps" / "msftedit_live_32036.bin"

STRINGS = {
    b"[native] Dispatching %s target %u.": "dispatching",
    b"[native] Resolving %s target %u.": "resolving",
    b"[native] Client profile %s verified": "profile",
}


def find_string(data, needle):
    index = data.find(needle)
    return index if index >= 0 else None


def main():
    data = DUMP.read_bytes()
    print(f"dump: {DUMP.name} ({len(data)} bytes, 0x{len(data):x})")

    targets = {}
    for needle, label in STRINGS.items():
        offset = find_string(data, needle)
        print(f"  {label:<12} string em 0x{offset:x}" if offset is not None
              else f"  {label:<12} AUSENTE")
        if offset is not None:
            targets[offset] = label

    # varre instrucoes RIP-relative em busca de lea/mov apontando para as strings
    print("\nprocurando referencias (lea rXX,[rip+disp]) ...")
    hits = {}
    for i in range(len(data) - 7):
        byte = data[i]
        # 48/4c 8d 05/0d/15/1d/25/2d/35/3d  disp32
        if byte in (0x48, 0x4C) and data[i + 1] == 0x8D and \
                data[i + 2] in (0x05, 0x0D, 0x15, 0x1D, 0x25, 0x2D, 0x35, 0x3D):
            disp = struct.unpack_from("<i", data, i + 3)[0]
            target = (i + 7 + disp) & 0xFFFFFFFF
            if target in targets:
                hits.setdefault(target, []).append(i)

    for offset, label in sorted(targets.items()):
        sites = hits.get(offset, [])
        print(f"  {label:<12} 0x{offset:x}: {len(sites)} referencias "
              f"{[hex(s) for s in sites[:5]]}")

    if not hits:
        print("\nnenhuma referencia encontrada (pode ser movups/outro opcode)")
        return

    # agrupa por funcao aproximada: sites proximos = mesma funcao
    all_sites = sorted(site for sites in hits.values() for site in sites)
    print(f"\ntodos os sites: {[hex(s) for s in all_sites]}")

    groups = []
    for site in all_sites:
        if groups and site - groups[-1][-1] < 0x2000:
            groups[-1].append(site)
        else:
            groups.append([site])

    print(f"\nagrupados por proximidade ({len(groups)} regioes):")
    for group in groups:
        labels = set()
        for site in group:
            for offset, label in targets.items():
                if site in hits.get(offset, []):
                    labels.add(label)
        print(f"  regiao 0x{group[0]:x}..0x{group[-1]:x}  "
              f"{len(group)} refs  labels={sorted(labels)}")


main()
