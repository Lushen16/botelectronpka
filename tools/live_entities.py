"""Extrai ids de criatura VIVOS direto da memoria do jogo.

Nao usa o pipe (a telemetria do fornecedor pode parar). Le a tabela de
entidades do cliente: procura instancias cujo vtable bate com a conhecida e
valida os campos de posicao/hp/type pelos offsets do build.

Offsets confirmados (reconstruction/executable-profile.cjs, validados em
2026-11-03 e 2026-11-04):
  typeOffset 0x186, id 0x5C, hp 0xC0, pos 0x30, name 0x80

  python tools/live_entities.py <pid> [--json]
"""
import ctypes
import json
import struct
import sys
from ctypes import wintypes

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
MEM_IMAGE = 0x1000000
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01

OFF_POS = 0x30
OFF_ID = 0x5C
OFF_NAME = 0x80
OFF_HP = 0xC0
OFF_TYPE = 0x186
ENTITY_SIZE = 0x190


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_ulonglong), ("AllocationBase", ctypes.c_ulonglong),
        ("AllocationProtect", wintypes.DWORD), ("__a1", wintypes.DWORD),
        ("RegionSize", ctypes.c_ulonglong), ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD), ("Type", wintypes.DWORD), ("__a2", wintypes.DWORD),
    ]


k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                               ctypes.POINTER(MBI), ctypes.c_size_t]


def read(handle, address, size):
    buf = ctypes.create_string_buffer(size)
    got = ctypes.c_size_t()
    if not k32.ReadProcessMemory(handle, ctypes.c_void_p(address), buf, size,
                                 ctypes.byref(got)):
        return None
    if got.value != size:
        return None
    return buf.raw


def parse_entity(raw):
    """Valida uma instancia candidata pelos campos de offset."""
    type_value = raw[OFF_TYPE]
    if type_value not in (0, 1, 3):
        return None
    cid = struct.unpack_from("<I", raw, OFF_ID)[0]
    if cid < 0x1000 or cid == 0xFFFFFFFF:
        return None
    x, y = struct.unpack_from("<ii", raw, OFF_POS)
    z = struct.unpack_from("<h", raw, OFF_POS + 8)[0]
    if not (-100 <= z <= 100):
        return None
    if not (0 <= x <= 65535 and 0 <= y <= 65535):
        return None
    hp = raw[OFF_HP]
    if hp > 100:
        return None
    name_raw = raw[OFF_NAME:OFF_NAME + 32]
    name = name_raw.split(b"\0")[0]
    if len(name) < 1 or len(name) > 30:
        return None
    try:
        text = name.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if not all(32 <= ord(c) < 127 for c in text):
        return None
    return {"id": cid, "name": text, "type": type_value, "hp": hp,
            "pos": {"x": x, "y": y, "z": z}}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    pid = int(sys.argv[1])
    as_json = "--json" in sys.argv

    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        print("OpenProcess:", ctypes.get_last_error())
        return

    mbi = MBI()
    address = 0x10000
    found = []
    seen_ids = set()
    scanned = 0
    readable_bytes = 0

    while address < 0x7FFFFFFFFFFF:
        if not k32.VirtualQueryEx(handle, ctypes.c_void_p(address), ctypes.byref(mbi),
                                  ctypes.sizeof(mbi)):
            break
        base, size = mbi.BaseAddress, mbi.RegionSize
        if size == 0:
            break
        ok = (mbi.State == MEM_COMMIT
              and (mbi.Protect & (0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x80))
              and not (mbi.Protect & (PAGE_GUARD | PAGE_NOACCESS)))
        if ok and size < 64 * 1024 * 1024:
            # le em blocos de 16 MB
            for offset in range(0, size, 16 * 1024 * 1024):
                chunk = min(16 * 1024 * 1024, size - offset)
                data = read(handle, base + offset, chunk)
                if not data:
                    continue
                readable_bytes += len(data)
                scanned += 1
                # varre por alinhamento de 8: candidatos
                for i in range(0, len(data) - ENTITY_SIZE, 8):
                    entity = parse_entity(data[i:i + ENTITY_SIZE])
                    if not entity:
                        continue
                    if entity["id"] in seen_ids:
                        continue
                    seen_ids.add(entity["id"])
                    found.append(entity)
        nxt = base + size
        if nxt <= address:
            break
        address = nxt

    k32.CloseHandle(handle)

    hostiles = [e for e in found if e["type"] == 1 and e["hp"] > 0]
    own = [e for e in found if e["type"] == 3]
    players = [e for e in found if e["type"] == 0]

    if as_json:
        print(json.dumps({"hostiles": hostiles, "own": own, "players": players,
                          "scannedBlocks": scanned,
                          "readableMB": round(readable_bytes / 1048576, 1)}, indent=2))
        return

    print(f"blocos lidos: {scanned} | {readable_bytes / 1048576:.0f} MB de memoria")
    print(f"entidades validadas: {len(found)} "
          f"(hostis={len(hostiles)} proprios={len(own)} players={len(players)})\n")

    if hostiles:
        print("HOSTIS (type=1, hp>0):")
        for e in hostiles[:12]:
            print(f"  id={e['id']:<12} {e['name']:<18} hp={e['hp']:>3}% "
                  f"pos=({e['pos']['x']},{e['pos']['y']},{e['pos']['z']})")
    else:
        print("nenhum hostil vivo na memoria")
    if own:
        print("\nproprios (type=3):")
        for e in own[:4]:
            print(f"  id={e['id']:<12} {e['name']:<18} hp={e['hp']:>3}%")
    if players:
        print("\nplayers (type=0):")
        for e in players[:4]:
            print(f"  id={e['id']:<12} {e['name']:<18} hp={e['hp']:>3}% "
                  f"pos=({e['pos']['x']},{e['pos']['y']},{e['pos']['z']})")


main()
