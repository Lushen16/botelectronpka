"""Microbenchmark do dispatch do atuador com Win32 simulado.

Mede o que sobra depois que o processo, as bindings Win32 e o HWND ja estao
quentes: tempo ate a primeira PostMessageW e custo total do comando sem a
pausa de pressao (que e uma emulacao intencional, nao overhead).
"""

import json
import statistics
import sys
import time
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import walker_input as walker  # noqa: E402
import combat_actuator as combat  # noqa: E402


def build_user():
    user = Mock()
    walker.configure_user(user)

    def owner(hwnd, pointer):
        pointer._obj.value = 42
        return 1

    def title(hwnd, buffer, size):
        buffer.value = 'PokeAlliance - Ash'
        return len(buffer.value)

    def rect(hwnd, pointer):
        pointer._obj.right, pointer._obj.bottom = 800, 600
        return 1

    user.GetWindowThreadProcessId.side_effect = owner
    user.GetWindowTextW.side_effect = title
    user.GetClientRect.side_effect = rect
    user.MapVirtualKeyW.return_value = 0x3B
    user.GetForegroundWindow.return_value = 77
    return user


def stats(samples):
    ordered = sorted(samples)
    return {
        'mean': round(statistics.fmean(samples), 3),
        'p50': round(ordered[len(ordered) // 2], 3),
        'p99': round(ordered[min(len(ordered) - 1, int(len(ordered) * 0.99))], 3),
        'min': round(ordered[0], 3),
        'max': round(ordered[-1], 3),
    }


def measure(user, kernel, request, iterations):
    first = []
    total = []
    messages = [0]
    first_at = []

    def post(hwnd, message, wparam, lparam):
        if not first_at:
            first_at.append(time.perf_counter_ns())
        messages[0] += 1
        return True

    user.PostMessageW.side_effect = post
    with patch('combat_actuator.window_details', return_value=('PokeAlliance - Ash', 800, 600)), \
            patch('walker_input.time.sleep'):
        for _ in range(iterations):
            first_at.clear()
            messages[0] = 0
            result = combat.new_result(42)
            started = time.perf_counter_ns()
            combat.dispatch(user, kernel, 42, 77, request, result)
            finished = time.perf_counter_ns()
            total.append((finished - started) / 1000.0)
            first.append((first_at[0] - started) / 1000.0)
    return {'firstMessageUs': stats(first), 'commandUs': stats(total),
            'messagesPerCommand': messages[0]}


def main():
    iterations = int(sys.argv[1]) if len(sys.argv) > 1 else 2000
    user = build_user()
    kernel = Mock()
    key = measure(user, kernel, {'kind': 'key', 'key': 'F1'}, iterations)
    attack = measure(user, kernel, {'kind': 'attack', 'x': 400, 'y': 300,
                                    'width': 800, 'height': 600}, iterations)
    print(json.dumps({'iterations': iterations, 'key': key, 'attack': attack,
                      'keyHoldDwellMs': 40.0}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
