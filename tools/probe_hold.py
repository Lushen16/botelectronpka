"""Handshake probe that opens the pipe ONCE and holds the handle.

Every earlier probe opened, read, got ERROR_PIPE_NOT_CONNECTED (233) and closed,
then reopened. With maxInstances=1, each open/close cycle can tear down the very
instance the server is about to call ConnectNamedPipe on, so the retry loop may
be starving itself. This probe:

  1. waits for an instance to be free (WaitNamedPipe) without closing anything,
  2. opens exactly one handle,
  3. performs overlapping reads with a timeout on that same handle,
  4. answers a challenge if one ever arrives.

It never reopens after a successful open. It sends only the authenticate frame.

Usage:
  python tools/probe_hold.py --pid 26596 --key <key> --seconds 60
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import hmac
import json
import struct
import time

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
FILE_FLAG_OVERLAPPED = 0x40000000
INVALID = (None, -1, 0xFFFFFFFFFFFFFFFF)
MAX_FRAME = 2105344
CLIENT_DOMAIN = b"PKA2/client\x00"
SERVER_DOMAIN = b"PKA2/server\x00"
KIND = {1: "challenge", 2: "authenticate", 3: "welcome", 4: "state", 5: "telemetry",
        6: "automation", 7: "startup", 8: "automation_revoked", 9: "manual",
        10: "ack", 11: "automation_control", 12: "automation_lease"}

k32 = ctypes.WinDLL("kernel32", use_last_error=True)


class OVERLAPPED_IO(ctypes.Structure):
    _fields_ = [
        ("Internal", ctypes.c_size_t),
        ("InternalHigh", ctypes.c_size_t),
        ("Offset", wintypes.DWORD),
        ("OffsetHigh", wintypes.DWORD),
        ("hEvent", wintypes.HANDLE),
    ]


k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                            wintypes.HANDLE]
k32.WaitNamedPipeW.restype = wintypes.BOOL
k32.WaitNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(OVERLAPPED_IO)]
k32.ReadFile.restype = wintypes.BOOL
k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                          ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(OVERLAPPED_IO)]
k32.WriteFile.restype = wintypes.BOOL
k32.GetOverlappedResult.argtypes = [wintypes.HANDLE, ctypes.POINTER(OVERLAPPED_IO),
                                    ctypes.POINTER(wintypes.DWORD), wintypes.BOOL]
k32.GetOverlappedResult.restype = wintypes.BOOL
k32.CreateEventW.restype = wintypes.HANDLE
k32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
k32.CloseHandle.argtypes = [wintypes.HANDLE]

ERROR_IO_PENDING = 997
ERROR_PIPE_BUSY = 231
ERROR_PIPE_NOT_CONNECTED = 233
ERROR_SEM_TIMEOUT = 121
BUSY_ERRORS = (ERROR_PIPE_BUSY, ERROR_SEM_TIMEOUT)
WAIT_OBJECT_0 = 0


def pipe_path(pid: int) -> str:
    return "\\\\" + "." + "\\" + "pipe" + "\\" + ("pka-runtime-2-%d" % pid)


def frame(kind: int, payload: bytes = b"") -> bytes:
    return struct.pack("<II", len(payload), kind) + payload


def proof(key: bytes, domain: bytes, nonce: bytes, pid: int) -> bytes:
    return hmac.new(key, domain + nonce + struct.pack("<I", pid), hashlib.sha256).digest()


def open_once(path: str, deadline: float) -> tuple[int | None, int]:
    """Waits for a free instance and opens a single handle. Returns (handle, error).

    ERROR_SEM_TIMEOUT (121) and ERROR_PIPE_BUSY (231) both mean "all instances
    are taken" for WaitNamedPipe; neither is a bad path.
    """
    while time.monotonic() < deadline:
        remaining_ms = max(1, min(1000, int((deadline - time.monotonic()) * 1000)))
        k32.WaitNamedPipeW(path, remaining_ms)
        wait_error = ctypes.get_last_error()
        handle = k32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, None,
                                 OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None)
        if handle not in INVALID:
            return handle, 0
        error = ctypes.get_last_error()
        if error not in BUSY_ERRORS:
            return None, error
        time.sleep(0.05)
    return None, wait_error if 'wait_error' in locals() else ctypes.get_last_error()


def read_overlapped(handle, event, seconds: float) -> tuple[bytes, int]:
    buffer = ctypes.create_string_buffer(65536)
    got = wintypes.DWORD(0)
    overlapped = OVERLAPPED_IO()
    overlapped.hEvent = event
    ok = k32.ReadFile(handle, buffer, 65536, ctypes.byref(got), ctypes.byref(overlapped))
    if not ok:
        error = ctypes.get_last_error()
        if error != ERROR_IO_PENDING:
            return b"", error
        if k32.WaitForSingleObject(event, int(seconds * 1000)) != WAIT_OBJECT_0:
            k32.CancelIo(handle)
            return b"", 0
        if not k32.GetOverlappedResult(handle, ctypes.byref(overlapped), ctypes.byref(got), False):
            return b"", ctypes.get_last_error()
    return buffer.raw[: got.value], 0


def write_overlapped(handle, event, data: bytes) -> bool:
    payload = ctypes.create_string_buffer(data, len(data))
    written = wintypes.DWORD(0)
    overlapped = OVERLAPPED_IO()
    overlapped.hEvent = event
    ok = k32.WriteFile(handle, payload, len(data), ctypes.byref(written), ctypes.byref(overlapped))
    if not ok:
        error = ctypes.get_last_error()
        if error != ERROR_IO_PENDING:
            print("  write error=%d" % error, flush=True)
            return False
        if k32.WaitForSingleObject(event, 2000) != WAIT_OBJECT_0:
            k32.CancelIo(handle)
            return False
        if not k32.GetOverlappedResult(handle, ctypes.byref(overlapped), ctypes.byref(written), False):
            print("  write result error=%d" % ctypes.get_last_error(), flush=True)
            return False
    return True


def parse(buffer: bytes) -> tuple[list[tuple[int, bytes]], bytes]:
    frames = []
    while len(buffer) >= 8:
        length, kind = struct.unpack_from("<II", buffer, 0)
        if length > MAX_FRAME:
            break
        if len(buffer) < 8 + length:
            break
        frames.append((kind, buffer[8:8 + length]))
        buffer = buffer[8 + length:]
    return frames, buffer


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--seconds", type=float, default=60)
    args = parser.parse_args()

    path = pipe_path(args.pid)
    key = args.key.encode("utf-8")
    print("path:", path, flush=True)
    started = time.monotonic()
    handle, error = open_once(path, started + args.seconds)
    if handle is None:
        print("RESULT NEVER_OPENED error=%d after %.1fs" % (error, time.monotonic() - started), flush=True)
        return 2
    print("opened once after %.2fs; holding the handle" % (time.monotonic() - started), flush=True)

    event = k32.CreateEventW(None, True, False, None)
    buffer = b""
    nonce = None
    authenticated = False
    deadline = started + args.seconds
    last_error_report = None
    try:
        while time.monotonic() < deadline:
            chunk, error = read_overlapped(handle, event, 0.5)
            if error:
                if error != last_error_report:
                    print("  read error=%d (handle kept open)" % error, flush=True)
                    last_error_report = error
                time.sleep(0.1)
                continue
            if not chunk:
                continue
            buffer += chunk
            frames, buffer = parse(buffer)
            for kind, payload in frames:
                label = KIND.get(kind, "kind-%d" % kind)
                if kind == 1:
                    nonce = payload
                    print("CHALLENGE bytes=%d nonce=%s" % (len(payload), payload.hex()), flush=True)
                    response = proof(key, CLIENT_DOMAIN, nonce, args.pid)
                    write_overlapped(handle, event, frame(2, response))
                    print("AUTHENTICATE sent proof=%s" % response.hex(), flush=True)
                elif kind == 3:
                    authenticated = True
                    welcome_pid = struct.unpack_from("<I", payload, 0)[0] if len(payload) >= 4 else None
                    server_proof = payload[4:36] if len(payload) >= 36 else b""
                    expected = proof(key, SERVER_DOMAIN, nonce or b"", args.pid)
                    print("WELCOME pid=%s MATCH=%s" % (
                        welcome_pid, hmac.compare_digest(expected, server_proof)), flush=True)
                elif kind == 4:
                    if len(payload) == 48:
                        version, online, health = struct.unpack_from("<III", payload, 0)
                        hp, mana, cap = struct.unpack_from("<ddd", payload, 12)
                        target, seq, proto = struct.unpack_from("<III", payload, 36)
                        print("STATE %s" % json.dumps({"version": version, "online": bool(online),
                              "healthPercent": health, "hp": hp, "mana": mana, "cap": cap,
                              "targetId": target, "attackSeq": seq, "protoVersion": proto}), flush=True)
                    else:
                        print("STATE bytes=%d" % len(payload), flush=True)
                elif kind == 5:
                    try:
                        doc = json.loads(payload.decode("utf-8"))
                        summary = {k: doc.get(k) for k in (
                            "schema", "nativeVerified", "pulseVersion", "tick", "playerId",
                            "playerName", "pokemonName", "clientPid")}
                        summary["bytes"] = len(payload)
                        summary["creatures"] = len(doc.get("creatures") or [])
                        print("TELEMETRY %s" % json.dumps(summary, ensure_ascii=False), flush=True)
                    except (ValueError, UnicodeDecodeError):
                        print("TELEMETRY bytes=%d (not JSON)" % len(payload), flush=True)
                else:
                    print("FRAME %s bytes=%d" % (label, len(payload)), flush=True)
                if authenticated:
                    print("RESULT AUTHENTICATED", flush=True)
                    return 0
        print("RESULT NO_WELCOME authenticated=%s" % authenticated, flush=True)
        return 1
    finally:
        k32.CloseHandle(event)
        k32.CloseHandle(handle)


if __name__ == "__main__":
    raise SystemExit(main())
