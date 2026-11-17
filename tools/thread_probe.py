"""Check whether the injected native module still has live worker threads.

The runtime is a native worker thread inside the game process. If that thread
died (for example when the menu closed), the named pipes stay visible but no
server side ever calls ConnectNamedPipe again, and every client read fails with
ERROR_PIPE_NOT_CONNECTED (233).

This enumerates threads of the target process and reports how many start
addresses fall inside the injected module range. Read-only.

Usage:
  python tools/thread_probe.py --pid 23152 --module-base 0x7ffd09ca0000 --module-size 0x138000
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import subprocess
import sys

THREAD_QUERY_INFORMATION = 0x0040


def list_threads(pid: int) -> list[dict]:
    script = (
        "Get-CimInstance Win32_Thread -Filter \"ProcessHandle='%d'\" | "
        "Select-Object Handle,ThreadId,StartAddress,State,ThreadState | ConvertTo-Json -Compress"
    ) % pid
    result = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                            capture_output=True, text=True, timeout=90)
    if result.returncode != 0 or not result.stdout.strip():
        return []
    data = json.loads(result.stdout)
    return data if isinstance(data, list) else [data]


def parse_hex(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, int):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(text, 0)
    except ValueError:
        try:
            return int(text)
        except ValueError:
            return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--module-base", type=lambda v: int(v, 0), required=True)
    parser.add_argument("--module-size", type=lambda v: int(v, 0), required=True)
    args = parser.parse_args()

    threads = list_threads(args.pid)
    if not threads:
        print("nenhuma thread enumerada (permissao ou processo ausente)", file=sys.stderr)
        return 2

    lo = args.module_base
    hi = lo + args.module_size
    inside = []
    for thread in threads:
        start = parse_hex(thread.get("StartAddress"))
        if start is not None and lo <= start < hi:
            inside.append({"threadId": thread.get("ThreadId"), "start": hex(start),
                           "state": thread.get("ThreadState")})

    print("pid=%d threads=%d" % (args.pid, len(threads)))
    print("module=0x%x..0x%x" % (lo, hi))
    print("threads starting inside module: %d" % len(inside))
    for row in inside:
        print("  %s" % json.dumps(row))
    return 0


if __name__ == "__main__":
    sys.exit(main())
