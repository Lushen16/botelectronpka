#!/usr/bin/env python
"""
position_sampler.py - amostra a posicao real do personagem em alta cadencia.

    python tools/position_sampler.py --pid 1712 --seconds 120 --hz 20 \
        --out captures/motion/pos-<data>.jsonl

RPM PURO: usa OpenProcess + ReadProcessMemory via tools/lp_state.py.
NAO injeta DLL, NAO envia comando, NAO toca no tap, NAO usa API externa.

POR QUE EXISTE
    A pergunta e' se `holding` (kind6) acompanha a parada FISICA do personagem.
    Video + API de visao foi uma solucao proposta por terceiro; ela e' indireta
    e cara. A posicao na memoria e' a fonte direta: muda de tile = andou;
    permanece = parado. O relogio e' o mesmo GetTickCount do kind6.

SAIDA (uma linha JSON por amostra)
    {"t": <GetTickCount do sistema>, "x":.., "y":.., "z":.., "hp":..,
     "name":"..", "id":.., "online":true, "err":null}

`t` vem de GetTickCount() do NOSSO processo. No Windows, GetTickCount e'
global ao sistema (nao por processo), entao e' comparavel ao `t` do tap,
que usa a mesma API. Isso e' o que permite alinhar sem video.
"""

import argparse
import ctypes
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lp_state  # noqa: E402  (reusa o leitor validado; nao reimplementa)


def get_tick():
    """GetTickCount do sistema - mesma base do tap."""
    return ctypes.windll.kernel32.GetTickCount()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pid', type=int, required=True)
    ap.add_argument('--seconds', type=float, default=60.0)
    ap.add_argument('--hz', type=float, default=20.0)
    ap.add_argument('--out', required=True)
    ap.add_argument('--fallback-va', default=None,
                    help='VA do LocalPlayer quando o global estiver NULL')
    args = ap.parse_args()

    pid = args.pid
    base = lp_state.module_base(pid, lp_state.IMAGE_NAME)
    if not base:
        print('modulo nao encontrado no pid %d' % pid, file=sys.stderr)
        return 2

    h = lp_state.k32.OpenProcess(0x0010 | 0x0400, False, pid)
    if not h:
        print('OpenProcess falhou (%d)' % ctypes.get_last_error(), file=sys.stderr)
        return 2

    fallback = None
    if args.fallback_va:
        fallback = int(args.fallback_va, 0)
    else:
        # `find_localplayer_by_vtable` devolve o VA (int) ou None, NAO um dict.
        # E' caro (le a imagem do modulo e varre a heap), por isso roda uma vez.
        try:
            va = lp_state.find_localplayer_by_vtable(pid, base)
            if va:
                fallback = int(va)
        except Exception:
            fallback = None

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    interval = 1.0 / args.hz if args.hz > 0 else 0.05
    t_end = time.time() + args.seconds
    n = 0
    n_ok = 0
    n_err = 0
    t_first = None
    t_last = None
    xy_changes = 0
    last_xy = None
    rereads = 0

    with open(args.out, 'w', encoding='utf-8') as f:
        while time.time() < t_end:
            tick = get_tick()
            try:
                st = lp_state.read_state(h, base, pid=pid, fallback_va=fallback)
            except Exception as e:
                st = {'online': False, 'reason': 'exception: %s' % e}

            # Transicao de mapa invalida o VA do LocalPlayer. Re-resolver em vez
            # de ficar erro a erro; no maximo 1 vez a cada 2 s para nao custar.
            if not st.get('online') and rereads < 10 and (time.time() % 2) < interval:
                try:
                    va = lp_state.find_localplayer_by_vtable(pid, base)
                    if va:
                        fallback = int(va)
                        rereads += 1
                        st = lp_state.read_state(h, base, pid=pid, fallback_va=fallback)
                except Exception:
                    pass

            if st.get('online'):
                rec = {
                    't': tick,
                    'x': st['x'], 'y': st['y'], 'z': st['z'],
                    'hp': st['hp'], 'name': st['name'], 'id': st['id'],
                    'online': True, 'err': None,
                }
                n_ok += 1
                xy = (st['x'], st['y'])
                if last_xy is not None and xy != last_xy:
                    xy_changes += 1
                last_xy = xy
                if t_first is None:
                    t_first = tick
                t_last = tick
            else:
                rec = {'t': tick, 'online': False, 'err': st.get('reason')}
                n_err += 1

            f.write(json.dumps(rec, ensure_ascii=False) + '\n')
            n += 1

            # cadencia: dorme o que sobra
            elapsed = time.time() + interval - (time.time())
            sleep_for = interval - ((time.time()) % interval)
            if sleep_for > 0:
                time.sleep(sleep_for)

    try:
        lp_state.k32.CloseHandle(h)
    except Exception:
        pass

    span = (t_last - t_first) if (t_first and t_last) else 0
    rate = (n_ok / (span / 1000.0)) if span > 0 else 0

    summary = {
        'file': os.path.abspath(args.out),
        'pid': pid,
        'module_base': hex(base),
        'requested_hz': args.hz,
        'requested_seconds': args.seconds,
        'samples': n,
        'ok': n_ok,
        'errors': n_err,
        't_first': t_first,
        't_last': t_last,
        'span_ms': span,
        'effective_hz': round(rate, 2),
        'xy_changes': xy_changes,
    }
    with open(args.out + '.summary.json', 'w', encoding='utf-8') as f:
        json.dump(summary, f, indent=1)

    print(json.dumps(summary, indent=1))
    return 0 if n_ok else 1


if __name__ == '__main__':
    sys.exit(main())
