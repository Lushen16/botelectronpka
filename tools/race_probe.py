"""Race the runtime pipe the moment it appears, and complete the handshake.

Why this exists: the runtime pipe is maxInstances=1 and the Electron menu grabs
it at startup. Once the menu is gone, the observed instance returns
ERROR_PIPE_NOT_CONNECTED (233) forever and the module's worker threads sit at
0 CPU: the runtime does not re-arm. That means the only way to own the channel
is to connect before / instead of the menu.

This tool polls CreateFileW in a tight loop until it wins the instance, then does
the HMAC handshake and holds the connection. It sends only the authenticate
frame; it never issues a game command.

Usage:
  python tools/race_probe.py --pid 26596 --key <key> --seconds 300
  python tools/race_probe.py --key <key> --wait-game       # finds the pid itself
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import hmac
import json
import os
import re
import struct
import subprocess
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
ERROR_IO_PENDING = 997
ERROR_PIPE_BUSY = 231
ERROR_PIPE_NOT_CONNECTED = 233
ERROR_SEM_TIMEOUT = 121
BUSY = (ERROR_PIPE_BUSY, ERROR_SEM_TIMEOUT)
WAIT_OBJECT_0 = 0

k32 = ctypes.WinDLL("kernel32", use_last_error=True)


class OV(ctypes.Structure):
    _fields_ = [("Internal", ctypes.c_size_t), ("InternalHigh", ctypes.c_size_t),
                ("Offset", wintypes.DWORD), ("OffsetHigh", wintypes.DWORD),
                ("hEvent", wintypes.HANDLE)]


k32.CreateFileW.restype = wintypes.HANDLE
k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(OV)]
k32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD,
                          ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(OV)]
k32.GetOverlappedResult.argtypes = [wintypes.HANDLE, ctypes.POINTER(OV),
                                    ctypes.POINTER(wintypes.DWORD), wintypes.BOOL]
k32.CreateEventW.restype = wintypes.HANDLE
k32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, wintypes.LPCWSTR]
k32.CloseHandle.argtypes = [wintypes.HANDLE]


def pipe_path(pid: int) -> str:
    return "\\\\" + "." + "\\" + "pipe" + "\\" + ("pka-runtime-2-%d" % pid)


def frame(kind: int, payload: bytes = b"") -> bytes:
    return struct.pack("<II", len(payload), kind) + payload


def proof(key: bytes, domain: bytes, nonce: bytes, pid: int) -> bytes:
    return hmac.new(key, domain + nonce + struct.pack("<I", pid), hashlib.sha256).digest()


def find_pid() -> int | None:
    script = ("Get-CimInstance Win32_Process -Filter \"Name='PokeAlliance_dx.exe'\" | "
              "Select-Object -ExpandProperty ProcessId")
    result = subprocess.run(["powershell", "-NoProfile", "-Command", script],
                            capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        line = line.strip()
        if line.isdigit():
            return int(line)
    return None


def try_open(pid: int) -> tuple[int | None, int]:
    handle = k32.CreateFileW(pipe_path(pid), GENERIC_READ | GENERIC_WRITE, 0, None,
                             OPEN_EXISTING, FILE_FLAG_OVERLAPPED, None)
    if handle not in INVALID:
        return handle, 0
    return None, ctypes.get_last_error()


def read_once(handle, event, seconds: float) -> tuple[bytes, int]:
    buffer = ctypes.create_string_buffer(65536)
    got = wintypes.DWORD(0)
    overlapped = OV()
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


def write_all(handle, event, data: bytes) -> bool:
    payload = ctypes.create_string_buffer(data, len(data))
    written = wintypes.DWORD(0)
    overlapped = OV()
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


def load_key_file(path: str, pid: int) -> bytes | None:
    """Reads the key JSON written by find_channel_key.py, if it matches this pid."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            record = json.load(fh)
    except (OSError, ValueError):
        return None
    if record.get("pid") != pid:
        return None
    value = record.get("key")
    if not isinstance(value, str) or not value:
        return None
    return value.encode("utf-8")


def run(pid: int, key: bytes | None, deadline: float, key_file: str | None) -> int:
    print("pid=%d path=%s" % (pid, pipe_path(pid)), flush=True)
    handle = None
    attempts = 0
    last_busy = None
    while time.monotonic() < deadline and handle is None:
        attempts += 1
        candidate, error = try_open(pid)
        if candidate is not None:
            handle = candidate
            print("WON the instance after %d attempts" % attempts, flush=True)
            break
        if error != last_busy:
            print("  busy error=%d (attempt %d)" % (error, attempts), flush=True)
            last_busy = error
        time.sleep(0.005)
    if handle is None:
        print("RESULT NEVER_WON attempts=%d" % attempts, flush=True)
        return 2

    event = k32.CreateEventW(None, True, False, None)
    buffer = b""
    nonce = None
    saw_challenge = False
    deadline = time.monotonic() + 120
    waiting_key_logged = False
    try:
        while time.monotonic() < deadline:
            # Sem chave ainda: tenta carregar do arquivo a cada volta, sem
            # fechar o handle. A posse da instancia e o que precisamos manter.
            if key is None and key_file:
                loaded = load_key_file(key_file, pid)
                if loaded:
                    key = loaded
                    print("KEY loaded from %s" % key_file, flush=True)
                    if nonce is not None:
                        response = proof(key, CLIENT_DOMAIN, nonce, pid)
                        write_all(handle, event, frame(2, response))
                        print("AUTHENTICATE sent (late key) proof=%s" % response.hex(), flush=True)
                elif not waiting_key_logged:
                    print("holding handle; waiting for %s (pid %d)" % (key_file, pid), flush=True)
                    waiting_key_logged = True

            chunk, error = read_once(handle, event, 0.5)
            if error == ERROR_PIPE_NOT_CONNECTED and not saw_challenge:
                # O servidor ja tinha desconectado esta instancia antes de nos
                # ligarmos: nada a fazer aqui. Codigo 3 = instancia condenada,
                # para o chamador descartar este pid e esperar nova injecao.
                print("  instance already orphaned (233); pidy is dead", flush=True)
                return 3
            if error:
                print("  read error=%d" % error, flush=True)
                return 3
            if not chunk:
                continue
            buffer += chunk
            frames, buffer = parse(buffer)
            for kind, payload in frames:
                label = KIND.get(kind, "kind-%d" % kind)
                if kind == 1:
                    nonce = payload
                    saw_challenge = True
                    print("CHALLENGE bytes=%d nonce=%s" % (len(payload), payload.hex()), flush=True)
                    if key is None:
                        if not key_file:
                            print("RESULT CHALLENGE_WITHOUT_KEY", flush=True)
                            return 4
                        print("  challenge received; key not available yet, will answer when it is",
                              flush=True)
                        continue
                    response = proof(key, CLIENT_DOMAIN, nonce, pid)
                    write_all(handle, event, frame(2, response))
                    print("AUTHENTICATE sent proof=%s" % response.hex(), flush=True)
                elif kind == 3:
                    welcome_pid = struct.unpack_from("<I", payload, 0)[0] if len(payload) >= 4 else None
                    server_proof = payload[4:36] if len(payload) >= 36 else b""
                    expected = proof(key, SERVER_DOMAIN, nonce or b"", pid)
                    print("WELCOME pid=%s MATCH=%s" % (
                        welcome_pid, hmac.compare_digest(expected, server_proof)), flush=True)
                    print("RESULT AUTHENTICATED", flush=True)
                    return 0
                elif kind == 4 and len(payload) == 48:
                    version, online, health = struct.unpack_from("<III", payload, 0)
                    print("STATE online=%s health=%d version=%d" % (bool(online), health, version), flush=True)
                elif kind == 5:
                    try:
                        doc = json.loads(payload.decode("utf-8"))
                        print("TELEMETRY tick=%s player=%s creatures=%d" % (
                            doc.get("tick"), doc.get("playerName"),
                            len(doc.get("creatures") or [])), flush=True)
                    except (ValueError, UnicodeDecodeError):
                        print("TELEMETRY bytes=%d" % len(payload), flush=True)
                else:
                    print("FRAME %s bytes=%d" % (label, len(payload)), flush=True)
        print("RESULT NO_WELCOME", flush=True)
        return 1
    finally:
        k32.CloseHandle(event)
        k32.CloseHandle(handle)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int)
    parser.add_argument("--key", help="chave HMAC (texto)")
    parser.add_argument("--key-file", help="JSON de find_channel_key.py; lido durante a espera")
    parser.add_argument("--key-later", action="store_true",
                        help="nao exige --key agora: espera o arquivo --key-file aparecer")
    parser.add_argument("--seconds", type=float, default=300)
    args = parser.parse_args()

    key_file = args.key_file
    key = args.key.encode("utf-8") if args.key else None
    if key is None and not (args.key_later and key_file):
        parser.error("informe --key, ou --key-later com --key-file")

    deadline = time.monotonic() + args.seconds
    pid = args.pid
    orphan_attempts = 0
    while time.monotonic() < deadline:
        if not pid:
            pid = find_pid()
            if not pid:
                pid = None
                time.sleep(0.3)
                continue
            print("game pid=%d" % pid, flush=True)
        code = run(pid, key, deadline, key_file)
        if code == 0:
            return 0
        key = args.key.encode("utf-8") if args.key else None
        if code == 2:
            # Nao ganhou a instancia: outro cliente (o menu) a mantem.
            # O dono pode sair a qualquer momento, entao insiste no mesmo PID.
            print("still busy on pid %d; retrying" % pid, flush=True)
            time.sleep(0.2)
            continue
        if code == 3:
            # Ganhamos, mas o servidor ja havia desconectado: instancia morta.
            # A reinjecao recria o pipe com o MESMO pid do jogo, entao nao se
            # descarta o pid — espera um pouco e tenta de novo ate o deadline.
            orphan_attempts += 1
            if orphan_attempts == 1 or orphan_attempts % 20 == 0:
                print("orphan hit #%d on pid %d; aguardando reinjecao (pipe sera recriado)"
                      % (orphan_attempts, pid), flush=True)
            time.sleep(0.5)
            continue
        return code
    print("RESULT TIMEOUT", flush=True)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
