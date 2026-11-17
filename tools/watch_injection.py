"""Passive watcher for the Shiba/PKA injection moment.

Watches (read-only) for:
  1. shiba_bots*.dll being written to the injector folder, seizing it with a
     delete-lock before the injector removes it.
  2. PokeAlliance_dx.exe loading the stomped msftedit.dll module.
  3. The pka-runtime-2-<pid> / pka-security-<pid> named pipes appearing.
  4. When the runtime pipe appears, dumps the injected module from memory with
     tools/scan_payload_memory.py (read-only).

Does not write to the target process and does not touch its memory.

Usage:
  python tools/watch_injection.py --out captures/injection-<ts> --minutes 45
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import json
import os
import subprocess
import sys
import threading
import time

GENERIC_READ = 0x80000000
FILE_SHARE_READ = 0x1
FILE_SHARE_WRITE = 0x2
OPEN_EXISTING = 3
FILE_ATTRIBUTE_NORMAL = 0x80
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

TH32CS_SNAPPROCESS = 0x2
TH32CS_SNAPMODULE = 0x8
TH32CS_SNAPMODULE32 = 0x10
MAX_PATH = 260

k32 = ctypes.WinDLL("kernel32", use_last_error=True)


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * MAX_PATH),
    ]


class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD),
        ("modBaseAddr", ctypes.POINTER(ctypes.c_byte)),
        ("modBaseSize", wintypes.DWORD),
        ("hModule", wintypes.HMODULE),
        ("szModule", ctypes.c_wchar * 256),
        ("szExePath", ctypes.c_wchar * MAX_PATH),
    ]


k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
k32.Module32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
k32.Module32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.CloseHandle.argtypes = [wintypes.HANDLE]

k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                           wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]


def process_image_path(pid: int) -> str | None:
    handle = k32.OpenProcess(0x1000, False, pid)
    if not handle:
        return None
    try:
        size = wintypes.DWORD(MAX_PATH)
        buf = ctypes.create_unicode_buffer(size.value)
        if k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value
        return None
    finally:
        k32.CloseHandle(handle)


def list_processes() -> list[dict]:
    out = []
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE:
        return out
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = k32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            out.append({
                "pid": int(entry.th32ProcessID),
                "ppid": int(entry.th32ParentProcessID),
                "name": entry.szExeFile,
            })
            ok = k32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return out


def list_modules(pid: int) -> list[dict]:
    out = []
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if snap == INVALID_HANDLE_VALUE:
        return out
    try:
        entry = MODULEENTRY32W()
        entry.dwSize = ctypes.sizeof(MODULEENTRY32W)
        ok = k32.Module32FirstW(snap, ctypes.byref(entry))
        while ok:
            out.append({
                "name": entry.szModule,
                "path": entry.szExePath,
                "base": hex(ctypes.cast(entry.modBaseAddr, ctypes.c_void_p).value or 0),
                "size": int(entry.modBaseSize),
            })
            ok = k32.Module32NextW(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return out


def list_pipes() -> list[str]:
    try:
        return sorted(name for name in os.listdir("\\\\.\\pipe\\") if "pka" in name.lower() or "shiba" in name.lower())
    except OSError:
        return []


def seize(path: str) -> bytes | None:
    handle = k32.CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                             None, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, None)
    if handle in (None, INVALID_HANDLE_VALUE, 0xFFFFFFFFFFFFFFFF):
        return None
    try:
        chunks = []
        while True:
            buf = ctypes.create_string_buffer(65536)
            read = wintypes.DWORD(0)
            if not k32.ReadFile(handle, buf, 65536, ctypes.byref(read), None) or read.value == 0:
                break
            chunks.append(buf.raw[: read.value])
        return b"".join(chunks) if chunks else None
    finally:
        k32.CloseHandle(handle)


class Watcher:
    def __init__(self, out_dir: str, dirs: list[str], minutes: float):
        self.out_dir = out_dir
        self.dirs = dirs
        self.deadline = time.time() + minutes * 60
        self.events_path = os.path.join(out_dir, "events.jsonl")
        os.makedirs(out_dir, exist_ok=True)
        self.log_lock = threading.Lock()
        self.seen_procs: set[tuple[int, str]] = set()
        self.seen_pipes: set[str] = set()
        self.payload_done: set[str] = set()
        self.payload_sizes: dict[str, int] = {}
        self.injection_handled: set[int] = set()
        self.last_snapshot = 0.0
        self.log("watch_start", dirs=dirs, out=out_dir)

    def log(self, event: str, **fields):
        record = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "event": event, **fields}
        line = json.dumps(record, ensure_ascii=False)
        with self.log_lock:
            with open(self.events_path, "a", encoding="utf-8") as fh:
                fh.write(line + "\n")
            print(line, flush=True)

    def scan_payloads(self):
        folders: list[str] = []
        for folder in self.dirs:
            folders.append(folder)
            sub = os.path.join(folder, "dll")
            if os.path.isdir(sub):
                folders.append(sub)
        for folder in folders:
            try:
                names = os.listdir(folder)
            except OSError:
                continue
            for name in names:
                low = name.lower()
                if "shiba_bots" not in low:
                    continue
                full = os.path.join(folder, name)
                try:
                    size = os.path.getsize(full)
                except OSError:
                    continue
                previous = self.payload_sizes.get(full)
                if previous == size and full in self.payload_done:
                    continue
                self.payload_sizes[full] = size
                if size < 4096:
                    continue
                data = seize(full)
                if not data:
                    self.log("payload_locked", path=full, size=size)
                    continue
                if len(data) < 4096:
                    self.log("payload_partial", path=full, size=len(data))
                    continue
                stamp = time.strftime("%H%M%S")
                target = os.path.join(self.out_dir, f"shiba_bots_{stamp}_{len(data)}.bin")
                with open(target, "wb") as fh:
                    fh.write(data)
                self.payload_done.add(full)
                self.log("payload_seized", path=full, bytes=len(data), out=target,
                         mz=data[:2] == b"MZ")

    def poll_processes(self):
        procs = list_processes()
        interesting = [p for p in procs if any(token in p["name"].lower() for token in
                       ("pokealliance", "pka", "shiba", "a497a7", "2442e7", "electron"))]
        for proc in interesting:
            key = (proc["pid"], proc["name"])
            if key in self.seen_procs:
                continue
            self.seen_procs.add(key)
            image = process_image_path(proc["pid"])
            self.log("process", pid=proc["pid"], ppid=proc["ppid"], name=proc["name"], image=image)
            if image:
                self.add_dirs(os.path.dirname(image))
        return procs

    def add_dirs(self, base: str):
        for candidate in (os.path.join(base, "dll"), base):
            norm = os.path.normpath(candidate)
            if norm in self.dirs or not os.path.isdir(norm):
                continue
            self.dirs.append(norm)
            self.log("watch_dir_added", dir=norm)

    def check_game(self, procs: list[dict]):
        games = [p for p in procs if "pokealliance" in p["name"].lower()]
        for game in games:
            game_image = process_image_path(game["pid"])
            if game_image:
                self.add_dirs(os.path.dirname(game_image))
            modules = list_modules(game["pid"])
            stomped = [m for m in modules if m["name"].lower() in ("msftedit.dll",)
                       or "shiba" in m["name"].lower() or "pka" in m["name"].lower()]
            for mod in stomped:
                mark = (game["pid"], mod["name"], mod["base"], mod["size"])
                if mark in self.injection_handled:
                    continue
                self.injection_handled.add(mark)
                self.log("module_loaded", pid=game["pid"], name=mod["name"], base=mod["base"],
                         size=mod["size"], path=mod["path"])
                self.dump_memory(game["pid"], mod)

    def dump_memory(self, pid: int, module: dict):
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "scan_payload_memory.py")
        dump_dir = os.path.join(self.out_dir, f"memory-{pid}-{time.strftime('%H%M%S')}")
        try:
            proc = subprocess.Popen([sys.executable, script, "--pid", str(pid), "--dump", dump_dir],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            threading.Thread(target=self._collect_dump, args=(proc, dump_dir, pid), daemon=True).start()
            self.log("memory_dump_started", pid=pid, dir=dump_dir)
        except Exception as exc:  # noqa: BLE001
            self.log("memory_dump_error", pid=pid, error=str(exc))

    def _collect_dump(self, proc, dump_dir, pid):
        try:
            out, err = proc.communicate(timeout=180)
            self.log("memory_dump_done", pid=pid, returncode=proc.returncode, dir=dump_dir,
                     stdout=(out or "")[-800:], stderr=(err or "")[-800:])
        except subprocess.TimeoutExpired:
            proc.kill()
            self.log("memory_dump_timeout", pid=pid, dir=dump_dir)

    def check_pipes(self):
        pipes = list_pipes()
        for name in pipes:
            if name in self.seen_pipes:
                continue
            self.seen_pipes.add(name)
            self.log("pipe", name=name)
            if name.startswith("pka-runtime-2-"):
                self.log("runtime_pipe_ready", name=name,
                         hint="handshake client can be tried now")

    def run(self):
        while time.time() < self.deadline:
            self.scan_payloads()
            now = time.time()
            if now - self.last_snapshot >= 0.4:
                self.last_snapshot = now
                procs = self.poll_processes()
                self.check_game(procs)
                self.check_pipes()
            time.sleep(0.004)
        self.log("watch_end")


def candidate_dirs() -> list[str]:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidates = [
        os.path.join(here, "..", "Shiba_Bots_App", "dll"),
        os.path.join(here, "..", "Shiba_Bots_App"),
        r"C:\OTPbot\dll",
        r"C:\OTPbot",
        os.environ.get("TEMP", ""),
        os.environ.get("LOCALAPPDATA", ""),
    ]
    return [os.path.normpath(p) for p in candidates if p and os.path.isdir(p)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--minutes", type=float, default=45)
    parser.add_argument("--dirs", default="")
    args = parser.parse_args()

    dirs = [os.path.normpath(p) for p in args.dirs.split(";") if p] if args.dirs else candidate_dirs()
    watcher = Watcher(os.path.abspath(args.out), dirs, args.minutes)
    watcher.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
