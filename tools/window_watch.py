import argparse
import ctypes
import json
import sys
from ctypes import wintypes

user32 = ctypes.WinDLL('user32', use_last_error=True)
k32 = ctypes.WinDLL('kernel32', use_last_error=True)

GWL_STYLE = -16
WS_MINIMIZE = 0x20000000
WS_VISIBLE = 0x10000000
WS_MAXIMIZE = 0x01000000
WS_CAPTION = 0x00C00000

CB = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def window_info(hwnd, expected_pid=None):
    """Descreve uma janela. Se expected_pid for dado, marca ownerMatches."""
    owner = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
    title = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, title, 512)
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    client = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(client))
    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
    info = {
        'hwnd': hex(hwnd),
        'ownerPid': owner.value,
        'title': title.value,
        'visible': bool(user32.IsWindowVisible(hwnd)),
        'iconic': bool(user32.IsIconic(hwnd)),
        'zoomed': bool(user32.IsZoomed(hwnd)),
        'wsMinimize': bool(style & WS_MINIMIZE),
        'wsVisible': bool(style & WS_VISIBLE),
        'wsMaximize': bool(style & WS_MAXIMIZE),
        'windowRect': {'l': rect.left, 't': rect.top,
                       'w': rect.right - rect.left, 'h': rect.bottom - rect.top},
        'clientRect': {'w': client.right, 'h': client.bottom},
    }
    if expected_pid is not None:
        info['ownerMatches'] = owner.value == expected_pid
    return info


def windows_of(pid):
    found = []

    def cb(hwnd, _lp):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid:
            found.append(window_info(hwnd, expected_pid=pid))
        return True

    user32.EnumWindows(CB(cb), 0)
    return found


def foreground_info(expected_pid=None):
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return {'hwnd': None, 'pid': None, 'title': None}
    return window_info(hwnd, expected_pid=expected_pid)


def process_identity(pid):
    h = k32.OpenProcess(0x1000, False, pid)
    if not h:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if not k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return None
        return buf.value
    finally:
        k32.CloseHandle(h)


def pick_game_window(pid):
    """Resolve a janela principal do processo, SEM hwnd fixo.

    Regras, nesta ordem:
      - pertence ao PID (GetWindowThreadProcessId == pid);
      - visivel e com area de cliente > 0;
      - tem WS_CAPTION (janela de topo real, nao IME/helper);
      - a maior por area de cliente entre as candidatas.

    Devolve a janela E a lista de rejeitadas, para o chamador poder registrar
    por que uma janela nao foi escolhida. Nunca devolve janela de outro PID.
    """
    all_windows = windows_of(pid)
    candidates = []
    rejected = []
    for w in all_windows:
        why = []
        if w['ownerPid'] != pid:
            why.append('ownerPid=' + str(w['ownerPid']))
        if not w['visible']:
            why.append('nao visivel')
        if w['clientRect']['w'] <= 0 or w['clientRect']['h'] <= 0:
            why.append('sem area de cliente')
        style = user32.GetWindowLongW(int(w['hwnd'], 16), GWL_STYLE)
        if not (style & WS_CAPTION):
            why.append('sem WS_CAPTION')
        if why:
            rejected.append({'hwnd': w['hwnd'], 'title': w['title'], 'why': why})
        else:
            candidates.append(w)
    if not candidates:
        return {'ok': False, 'error': 'nenhuma janela elegivel para o PID',
                'pid': pid, 'windows': all_windows, 'rejected': rejected}
    candidates.sort(key=lambda w: w['clientRect']['w'] * w['clientRect']['h'],
                    reverse=True)
    return {'ok': True, 'pid': pid, 'window': candidates[0],
            'candidates': len(candidates), 'rejected': rejected,
            'allWindows': all_windows}


def cmd_window(args):
    path = process_identity(args.pid)
    if path is None:
        return {'ok': False, 'error': 'processo inexistente', 'pid': args.pid}
    picked = pick_game_window(args.pid)
    if not picked['ok']:
        return picked
    fg = foreground_info(expected_pid=args.pid)
    win = picked['window']
    return {
        'ok': True,
        'pid': args.pid,
        'exe': path,
        'window': win,
        'foreground': fg,
        'gameIsForeground': fg.get('hwnd') == win['hwnd'],
        'foregroundIsOurPid': fg.get('ownerPid') == args.pid,
        'candidates': picked['candidates'],
        'rejected': picked['rejected'],
    }


def cmd_watch(args):
    path = process_identity(args.pid)
    if path is None:
        return {'ok': False, 'error': 'processo inexistente'}
    samples = []
    transitions = []
    prev = None
    started = time.monotonic()
    while time.monotonic() - started < args.seconds:
        picked = pick_game_window(args.pid)
        if not picked['ok']:
            samples.append({'at': round(time.time(), 3), 'error': picked['error']})
            time.sleep(args.interval / 1000.0)
            continue
        win = picked['window']
        fg = foreground_info(expected_pid=args.pid)
        snap = {
            'at': round(time.time(), 3),
            'elapsed': round(time.monotonic() - started, 3),
            'hwnd': win['hwnd'],
            'ownerPid': win['ownerPid'],
            'title': win['title'],
            'visible': win['visible'],
            'iconic': win['iconic'],
            'zoomed': win['zoomed'],
            'windowRect': win['windowRect'],
            'foreground': fg,
            'gameIsForeground': fg.get('hwnd') == win['hwnd'],
        }
        samples.append(snap)
        if prev is not None:
            changes = {}
            for key in ('hwnd', 'iconic', 'zoomed', 'visible', 'windowRect',
                        'gameIsForeground', 'title'):
                if snap.get(key) != prev.get(key):
                    changes[key] = [prev.get(key), snap.get(key)]
            if snap['foreground'].get('hwnd') != prev['foreground'].get('hwnd'):
                changes['foregroundHwnd'] = [prev['foreground'].get('hwnd'),
                                             snap['foreground'].get('hwnd')]
            if snap['foreground'].get('pid') != prev['foreground'].get('pid'):
                changes['foregroundPid'] = [prev['foreground'].get('pid'),
                                            snap['foreground'].get('pid')]
            if changes:
                transitions.append({'at': snap['at'], 'elapsed': snap['elapsed'],
                                    'changes': changes})
        prev = snap
        time.sleep(args.interval / 1000.0)

    valid = [s for s in samples if 'hwnd' in s]
    hwnds = sorted({s['hwnd'] for s in valid})
    return {
        'ok': True,
        'pid': args.pid,
        'exe': path,
        'sampleCount': len(samples),
        'seconds': args.seconds,
        'hwndsObserved': hwnds,
        'singleWindow': len(hwnds) == 1,
        'everIconic': any(s.get('iconic') for s in valid),
        'everForeground': any(s.get('gameIsForeground') for s in valid),
        'transitionCount': len(transitions),
        'transitions': transitions,
        'first': samples[0] if samples else None,
        'last': samples[-1] if samples else None,
        'samples': samples,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pid', type=int, required=True)
    ap.add_argument('--seconds', type=float, default=0.0)
    ap.add_argument('--interval', type=int, default=200)
    args = ap.parse_args()
    if args.seconds and args.seconds > 0:
        result = cmd_watch(args)
    else:
        result = cmd_window(args)
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + '\n')
    return 0 if result.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
