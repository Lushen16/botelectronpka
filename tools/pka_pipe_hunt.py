"""Procura fragmentos do nome do pipe e da API de criacao nos binarios."""
from pathlib import Path
import pefile

ROOT = Path(__file__).resolve().parent.parent

fragments = [b"pka", b"runtime", b"-2-", b"security", b"NamedPipe", b"Pipe"]
targets = [
    ("payload(msftedit)", ROOT / "dumps" / "payload_reconstructed.dll", True),
    ("payload_live37152", ROOT / "dumps" / "payload_reconstructed_live37152.dll", True),
    ("menu main.jsc", ROOT / "extracted_v3.3.1" / "main.jsc", False),
    ("menu pipe-bridge.jsc", ROOT / "extracted_v3.3.1" / "lib" / "pipe-bridge.jsc", False),
    ("menu native-runtime.jsc", ROOT / "extracted_v3.3.1" / "lib" / "native-runtime.jsc", False),
]

def utf16(s):
    return s.decode().encode("utf-16-le")

for label, path, is_pe in targets:
    if not path.exists():
        print(f"{label}: AUSENTE")
        continue
    raw = path.read_bytes()
    print(f"== {label} ({len(raw)} bytes)")
    for frag in fragments:
        ascii_hits = []
        start = 0
        while len(ascii_hits) < 2:
            idx = raw.find(frag, start)
            if idx < 0:
                break
            ascii_hits.append(idx)
            start = idx + 1
        u = utf16(frag)
        wide_hits = []
        start = 0
        while len(wide_hits) < 2:
            idx = raw.find(u, start)
            if idx < 0:
                break
            wide_hits.append(idx)
            start = idx + 1
        a = ", ".join(hex(h) for h in ascii_hits) or "-"
        w = ", ".join(hex(h) for h in wide_hits) or "-"
        print(f"   {frag!r:<14} ascii[{a}]  utf16[{w}]")
    if is_pe:
        pe = pefile.PE(str(path))
        imports = set()
        for entry in pe.DIRECTORY_ENTRY_IMPORT:
            for imp in entry.imports:
                if imp.name:
                    imports.add(imp.name.decode())
        pipe_api = sorted(n for n in imports if "Pipe" in n or "File" in n)
        print(f"   APIs de pipe/arquivo: {pipe_api}")
    print()
