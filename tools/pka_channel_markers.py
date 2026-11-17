"""Procura marcadores do canal no payload e no menu (main.jsc)."""
from pathlib import Path
import pefile

ROOT = Path(__file__).resolve().parent.parent
needles = [b"pka-runtime", b"pka-security", b"?\\pipe", b"pipe\\", b"maxInstances",
           b"PKA_CHANNEL_KEY", b"PKA2/", b"challenge", b"welcome", b"authenticate"]

targets = [("payload(msftedit)", ROOT / "dumps" / "payload_reconstructed.dll"),
           ("main.jsc(menu)", ROOT / "extracted_v3.3.1" / "main.jsc")]

for label, path in targets:
    if not path.exists():
        print(f"{label}: ausente ({path})")
        continue
    raw = path.read_bytes()
    print(f"== {label}  {len(raw)} bytes")
    for needle in needles:
        hits = []
        start = 0
        while len(hits) < 3:
            idx = raw.find(needle, start)
            if idx < 0:
                break
            hits.append(idx)
            start = idx + 1
        shown = ", ".join(hex(h) for h in hits) if hits else "AUSENTE"
        print(f"   {needle!r:<22} {shown}")
    print()
