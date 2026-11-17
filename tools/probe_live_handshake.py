"""Probe the live PKA runtime pipe handshake (read-write, single frame set).

Connects to \\\\.\\pipe\\pka-runtime-2-<pid>, receives the challenge nonce, sends
the HMAC-SHA256 client proof and reports whether the native runtime accepts it.
Only the handshake plus the initial state/telemetry frames are read; no command
is sent, so no game action is triggered.

Usage:
  python tools/probe_live_handshake.py --pid 27700 --key cf53...
  python tools/probe_live_handshake.py --pid 27700 --hex-key cf53...
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import hmac
import json
import struct
import sys
import time
from ctypes import wintypes

GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
OPEN_EXISTING = 3
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
ERROR_PIPE_BUSY = 231
ERROR_FILE_NOT_FOUND = 2
MAX_FRAME = 2105344
CLIENT_DOMAIN = b"PKA2/client\x00"
SERVER_DOMAIN = b"PKA2/server\x00"

KIND = {1: "challenge", 2: "authenticate", 3: "welcome", 4: "state", 5: "telemetry",
        6: "automation", 7: "startup", 8: "automation_revoked", 9: "manual",
        10: "ack", 11: "automation_control", 12: "automation_lease"}

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
CreateFileW = kernel32.CreateFileW
CreateFileW.restype = wintypes.HANDLE
CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
ReadFile = kernel32.ReadFile
ReadFile.restype = wintypes.BOOL
ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                     ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
WriteFile = kernel32.WriteFile
WriteFile.restype = wintypes.BOOL
WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD,
                      ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
PeekNamedPipe = kernel32.PeekNamedPipe
PeekNamedPipe.restype = wintypes.BOOL
PeekNamedPipe.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                          wintypes.LPDWORD, wintypes.LPDWORD, wintypes.LPDWORD]
CloseHandle = kernel32.CloseHandle
CloseHandle.restype = wintypes.BOOL
CloseHandle.argtypes = [wintypes.HANDLE]


def frame(kind: int, payload: bytes = b"") -> bytes:
    return struct.pack("<II", len(payload), kind) + payload


def proof(key: bytes, domain: bytes, nonce: bytes, pid: int) -> bytes:
    return hmac.new(key, domain + nonce + struct.pack("<I", pid), hashlib.sha256).digest()


def read_avail(handle, timeout: float) -> bytes:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        avail = wintypes.DWORD(0)
        if PeekNamedPipe(handle, None, 0, None, ctypes.byref(avail), None):
            if avail.value:
                chunk = ctypes.create_string_buffer(avail.value)
                got = wintypes.DWORD(0)
                if not ReadFile(handle, chunk, avail.value, ctypes.byref(got), None):
                    raise OSError("ReadFile failed: %d" % ctypes.get_last_error())
                return chunk.raw[: got.value]
        time.sleep(0.01)
    return b""


def parse_frames(buffer: bytes):
    frames = []
    while len(buffer) >= 8:
        length, kind = struct.unpack_from("<II", buffer, 0)
        if length > MAX_FRAME:
            raise ValueError("frame length %d exceeds MAX_FRAME" % length)
        if len(buffer) < 8 + length:
            break
        frames.append((kind, buffer[8:8 + length]))
        buffer = buffer[8 + length:]
    return frames, buffer


def decode_state(payload: bytes) -> dict:
    if len(payload) != 48:
        return {"error": "state payload is %d bytes, expected 48" % len(payload)}
    version, online, health = struct.unpack_from("<III", payload, 0)
    hp, mana, cap = struct.unpack_from("<ddd", payload, 12)
    target, seq, proto = struct.unpack_from("<III", payload, 36)
    return {"version": version, "online": bool(online), "healthPercent": health,
            "hp": hp, "mana": mana, "cap": cap, "targetId": target,
            "attackSeq": seq, "protoVersion": proto}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--key", help="channel key as UTF-8 text")
    parser.add_argument("--hex-key", help="channel key as hex bytes")
    parser.add_argument("--timeout", type=float, default=4.0)
    args = parser.parse_args()

    if args.hex_key:
        key = bytes.fromhex(args.hex_key)
        key_label = "hex"
    elif args.key:
        key = args.key.encode("utf-8")
        key_label = "utf-8"
    else:
        raise SystemExit("provide --key or --hex-key")

    path = "\\\\.\\pipe\\pka-runtime-2-%d" % args.pid
    handle = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, None, OPEN_EXISTING, 0, None)
    if handle == INVALID_HANDLE_VALUE or handle is None:
        error = ctypes.get_last_error()
        print("OPEN_FAILED error=%d %s" % (error, "ERROR_PIPE_BUSY" if error == ERROR_PIPE_BUSY else ""))
        return 2

    try:
        buffer = b""
        challenge = None
        authenticated = False
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            buffer += read_avail(handle, 0.25)
            frames, buffer = parse_frames(buffer)
            for kind, payload in frames:
                name = KIND.get(kind, "kind-%d" % kind)
                if kind == 1:
                    challenge = payload
                    print("CHALLENGE bytes=%d nonce=%s" % (len(payload), payload.hex()))
                    client_proof = proof(key, CLIENT_DOMAIN, challenge, args.pid)
                    raw = frame(2, client_proof)
                    written = wintypes.DWORD(0)
                    if not WriteFile(handle, raw, len(raw), ctypes.byref(written), None):
                        print("AUTH_WRITE_FAILED error=%d" % ctypes.get_last_error())
                        return 3
                    print("AUTH_SENT key=%s proof=%s" % (key_label, client_proof.hex()))
                elif kind == 3:
                    authenticated = True
                    pid = struct.unpack_from("<I", payload, 0)[0] if len(payload) >= 4 else None
                    server_proof = payload[4:36] if len(payload) >= 36 else b""
                    expected = proof(key, SERVER_DOMAIN, challenge or b"", args.pid)
                    print("WELCOME pid=%s server_proof=%s MATCH=%s" % (
                        pid, server_proof.hex(), hmac.compare_digest(expected, server_proof)))
                elif kind == 4:
                    print("STATE %s" % json.dumps(decode_state(payload)))
                elif kind == 5:
                    try:
                        doc = json.loads(payload.decode("utf-8"))
                        summary = {k: doc.get(k) for k in ("schema", "nativeVerified", "tick",
                                   "playerId", "pokemonName", "healthPercent", "clientPid")}
                        summary["telemetryBytes"] = len(payload)
                        print("TELEMETRY %s" % json.dumps(summary, ensure_ascii=False))
                    except (ValueError, UnicodeDecodeError):
                        print("TELEMETRY bytes=%d (non-JSON)" % len(payload))
                else:
                    print("FRAME %s bytes=%d" % (name, len(payload)))
            if authenticated:
                print("RESULT AUTHENTICATED key=%s" % key_label)
                return 0
        print("RESULT NO_WELCOME (authenticated=%s)" % authenticated)
        return 1
    finally:
        CloseHandle(handle)


if __name__ == "__main__":
    sys.exit(main())
