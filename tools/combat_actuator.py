"""PID-bound background combat messages. Success means queued, not applied.

Single-shot mode keeps the historical CLI contract:
    python tools/combat_actuator.py <pid> --request <json>

Resident mode keeps the interpreter, the Win32 bindings, the process validation
and the client HWND warm, so a command costs only its own Win32 dispatch:
    python tools/combat_actuator.py --serve
    -> one JSON command per stdin line, one JSON result per stdout line.
"""

import argparse
import ctypes
import json
import hashlib
import os
from pathlib import Path
import sys
import time
from ctypes import wintypes
from creature_identity import TargetMovedError
from walker_input import (configure_user, validate_process, find_window, window_details, key_messages,
                          send_tap, bind_desktop)

# Errors that mean the cached HWND/process view is stale and can be re-resolved
# once without risking a duplicated input event.
STALE_WINDOW_MARKERS = ('HWND/PID', 'Titulo da janela', 'Janela mudou', 'Dimensoes do cliente',
                        'Falha ao enumerar', 'Processo do cliente indisponivel')


def key_code(key):
    normalized = key.strip().lower()
    if normalized.startswith('f') and normalized[1:].isdigit() and 1 <= int(normalized[1:]) <= 12:
        return 0x6F + int(normalized[1:])
    if len(normalized) == 1 and normalized.isascii() and normalized.isalnum():
        return ord(normalized.upper())
    arrows = {'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27}
    if normalized in arrows:
        return arrows[normalized]
    return {'space': 0x20, 'escape': 0x1B, 'tab': 9}.get(normalized)


def dispatch(user, kernel, pid, hwnd, request, result):
    title, width, height = window_details(user, hwnd, pid)
    player_name = request.get('playerName')
    # O launcher oficial renomeia a janela para "PokeAlliance - <nome>". Um cliente
    # aberto direto mantem o titulo curto "PokeAlliance". Ambos sao aceitos; um
    # titulo com outro nome continua rejeitado.
    if player_name is not None:
        if not isinstance(player_name, str) or not player_name.strip():
            raise ValueError('Titulo da janela diverge do jogador esperado.')
        expected_title = 'PokeAlliance - ' + player_name
        if title not in (expected_title, 'PokeAlliance'):
            raise ValueError('Titulo da janela diverge do jogador esperado.')
    result.update(hwnd=hex(hwnd), title=title, width=width, height=height,
                  foreground=user.GetForegroundWindow() == hwnd)

    def validate_window():
        if window_details(user, hwnd, pid) != (title, width, height):
            raise ValueError('Janela mudou antes do envio.')

    kind = request.get('kind', 'key')
    result['kind'] = kind
    if kind == 'probe':
        result['success'] = True
        return result
    if kind not in ('key', 'attack', 'click', 'useWith'):
        raise ValueError(f'Tipo desconhecido: {kind}')
    if kind in ('attack', 'click', 'useWith'):
        x, y = request.get('x'), request.get('y')
        expected_width, expected_height = request.get('width'), request.get('height')
        if ((expected_width is not None and expected_width != width)
                or (expected_height is not None and expected_height != height)):
            raise ValueError('Janela redimensionada; recalibre o viewport antes de atacar.')
        if type(x) is not int or type(y) is not int or not (0 <= x < width and 0 <= y < height):
            raise ValueError('Coordenadas invalidas para o viewport.')
        lparam = (y << 16) | x
        click_messages = ([(0x0204, 2, lparam), (0x0205, 0, lparam)] if kind == 'attack'
                          else [(0x0201, 1, lparam), (0x0202, 0, lparam)])
        result.update(x=x, y=y)
    if kind in ('key', 'useWith'):
        key = request.get('key')
        vk = key_code(key) if isinstance(key, str) else None
        if vk is None or (kind == 'useWith' and not (0x70 <= vk <= 0x7B or key.strip().isascii()
                                                   and len(key.strip()) == 1 and key.strip().isalnum())):
            raise ValueError(f'Tecla invalida: {key}')
        messages = key_messages(vk, user.MapVirtualKeyW(vk, 0), vk in (0x25, 0x26, 0x27, 0x28))
        result['key'] = key
    if kind == 'useWith' and (not player_name or request.get('width') is None or request.get('height') is None
                              or not isinstance(request.get('itemGuard'), dict)):
        raise ValueError('useWith exige playerName, dimensoes e itemGuard.')
    if kind == 'useWith' and (type(request.get('itemId')) is not int or not 1 <= request['itemId'] <= 65535
                              or type(request.get('targetId')) is not int
                              or request['targetId'] != request['itemGuard'].get('item', {}).get('id')):
        raise ValueError('IDs useWith invalidos ou divergentes do corpo observado.')

    def validate_ball():
        guard = request.get('ballGuard')
        if (not isinstance(guard, dict) or guard.get('itemId') != request.get('itemId')
                or guard.get('key') != request.get('key') or guard.get('mode') != 'useWith'
                or guard.get('source') != 'live-confirmation'):
            raise ValueError('Bola/hotkey sem associacao confirmada.')
        filename = Path(guard['configFile'])
        if not filename.is_file() or filename.stat().st_size > 4 * 1024 * 1024:
            raise ValueError('Configuracao da bola indisponivel.')
        if hashlib.sha256(filename.read_bytes()).hexdigest() != guard.get('configSha256'):
            raise ValueError('Configuracao da bola mudou antes do envio.')

    def validate_target():
        validate_window()
        target_guard = request.get('targetGuard')
        own_guard = request.get('ownGuard')
        if own_guard is not None and kind != 'key':
            raise ValueError('ownGuard somente para hotkey de cura.')
        if target_guard is not None or own_guard is not None:
            from creature_identity import validate_guard
            memory = kernel.OpenProcess(0x0410, False, pid)
            if not memory:
                raise ValueError('Leitura de memoria indisponivel para targetGuard.')
            try:
                def read(address, size):
                    buffer = ctypes.create_string_buffer(size)
                    count = ctypes.c_size_t()
                    if not kernel.ReadProcessMemory(memory, address, buffer, size, ctypes.byref(count)):
                        return None
                    return buffer.raw[:count.value]
                result['identityGuard'] = validate_guard(target_guard if target_guard is not None else own_guard, pid,
                    read, {'typeOffset': 0x186}, positional=kind != 'key', require_target=target_guard is not None)
            finally:
                kernel.CloseHandle(memory)
        validate_window()

    result['startedAtMs'] = time.time_ns() // 1000000
    if kind == 'useWith':
        from item_identity import validate_capture_guard
        guard = request['itemGuard']
        if type(guard.get('pid')) is not int or guard['pid'] != pid:
            raise ValueError('itemGuard de outro PID ou ausente.')
        memory = kernel.OpenProcess(0x0410, False, pid)
        if not memory:
            raise ValueError('Leitura de memoria indisponivel para itemGuard.')
        try:
            def validate_item():
                validate_window()
                validate_ball()
                validate_capture_guard(memory, guard, time.time_ns() // 1000000)
                validate_window()
            send_tap(user, hwnd, messages, result, validate=validate_item)
            result.pop('queuedAtMs', None)
            time.sleep(0.08)
            send_tap(user, hwnd, click_messages, result, pointer=(0x0200, 0, lparam), validate=validate_item)
        finally:
            kernel.CloseHandle(memory)
    elif kind == 'key':
        send_tap(user, hwnd, messages, result, validate=validate_target)
    else:
        send_tap(user, hwnd, click_messages, result, pointer=(0x0200, 0, lparam), validate=validate_target)
    result['success'] = True
    return result


def new_result(pid):
    return {'success': False, 'pid': pid, 'eventsSent': 0, 'pointerEventsSent': 0,
            'transport': 'PostMessageW', 'effectVerified': False, 'retrySafe': False}


def annotate_failure(result, error):
    result.update(success=False, error=str(error),
                  uncertain=result['eventsSent'] > 0 or result['pointerEventsSent'] > 0)
    if (isinstance(error, TargetMovedError) or isinstance(error.__cause__, TargetMovedError)) \
            and result['eventsSent'] == 0 and result['pointerEventsSent'] == 0:
        result['errorCode'] = 'COMBAT_TARGET_MOVED'
    return result


class Session:
    """Resident dispatch context: Win32 bindings, PID validation and HWND stay warm."""

    def __init__(self):
        self.user = None
        self.kernel = None
        self.callback_type = None
        self.windows = {}
        self.commands = 0
        self.reusedWindows = 0
        self.window_station = None
        self.desktop_handle = None

    def bind(self):
        """Loads user32/kernel32 once and joins the interactive WinSta0\\Default."""
        if self.user is None:
            self.user = ctypes.WinDLL('user32', use_last_error=True)
            self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            self.callback_type = configure_user(self.user)
        self.window_station, self.desktop_handle = bind_desktop(self.user)
        return self.window_station, self.desktop_handle

    def _bind(self, pid):
        hwnd = self.windows.get(pid)
        if hwnd is not None:
            self.reusedWindows += 1
            return self.user, self.kernel, hwnd
        self.bind()
        validate_process(self.kernel, pid)
        hwnd = find_window(self.user, pid, self.callback_type)
        self.windows[pid] = hwnd
        return self.user, self.kernel, hwnd

    def _is_stale(self, error):
        message = str(error)
        return any(marker in message for marker in STALE_WINDOW_MARKERS)

    def dispatch(self, pid, request):
        self.commands += 1
        result = new_result(pid)
        cached = pid in self.windows
        try:
            if pid <= 0 or os.name != 'nt':
                raise ValueError('Windows e PID positivo sao obrigatorios.')
            user, kernel, hwnd = self._bind(pid)
            dispatch(user, kernel, pid, hwnd, request, result)
            return result
        except Exception as error:
            self.windows.pop(pid, None)
            # A stale cached window can be re-resolved once; only if no message
            # was queued, so a retry can never duplicate an input event.
            if cached and self._is_stale(error) and result['eventsSent'] == 0 \
                    and result['pointerEventsSent'] == 0:
                retry = new_result(pid)
                try:
                    user, kernel, hwnd = self._bind(pid)
                    dispatch(user, kernel, pid, hwnd, request, retry)
                    return retry
                except Exception as again:
                    self.windows.pop(pid, None)
                    return annotate_failure(retry, again)
            return annotate_failure(result, error)


def respond(stream, payload):
    stream.write(json.dumps(payload, ensure_ascii=False) + '\n')
    stream.flush()


def serve(stream_in=None, stream_out=None):
    """Line-delimited JSON command loop; never exits on a single bad command."""
    source = stream_in if stream_in is not None else sys.stdin
    sink = stream_out if stream_out is not None else sys.stdout
    session = Session()
    if os.name == 'nt':
        # Binding once at startup keeps WinSta0\Default and the DLL loads off
        # the first command; a failure here is retried by the first _bind().
        try:
            session.bind()
        except Exception:
            pass
    try:
        for line in iter(source.readline, ''):
            line = line.lstrip('\ufeff')
            if not line.strip():
                continue
            identifier = None
            try:
                command = json.loads(line)
                if not isinstance(command, dict):
                    raise ValueError('Comando do canal persistente deve ser objeto JSON.')
                identifier = command.get('id')
                if command.get('op') == 'ping' or command.get('kind') == 'ping':
                    respond(sink, {'id': identifier, 'success': True, 'pid': 0, 'eventsSent': 0,
                                   'pointerEventsSent': 0, 'transport': 'PostMessageW',
                                   'effectVerified': False, 'worker': 'combat_actuator',
                                   'cachedPids': len(session.windows), 'commands': session.commands,
                                   'reusedWindows': session.reusedWindows,
                                   'desktopBound': bool(session.desktop_handle)})
                    continue
                pid = command.get('pid')
                if type(pid) is not int:
                    raise ValueError('PID ausente no comando do canal persistente.')
                request = command.get('request')
                if isinstance(request, str):
                    request = json.loads(request)
                if request is None:
                    request = {'kind': 'key', 'key': command.get('key')}
                if not isinstance(request, dict):
                    raise ValueError('Request deve ser objeto JSON.')
                result = session.dispatch(pid, request)
            except Exception as error:
                result = annotate_failure(new_result(identifier if type(identifier) is int else 0), error)
            result['id'] = identifier
            respond(sink, result)
    except KeyboardInterrupt:
        return 130
    except OSError:
        # O chamador fechou o canal; encerra sem poluir o stderr.
        return 0
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pid', type=int, nargs='?')
    parser.add_argument('key', nargs='?')
    parser.add_argument('--request')
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--serve', action='store_true',
                        help='mantem o processo residente trocando comandos JSON por linha')
    args = parser.parse_args()
    if args.serve:
        return serve()
    if args.pid is None:
        parser.error('PID obrigatorio fora do modo --serve.')
    result = new_result(args.pid)
    try:
        if args.pid <= 0 or os.name != 'nt':
            raise ValueError('Windows e PID positivo sao obrigatorios.')
        user = ctypes.WinDLL('user32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        callback_type = configure_user(user)
        validate_process(kernel, args.pid)
        hwnd = find_window(user, args.pid, callback_type)
        request = ({'kind': 'probe'} if args.probe else json.loads(args.request) if args.request
                   else {'kind': 'key', 'key': args.key})
        if not isinstance(request, dict):
            raise ValueError('Request deve ser objeto JSON.')
        dispatch(user, kernel, args.pid, hwnd, request, result)
    except Exception as error:
        annotate_failure(result, error)
    return result


if __name__ == '__main__':
    outcome = main()
    if isinstance(outcome, int):
        raise SystemExit(outcome)
    print(json.dumps(outcome))
    raise SystemExit(0 if outcome['success'] else 1)
