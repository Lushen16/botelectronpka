"""O payload resolve WriteFile/ReadFile dinamicamente ou usa a IAT?

Se houver lea para a string do nome da API seguido de GetProcAddress, o hook de
IAT nao pega nada. Se nao houver, e import estatico e o hook funciona.
"""
from pathlib import Path
import pefile
import capstone
from capstone.x86 import X86_REG_RIP

ROOT = Path(__file__).resolve().parent.parent
pe = pefile.PE(str(ROOT / "dumps" / "payload_reconstructed.dll"))
img = pe.get_memory_mapped_image()
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
md.detail = True

targets = {
    "WriteFile": img.find(b"WriteFile\x00"),
    "ReadFile": img.find(b"ReadFile\x00"),
    "CreateNamedPipeW": img.find(b"CreateNamedPipeW\x00"),
    "PeekNamedPipe": img.find(b"PeekNamedPipe\x00"),
}

for name, addr in targets.items():
    if addr < 0:
        print(f"{name:<20} string AUSENTE")
        continue
    hits = []
    for a in range(0x1000, 0x287000 - 7):
        if img[a] in (0x48, 0x4C) and img[a + 1] == 0x8D and img[a + 2] in (
                0x05, 0x0D, 0x15, 0x1D, 0x25, 0x2D, 0x35, 0x3D):
            disp = int.from_bytes(img[a + 3:a + 7], "little", signed=True)
            if (a + 7 + disp) & 0xFFFFFFFF == addr:
                hits.append(a)
    if hits:
        print(f"{name:<20} rva=0x{addr:x}  lea xrefs: {[hex(h) for h in hits[:6]]}")
    else:
        print(f"{name:<20} rva=0x{addr:x}  lea xrefs: NENHUM (import estatico, hook de IAT funciona)")

# confirma na IAT que WriteFile aponta para o thunk de import
print()
for entry in pe.DIRECTORY_ENTRY_IMPORT:
    for imp in entry.imports:
        if imp.name and imp.name.decode() in ("WriteFile", "ReadFile"):
            print(f"IAT: {entry.dll.decode():<40} {imp.name.decode():<12} thunk=0x{imp.address:x}")
