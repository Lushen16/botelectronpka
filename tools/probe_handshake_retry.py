"""Robust live handshake probe with reconnect retries (read-write, no commands).

The runtime pipe can hand out an instance that is not yet connected by the
server, which surfaces as ERROR_PIPE_NOT_CONNECTED on the first read. A real
client reopens and retries. This tool does that, performs the HMAC-SHA256
handshake, and reports only the frames it actually received.

It sends the authenticate frame and nothing else: no game command is issued.

Usage:
  python tools/probe_handshake_retry.py --pid 23152 --key <key> --seconds 20
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
INVALID = (None, -1, 0xFFFFFFFFFFFFFFFF)
MAX_FRAME = 2105344
CLIENT_DOMAIN = b"PKA2/client\x00"
SERVER_DOMAIN = b"PKA2/server\x00"
KIND = {1: "challenge", 2: "authenticate", 3: "welcome", 4: "state", 5: "telemetry",
        6: "automation", 7: "startup", 8: "automation_revoked", 9: "manual",
        10: "ack", 11: "automation_control", 12: "automation_lease"}

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                            wintypes.HANDLE]
k32.ReadFile.restype = wintypes.BOOL
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k32.WriteFile.restype = wintypes.BOOL
k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                          ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
k32.PeekNamedPipe.restype = wintypes.BOOL
k32.PeekNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                              ctypes.POINTER(wintypes.DWORD),
                              ctypes.POINTER(wintypes.DWORD),
                              ctypes.POINTER(wintypes.DWORD)]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def pipe_path(name: str) -> str:
    return "\\\\" + "." + "\\" + "pipe" + "\\" + name


def frame(kind: int, payload: bytes = b"") -> bytes:
    return struct.pack("<II", len(payload), kind) + payload


def proof(key: bytes, domain: bytes, nonce: bytes, pid: int) -> bytes:
    return hmac.new(key, domain + nonce + struct.pack("<I", pid), hashlib.sha256).digest()


def try_read(handle, timeout: float) -> tuple[bytes, int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        avail = wintypes.DWORD(0)
        if not k32.PeekNamedPipe(handle, None, 0, None, ctypes.byref(avail), None):
            return b"", ctypes.get_last_error()
        if avail.value:
            chunk = ctypes.create_string_buffer(avail.value)
            got = wintypes.DWORD(0)
            if not k32.ReadFile(handle, chunk, avail.value, ctypes.byref(got), None):
                return b"", ctypes.get_last_error()
            return chunk.raw[: got.value], 0
        time.sleep(0.005)
    return b"", 0


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


def decode_state(payload: bytes) -> dict:
    if len(payload) != 48:
        return {"error": "state has %d bytes" % len(payload)}
    version, online, health = struct.unpack_from("<III", payload, 0)
    hp, mana, cap = struct.unpack_from("<ddd", payload, 12)
    target, seq, proto = struct.unpack_from("<III", payload, 36)
    return {"version": version, "online": bool(online), "healthPercent": health,
            "hp": hp, "mana": mana, "cap": cap, "targetId": target,
            "attackSeq": seq, "protoVersion": proto}


def attempt(name: str, key: bytes, pid: int, seconds: float) -> bool:
    path = pipe_path(name)
    handle = k32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, None,
                             OPEN_EXISTING, 0, None)
    if handle in INVALID:
        return False
    try:
        buffer = b""
        nonce = None
        authenticated = False
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            chunk, error = try_read(handle, min(0.5, max(0.01, deadline - time.monotonic())))
            if error:
                print("%s: read error=%d (reopening)" % (name, error))
                return False
            if not chunk:
                continue
            buffer += chunk
            frames, buffer = parse(buffer)
            for kind, payload in frames:
                label = KIND.get(kind, "kind-%d" % kind)
                if kind == 1:
                    nonce = payload
                    print("%s: CHALLENGE bytes=%d nonce=%s" % (name, len(payload), payload.hex()))
                    response = proof(key, CLIENT_DOMAIN, nonce, pid)
                    raw = frame(2, response)
                    written = wintypes.DWORD(0)
                    if not k32.WriteFile(handle, raw, len(raw), ctypes.byref(written), None):
                        print("%s: authenticate write failed err=%d" % (name, ctypes.get_last_error()))
                        return False
                    print("%s: AUTHENTICATE sent proof=%s" % (name, response.hex()))
                elif kind == 3:
                    authenticated = True
                    welcome_pid = struct.unpack_from("<I", payload, 0)[0] if len(payload) >= 4 else None
                    server_proof = payload[4:36] if len(payload) >= 36 else b""
                    expected = proof(key, SERVER_DOMAIN, nonce or b"", pid)
                    print("%s: WELCOME pid=%s MATCH=%s" % (
                        name, welcome_pid, hmac.compare_digest(expected, server_proof)))
                elif kind == 4:
                    print("%s: STATE %s" % (name, json.dumps(decode_state(payload))))
                elif kind == 5:
                    try:
                        doc = json.loads(payload.decode("utf-8"))
                        summary = {k: doc.get(k) for k in (
                            "schema", "nativeVerified", "tick", "playerId", "playerName",
                            "pokemonName", "healthPercent", "clientPid", "pulseVersion")}
                        summary["telemetryBytes"] = len(payload)
                        print("%s: TELEMETRY %s" % (name, json.dumps(summary, ensure_ascii=False)))
                    except (ValueError, UnicodeDecodeError):
                        print("%s: TELEMETRY bytes=%d (not JSON)" % (name, len(payload)))
                else:
                    print("%s: FRAME %s bytes=%d" % (name, label, len(payload)))
            if authenticated:
                print("%s: RESULT AUTHENTICATED" % name)
                return True
        print("%s: RESULT NO_WELCOME authenticated=%s" % (name, authenticated))
        return False
    finally:
        k32.CloseHandle(handle)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--seconds", type=float, default=15)
    parser.add_argument("--pipe", default="pka-runtime-2")
    args = parser.parse_args()

    key = args.key.encode("utf-8")
    name = "%s-%d" % (args.pipe, args.pid)
    deadline = time.monotonic() + args.seconds
    attempt_no = 0
    while time.monotonic() < deadline:
        attempt_no += 1
        remaining = max(0.5, deadline - time.monotonic())
        if attempt(name, key, args.pid, min(3.0, remaining)):
            return 0
        time.sleep(0.15)
    print("gave up after %d attempts" % attempt_no)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
