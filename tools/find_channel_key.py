"""Locate and report the live PKA_CHANNEL_KEY without writing to any process.

The key never appears in the process environment (verified against the live
game, launcher and Electron menu). It lives in the Electron menu's heap: the
menu generates it, exports it through the environment of the launcher, and the
injector hands it to the native module. This tool recovers it from the menu
heap by scanning the key-shaped value, then reports it next to its pid so the
probe can be run.

Read-only: OpenProcess(QUERY_INFORMATION | VM_READ) + ReadProcessMemory.

Usage:
  python tools/find_channel_key.py --pid 17908
  python tools/find_channel_key.py --auto          # finds the menu itself
  python tools/find_channel_key.py --auto --write captures/channel-key.json
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import re
import sys
import time

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100
MAX_REGION = 512 * 1024 * 1024

# The runtime key is 32 lowercase hex chars in every observed instance
# (PKA_CHANNEL_KEY=<32 hex> in the menu heap).
KEY_RE = re.compile(rb"(?<![0-9a-fA-F])([0-9a-f]{32})(?![0-9a-fA-F])")
CONTEXT_RE = re.compile(rb"PKA_CHANNEL_KEY=|CHANNEL_KEY")

# FALSE POSITIVE that cost a session: the loader executable is named after its
# own sha256 (`06676ed92f072f08f6384557fd8ccb95.exe.tmp`), so a 32-hex run
# matching KEY_RE appears in the menu heap inside the process path. It is NOT
# the channel key. A candidate is rejected when it is immediately surrounded by
# path/executable context.
LOADER_CONTEXT_RE = re.compile(
    rb"(?:[\\/][0-9a-fA-F]{32}\.exe|\.exe\.tmp|[\\/]Apps[\\/]|ShibaLauncher|"
    rb"[0-9a-fA-F]{32}\.exe\.tmp)", re.IGNORECASE)

k32 = ctypes.WinDLL("kernel32", use_last_error=True)


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.VirtualQueryEx.restype = ctypes.c_size_t
k32.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                               ctypes.POINTER(MBI), ctypes.c_size_t]
k32.ReadProcessMemory.restype = wintypes.BOOL
k32.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_size_t,
                                  ctypes.POINTER(ctypes.c_size_t)]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def list_processes() -> list[dict]:
    import subprocess
    output = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
        capture_output=True, text=True, timeout=30)
    if output.returncode != 0 or not output.stdout.strip():
        return []
    data = json.loads(output.stdout)
    return data if isinstance(data, list) else [data]


def find_menu_pid() -> tuple[int, int | None]:
    """Returns (menu_pid, game_pid_or_None) from the menu command line."""
    for row in list_processes():
        name = str(row.get("Name") or "")
        command = str(row.get("CommandLine") or "")
        if "--client-pid=" not in command or not name.lower().endswith(".exe.tmp"):
            continue
        match = re.search(r"--client-pid=(\d+)", command)
        game = int(match.group(1)) if match else None
        return int(row["ProcessId"]), game
    return None, None


def scan(pid: int, max_hits: int) -> list[dict]:
    handle = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise SystemExit("OpenProcess falhou: %d" % ctypes.get_last_error())
    hits: list[dict] = []
    address = 0
    try:
        while len(hits) < max_hits:
            mbi = MBI()
            if not k32.VirtualQueryEx(handle, ctypes.c_void_p(address),
                                      ctypes.byref(mbi), ctypes.sizeof(mbi)):
                break
            base = int(mbi.BaseAddress or 0)
            size = int(mbi.RegionSize)
            if not size:
                break
            readable = (mbi.State == MEM_COMMIT and not (mbi.Protect & PAGE_GUARD)
                        and mbi.Protect != PAGE_NOACCESS and size <= MAX_REGION)
            if readable:
                buf = ctypes.create_string_buffer(size)
                got = ctypes.c_size_t(0)
                if k32.ReadProcessMemory(handle, ctypes.c_void_p(base), buf,
                                         ctypes.c_size_t(size), ctypes.byref(got)) and got.value:
                    data = buf.raw[: got.value]
                    for match in KEY_RE.finditer(data):
                        value = match.group(1).decode("ascii")
                        lo = max(0, match.start() - 64)
                        hi = min(len(data), match.end() + 64)
                        near = data[lo:hi]
                        # Descarta o hash do loader (nome do .exe.tmp) e
                        # qualquer valor colado a contexto de caminho.
                        if LOADER_CONTEXT_RE.search(near):
                            continue
                        hits.append({
                            "key": value,
                            "va": "0x%x" % (base + match.start()),
                            "region_base": "0x%x" % base,
                            "region_size": "0x%x" % size,
                            "protect": "0x%x" % mbi.Protect,
                            "marked": bool(CONTEXT_RE.search(near)),
                        })
                        if len(hits) >= max_hits:
                            break
            address = base + size
    finally:
        k32.CloseHandle(handle)
    return hits


def ranked(hits: list[dict]) -> list[dict]:
    marker_seen = any(hit["marked"] for hit in hits)
    if not marker_seen:
        return hits
    return sorted(hits, key=lambda hit: (not hit["marked"], hit["va"]))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int)
    parser.add_argument("--auto", action="store_true")
    parser.add_argument("--game-pid", type=int,
                        help="PID do PokeAlliance_dx.exe (default: --client-pid do menu)")
    parser.add_argument("--max-hits", type=int, default=400)
    parser.add_argument("--write")
    args = parser.parse_args()

    game_pid = args.game_pid
    pid = args.pid
    if args.auto or not pid:
        pid, discovered = find_menu_pid()
        game_pid = game_pid or discovered
        if not pid:
            print("menu Electron (--client-pid=... .exe.tmp) nao encontrado.", file=sys.stderr)
            return 2

    started = time.time()
    hits = scan(pid, args.max_hits)
    ordered = ranked(hits)
    print("pid=%d regioes_varridas_hits=%d marcados=%d em %.1fs" % (
        pid, len(hits), sum(1 for hit in hits if hit["marked"]), time.time() - started))
    for hit in ordered[:20]:
        print("  %s%s %s" % (hit["va"], "  <PKA_CHANNEL_KEY>" if hit["marked"] else "", hit["key"]))
    if not ordered:
        return 3

    best = next((hit for hit in ordered if hit["marked"]), ordered[0])
    print("melhor_candidato=%s" % best["key"])
    if len({hit["key"] for hit in ordered}) > 1:
        print("aviso: mais de um valor candidato; confirme com o probe antes de usar.")

    if args.write:
        # reconstruction/native-adapter.cjs exige record.pid === pid do JOGO.
        # Gravar o pid do menu produziria "Arquivo da chave ... de outro PID".
        record = {"capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "pid": game_pid if game_pid is not None else pid,
                  "key": best["key"],
                  "source": "menu heap scan",
                  "menuPid": pid,
                  "va": best["va"], "marked": best["marked"],
                  "candidates": sorted({hit["key"] for hit in ordered})}
        if game_pid is None:
            print("aviso: --client-pid ausente no menu; gravando pid do menu. "
                  "Passe --game-pid para o contrato do native-adapter.", file=sys.stderr)
        with open(args.write, "w", encoding="utf-8") as fh:
            json.dump(record, fh, indent=2)
        print("escrito:", args.write)
    return 0


if __name__ == "__main__":
    sys.exit(main())
