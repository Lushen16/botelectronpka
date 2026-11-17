"""
pka_re_map.py - mapa de funcoes e referencias do payload do Shiba, sem Ghidra.

O dump dumps/payload_reconstructed.dll e um PE x64 completo (msftedit.dll
stomped). O campo .pdata da tabela de excecoes da os limites EXATOS de cada
funcao - 7074 entradas. Isso substitui a heuristica de "function start" que o
disassembler teria que adivinhar.

Uso:
  python tools/pka_re_map.py funcs         # lista funcoes com nome inferido
  python tools/pka_re_map.py at 0x57fe8    # qual funcao contem este RVA
  python tools/pka_re_map.py combat        # so as funcoes de combate
  python tools/pka_re_map.py strings 0xa46e0  # strings referenciadas por funcao
  python tools/pka_re_map.py xref "useMedicine"  # quem referencia a string

Tudo estatico. Nenhuma execucao, nenhum processo, nenhum pipe.
"""

import json
import struct
import sys
from pathlib import Path

import pefile

ROOT = Path(__file__).resolve().parent.parent
PAYLOAD = ROOT / "dumps" / "payload_reconstructed.dll"
EVIDENCE = ROOT / "native_remaining_rules_evidence.json"

_pe = None
_img = None
_funcs = None


def load():
    global _pe, _img, _funcs
    if _pe is not None:
        return
    _pe = pefile.PE(str(PAYLOAD))
    _img = _pe.get_memory_mapped_image()
    exc = _pe.OPTIONAL_HEADER.DATA_DIRECTORY[3]
    data = _img[exc.VirtualAddress:exc.VirtualAddress + exc.Size]
    funcs = []
    for i in range(exc.Size // 12):
        start, end, unwind = struct.unpack_from("<III", data, i * 12)
        if start:
            funcs.append((start, end))
    _funcs = sorted(set(funcs))


def func_at(rva):
    """Funcao que contem o RVA. .pdata e ordenado por inicio."""
    load()
    lo, hi = 0, len(_funcs) - 1
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        start, end = _funcs[mid]
        if rva < start:
            hi = mid - 1
        elif rva >= end:
            lo = mid + 1
        else:
            return start, end
        if start <= rva:
            best = (start, end)
    return best


def read_cstr(rva, limit=200):
    load()
    if rva >= len(_img):
        return None
    end = _img.find(b"\x00", rva, min(rva + limit, len(_img)))
    if end < 0:
        return None
    raw = _img[rva:end]
    if len(raw) < 3:
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not all(32 <= ord(c) < 127 or c in "\n\t" for c in text):
        return None
    return text


def scan_string_refs(rva_start, rva_end):
    """Procura lea rdx/rcx/rax,[rip+disp] e movups xmm,[rip+disp] na funcao.

    Padroes reais observados no dump:
      48 8d 15 <disp32>   lea rdx,[rip+disp]
      48 8d 0d <disp32>   lea rcx,[rip+disp]
      48 8d 05 <disp32>   lea rax,[rip+disp]
      0f 10 05 <disp32>   movups xmm0,[rip+disp]
      48 8d 35 <disp32>   lea rsi,[rip+disp]
      4c 8d 05 <disp32>   lea r8,[rip+disp]
    """
    load()
    refs = []
    i = rva_start
    while i < rva_end - 7:
        b = _img[i]
        hit = None
        if b == 0x48 or b == 0x4C:
            if _img[i + 1] == 0x8D and _img[i + 2] in (0x05, 0x0D, 0x15, 0x1D, 0x25, 0x2D, 0x35, 0x3D):
                hit = 7
            elif _img[i + 1] == 0x8D and _img[i + 2] >= 0x80:
                hit = 7
        elif b == 0x0F and _img[i + 1] == 0x10 and _img[i + 2] in (0x05, 0x0D, 0x15):
            hit = 7
        elif b == 0xF2 and _img[i + 1] == 0x0F and _img[i + 2] in (0x10, 0x59, 0x5D, 0x5F, 0x58, 0x5C):
            if i + 3 < len(_img) and _img[i + 3] in (0x05, 0x0D, 0x15):
                hit = 8
        if hit:
            disp = struct.unpack_from("<i", _img, i + (hit - 4))[0]
            target = i + hit + disp
            text = read_cstr(target)
            if text:
                refs.append((i, target, text))
            else:
                refs.append((i, target, None))
            i += hit
            continue
        i += 1
    return refs


def classify(start, end, refs):
    """Nome inferido pelos literais que a funcao referencia."""
    keys = [r[2] for r in refs if r[2]]
    blob = " ".join(keys)
    names = []
    for marker, label in [
        ("tickLoot", "tickLoot"), ("tickHoenn", "tickHoenn"), ("tickBestTile", "tickBestTile"),
        ("useMedicine", "medicine-gate"), ("pokestopToCombo", "combo-dispatch"),
        ("pokeReadyTimeoutMs", "deploy-gate"), ("deployStableSince", "deploy-gate"),
        ("autocombo", "combo"), ("!pokestop", "pokestop"),
        ("!autocombo", "combo"), ("Revive", "revive"), ("revive", "revive"),
        ("useWith", "useWith"), ("Medicine", "medicine"),
        ("Potion", "potion"), ("potion", "potion"),
        ("Best Tile", "best-tile"),
        ("Sessao nao autorizada", "auth"), ("teclas", "keys"),
    ]:
        if marker in blob:
            names.append(label)
    return names


def cmd_funcs():
    load()
    print(f"{'start':>10} {'end':>10} {'size':>7}  labels")
    for start, end in _funcs:
        refs = scan_string_refs(start, end)
        labels = classify(start, end, refs)
        if labels:
            print(f"0x{start:08x} 0x{end:08x} {end - start:7d}  {', '.join(sorted(set(labels)))}")


def cmd_at(rva_text):
    rva = int(rva_text, 16)
    hit = func_at(rva)
    if not hit:
        print(f"0x{rva:x} nao esta em nenhuma funcao do .pdata")
        return
    start, end = hit
    refs = scan_string_refs(start, end)
    labels = classify(start, end, refs)
    print(f"RVA 0x{rva:x} -> funcao 0x{start:x}..0x{end:x} ({end - start} bytes)")
    print(f"labels: {', '.join(sorted(set(labels))) or '(nenhum)'}")
    print(f"strings referenciadas: {len([r for r in refs if r[2]])}")


def cmd_combat():
    load()
    with open(EVIDENCE, encoding="utf-8") as handle:
        evidence = json.load(handle)
    anchors = {}
    for name, rule in evidence["rules"].items():
        for const in rule.get("constants", []):
            anchors.setdefault(int(const["rva"], 16), []).append(name)
        for seq in (rule.get("dispatch_gate") or {}).get("sequence", []):
            anchors.setdefault(int(seq["rva"], 16), []).append(name)
    print("=== regras da evidencia -> funcao real ===")
    seen = {}
    for rva in sorted(anchors):
        hit = func_at(rva)
        label = ",".join(sorted(set(anchors[rva])))
        if not hit:
            print(f"0x{rva:06x} {label:<24} FORA de funcao")
            continue
        seen.setdefault((hit[0], hit[1]), set()).update(anchors[rva])
    print(f"\n{len(seen)} funcoes distintas carregam as regras:")
    for (start, end), labels in sorted(seen.items()):
        refs = scan_string_refs(start, end)
        inferred = classify(start, end, refs)
        print(f"  0x{start:06x}..0x{end:06x} ({end - start:5d}b) "
              f"{','.join(sorted(labels))}")
        if inferred:
            print(f"      literais sugerem: {', '.join(sorted(set(inferred)))}")


def cmd_strings(rva_text):
    rva = int(rva_text, 16)
    hit = func_at(rva)
    if not hit:
        print("fora de funcao")
        return
    start, end = hit
    print(f"funcao 0x{start:x}..0x{end:x}")
    for site, target, text in scan_string_refs(start, end):
        marker = f'0x{site:06x} -> 0x{target:06x}'
        print(f"  {marker}  {text!r}" if text else f"  {marker}  (dado nao-string)")


def cmd_xref(text):
    load()
    needle = text.encode()
    idx = _img.find(needle)
    if idx < 0:
        print(f"string {text!r} nao encontrada no payload")
        return
    print(f"string {text!r} em RVA 0x{idx:x}")
    for start, end in _funcs:
        for site, target, found in scan_string_refs(start, end):
            if target == idx:
                print(f"  referenciada por funcao 0x{start:x}..0x{end:x} (site 0x{site:x})")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    if not PAYLOAD.exists():
        raise SystemExit(f"payload ausente: {PAYLOAD}")
    if cmd == "funcs":
        cmd_funcs()
    elif cmd == "at":
        cmd_at(sys.argv[2])
    elif cmd == "combat":
        cmd_combat()
    elif cmd == "strings":
        cmd_strings(sys.argv[2])
    elif cmd == "xref":
        cmd_xref(sys.argv[2])
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
