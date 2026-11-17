#!/usr/bin/env python
"""
holding_vs_motion.py - compara `holding` (kind6) com a posicao REAL do personagem.

    python tools/holding_vs_motion.py \
        --kind6   captures/motion/kind6-<data>.jsonl \
        --position captures/motion/pos-<data>.jsonl \
        --out captures/motion/result-<data>.json

ENTRADAS
    --kind6     JSONL do tap (linhas kind=6). So' leitura.
    --position  JSONL do position_sampler (x/y/z + t).

ALINHAMENTO
    Os dois usam GetTickCount() do sistema, entao `t` e' diretamente comparavel.
    Nao ha video, nao ha marcador, nao ha API. O erro de alinhamento e' a
    resolucao da amostragem de posicao (>= 33 ms a 30 Hz), declarado na saida.

DEFINICOES (congeladas)
    MOVIMENTO REAL
      - `move`: (x,y) mudou entre amostras consecutivas de posicao
      - `stop`: (x,y) igual por >= STOP_MIN_MS
      - `resume`: primeira mudanca de (x,y) apos um `stop`
    holding
      - `stop`   = transicao false->true
      - `resume` = transicao true->false
    Episodio de lure: mode=dynamic e paused!=true (do kind6).

PAREAMENTO
    1:1 por direcao, dentro do MESMO episodio, tolerancia --tolerance-ms.
    Evento sem par de cada lado e' preservado, nao forcado.

SAIDA
    JSON com totais, pares, deltas e exemplos. Tambem imprime resumo.
"""

import argparse
import json
import os
import sys
from bisect import bisect_left


def load_position(path):
    rows = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get('online') and isinstance(r.get('t'), int):
                rows.append(r)
    rows.sort(key=lambda r: r['t'])
    return rows


def load_kind6(path):
    """Le kind6 do tap. Aceita linha crua do tap (campo `d` em hex)."""
    out = []
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or '"kind":6' not in line and '"kind": 6' not in line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get('kind') != 6:
                continue
            d = o.get('d')
            if not d:
                continue
            try:
                payload = json.loads(bytes.fromhex(d).decode('utf-8'))
            except Exception:
                continue
            lu = payload.get('luring') or {}
            holding = lu.get('holding')
            if payload.get('paused') is True or lu.get('mode') != 'dynamic':
                continue
            if not isinstance(holding, bool):
                continue
            out.append({
                't': o['t'],
                'holding': holding,
                'phase': lu.get('phase'),
                'count': lu.get('count'),
                'minCount': lu.get('minCount'),
                'phase_text': payload.get('phase'),
            })
    out.sort(key=lambda r: r['t'])
    return out


def build_episodes(kind6, gap_ms):
    """Episodio de lure: sequencia contigua de kind6 valido; gap > gap_ms corta."""
    eps = []
    cur = None
    prev_t = None
    for r in kind6:
        if prev_t is None or (r['t'] - prev_t) > gap_ms:
            if cur is not None:
                eps.append(cur)
            cur = {'id': len(eps), 'rows': [r]}
        else:
            cur['rows'].append(r)
        prev_t = r['t']
    if cur is not None:
        eps.append(cur)
    for e in eps:
        e['t0'] = e['rows'][0]['t']
        e['t1'] = e['rows'][-1]['t']
    return eps


def holding_transitions(episodes):
    """Transicoes false->true (stop) e true->false (resume) dentro do episodio."""
    out = []
    for e in episodes:
        prev = None
        for r in e['rows']:
            if prev is not None and prev['holding'] != r['holding']:
                out.append({
                    'kind': 'stop' if r['holding'] else 'resume',
                    't': r['t'],                 # primeira publicacao do novo estado
                    't_prev': prev['t'],         # ultima publicacao do estado antigo
                    'episode': e['id'],
                    'phase': r['phase'],
                    'count': r['count'],
                    'minCount': r['minCount'],
                })
            prev = r
    return out


def motion_events(position, stop_min_ms, z_tolerance):
    """
    Deriva paradas e retomadas da posicao real.

    - `move` entre amostras i-1 e i: (x,y) diferente
    - `stop` comecando em i: (x,y) constante por >= stop_min_ms
      o inicio da parada e' o instante da ULTIMA amostra antes da constancia,
      ou seja, o fim do ultimo deslocamento.
    - `resume` em i: (x,y) muda apos uma parada
    """
    stops = []
    resumes = []
    if len(position) < 2:
        return stops, resumes

    # marca cada amostra como igual-anterior ou mudou
    moved = [False] * len(position)
    for i in range(1, len(position)):
        a, b = position[i - 1], position[i]
        if (a['x'], a['y']) != (b['x'], b['y']):
            moved[i] = True

    i = 1
    n = len(position)
    while i < n:
        if not moved[i]:
            # inicio de possivel parada: procurar ate' onde nao muda
            j = i
            while j + 1 < n and not moved[j + 1]:
                j += 1
            # permaneceu de position[i]['t'] a position[j]['t']
            duration = position[j]['t'] - position[i - 1]['t']
            if duration >= stop_min_ms:
                # inicio da parada = ultima amostra ANTES de ficar imovel
                stops.append({
                    't': position[i - 1]['t'],
                    't_confirm': position[j]['t'],
                    'duration_ms': duration,
                    'pos': {'x': position[i - 1]['x'], 'y': position[i - 1]['y'],
                            'z': position[i - 1]['z']},
                })
                # retomada = primeira amostra que muda depois de j
                if j + 1 < n and moved[j + 1]:
                    resumes.append({
                        't': position[j + 1]['t'],
                        'pos': {'x': position[j + 1]['x'], 'y': position[j + 1]['y'],
                                'z': position[j + 1]['z']},
                    })
            i = j + 1
        else:
            i += 1
    return stops, resumes


def match(visual, holding, tolerance_ms):
    """
    Pareamento 1:1, mesma direcao, mesma episodio de lure, |dt| <= tolerance.
    `holding` e' a referencia (kind6); `visual` e' o movimento real.

    Retorna pares e os nao-pareados de cada lado. Se dois candidatos estiverem
    dentro da tolerancia, marca ambiguo e nao forca.
    """
    used_h = set()
    pairs = []
    unmatched_v = []
    ambiguous = []

    for v in visual:
        cands = []
        for idx, h in enumerate(holding):
            if idx in used_h:
                continue
            if h['episode'] != v.get('episode'):
                continue
            dt = h['t'] - v['t']
            if abs(dt) <= tolerance_ms:
                cands.append((abs(dt), idx, dt))
        if not cands:
            unmatched_v.append(v)
            continue
        cands.sort()
        if len(cands) > 1 and abs(cands[0][0] - cands[1][0]) < 1:
            ambiguous.append({'visual': v, 'candidates': [c[1] for c in cands]})
            continue
        _, idx, dt = cands[0]
        used_h.add(idx)
        pairs.append({
            'visual': v,
            'holding': holding[idx],
            'dt_ms': dt,              # >0: publicacao DEPOIS do movimento
        })

    unmatched_h = [h for i, h in enumerate(holding) if i not in used_h]
    return pairs, unmatched_v, unmatched_h, ambiguous


def assign_episode_to_motion(position, episodes, stops, resumes):
    """Cada parada/retomada herda o episodio de lure que a contem no tempo."""
    def ep_of(t):
        for e in episodes:
            if e['t0'] <= t <= e['t1']:
                return e['id']
        return None
    for s in stops:
        s['episode'] = ep_of(s['t'])
    for r in resumes:
        r['episode'] = ep_of(r['t'])


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    idx = min(len(s) - 1, int(len(s) * p))
    return s[idx]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--kind6', required=True)
    ap.add_argument('--position', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--tolerance-ms', type=float, default=250.0)
    ap.add_argument('--stop-min-ms', type=float, default=300.0,
                    help='permanencia minima no mesmo tile para contar parada')
    ap.add_argument('--episode-gap-ms', type=float, default=600.0)
    ap.add_argument('--z-tolerance', type=int, default=0)
    args = ap.parse_args()

    position = load_position(args.position)
    kind6 = load_kind6(args.kind6)
    if not position or not kind6:
        print('dados insuficientes: position=%d kind6=%d' % (len(position), len(kind6)),
              file=sys.stderr)
        return 2

    episodes = build_episodes(kind6, args.episode_gap_ms)
    h_stops = [t for t in holding_transitions(episodes) if t['kind'] == 'stop']
    h_resumes = [t for t in holding_transitions(episodes) if t['kind'] == 'resume']

    m_stops, m_resumes = motion_events(position, args.stop_min_ms, args.z_tolerance)
    assign_episode_to_motion(position, episodes, m_stops, m_resumes)

    # alinhamento: mesmo relogio, entao dt direto. Incerteza = metade do
    # intervalo mediano de amostragem de posicao.
    gaps = [position[i]['t'] - position[i - 1]['t']
            for i in range(1, len(position)) if position[i]['t'] > position[i - 1]['t']]
    median_gap = pct(gaps, 0.5) or 0
    max_gap = max(gaps) if gaps else 0

    res = {'stop': {}, 'resume': {}}
    for kind, motion, holding in (('stop', m_stops, h_stops), ('resume', m_resumes, h_resumes)):
        pairs, unmatched_v, unmatched_h, ambiguous = match(motion, holding, args.tolerance_ms)
        dts = [p['dt_ms'] for p in pairs]
        res[kind] = {
            'visual_events': len(motion),
            'holding_events': len(holding),
            'pairs': len(pairs),
            'unmatched_visual': len(unmatched_v),
            'unmatched_holding': len(unmatched_h),
            'ambiguous': len(ambiguous),
            'dt_ms': {
                'median': pct(dts, 0.5),
                'p90_abs': pct([abs(x) for x in dts], 0.9),
                'min': min(dts) if dts else None,
                'max': max(dts) if dts else None,
            },
            'holding_after_motion': sum(1 for x in dts if x > 0),
            'holding_before_motion': sum(1 for x in dts if x < 0),
            'examples_pairs': pairs[:5],
            'examples_unmatched_visual': unmatched_v[:5],
            'examples_unmatched_holding': unmatched_h[:5],
        }

    out = {
        'inputs': {
            'kind6': os.path.abspath(args.kind6),
            'position': os.path.abspath(args.position),
        },
        'config': {
            'tolerance_ms': args.tolerance_ms,
            'stop_min_ms': args.stop_min_ms,
            'episode_gap_ms': args.episode_gap_ms,
        },
        'clock': {
            'source': 'GetTickCount do sistema, nos dois lados',
            'offset': 0,
            'note': 'mesma API; nao ha video nem marcador',
        },
        'sampling': {
            'position_samples': len(position),
            'position_median_gap_ms': median_gap,
            'position_max_gap_ms': max_gap,
            'alignment_uncertainty_ms': round(median_gap / 2.0, 1),
            'kind6_samples': len(kind6),
            'episodes': len(episodes),
        },
        'result': res,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)

    # resumo
    print('=== holding x movimento real ===\n')
    print('posicao : %d amostras, gap mediano %.0f ms (incerteza %.0f ms)'
          % (len(position), median_gap, median_gap / 2.0))
    print('kind6   : %d amostras em %d episodios' % (len(kind6), len(episodes)))
    print('tolerancia de pareamento: %.0f ms\n' % args.tolerance_ms)
    for kind in ('stop', 'resume'):
        r = res[kind]
        nome = 'PARADA' if kind == 'stop' else 'RETOMADA'
        print('%s' % nome)
        print('  movimento real : %d' % r['visual_events'])
        print('  holding        : %d' % r['holding_events'])
        print('  pareados       : %d' % r['pairs'])
        print('  sem par (visual): %d' % r['unmatched_visual'])
        print('  sem par (holding): %d' % r['unmatched_holding'])
        if r['ambiguous']:
            print('  ambiguos       : %d' % r['ambiguous'])
        if r['dt_ms']['median'] is not None:
            print('  dt mediana     : %.0f ms' % r['dt_ms']['median'])
            print('  |dt| p90       : %.0f ms' % r['dt_ms']['p90_abs'])
            print('  holding depois : %d' % r['holding_after_motion'])
            print('  holding antes  : %d' % r['holding_before_motion'])
        print()
    print('escrito: %s' % args.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
