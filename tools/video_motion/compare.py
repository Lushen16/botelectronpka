import copy
import hashlib
import json
import math
from pathlib import Path

from .media import digest, read_json, write_json


def decode_kind6(line):
    record = json.loads(line)
    if record.get('kind') != 6:
        return None
    timestamp = record.get('t')
    if type(timestamp) not in (int, float) or not math.isfinite(timestamp):
        raise ValueError('kind6 lacks a finite log timestamp')
    payload = json.loads(bytes.fromhex(record['d']).decode('utf-8'))
    return {'t': timestamp, 'payload': payload}


def load_reference(log_path, selected_start, selected_end, marker_lines, max_gap_ms=600):
    transitions, markers = [], {}
    stats = {'kind6': 0, 'unknown_or_paused': 0, 'gaps': 0, 'malformed_lines': 0}
    previous = None
    last_time = None
    with Path(log_path).open('r', encoding='utf-8-sig') as stream:
        for line_number, line in enumerate(stream, 1):
            if line_number in marker_lines:
                record = json.loads(line)
                markers[line_number] = {'t': record.get('t'), 'line_sha256': hashlib.sha256(line.encode()).hexdigest()}
            try:
                entry = decode_kind6(line)
            except (ValueError, KeyError, UnicodeDecodeError, TypeError):
                stats['malformed_lines'] += 1
                previous = None
                continue
            if entry is None or not selected_start <= entry['t'] <= selected_end:
                continue
            stats['kind6'] += 1
            if last_time is not None and entry['t'] < last_time:
                raise ValueError('Log clock reset inside selected session; split capture before comparing')
            last_time = entry['t']
            payload = entry['payload']
            luring = payload.get('luring') or {}
            holding = luring.get('holding')
            if payload.get('paused') is True or luring.get('mode') != 'dynamic' or type(holding) is not bool:
                previous = None
                stats['unknown_or_paused'] += 1
                continue
            if previous and entry['t'] - previous['t'] > max_gap_ms:
                previous = None
                stats['gaps'] += 1
            if previous and previous['holding'] != holding:
                transitions.append({'event_id': f'kind6-line-{line_number}', 'event_type': 'stop' if holding else 'resume',
                                    'earliest_ms': previous['t'], 'latest_ms': entry['t'],
                                    'publication_ms': entry['t'], 'log_line': line_number,
                                    'note': 'holding transition is interval-censored between these two publications'})
            previous = {'t': entry['t'], 'holding': holding}
    return transitions, markers, stats


def interval_distance(first, second):
    return max(0, first['earliest_ms'] - second['latest_ms'], second['earliest_ms'] - first['latest_ms'])


def pair_events(visual, reference, tolerance_ms=1000):
    visual = sorted(visual, key=lambda event: event['earliest_ms'])
    reference = sorted(reference, key=lambda event: event['earliest_ms'])
    if len(visual) * len(reference) > 1000000:
        raise ValueError('Comparison too large; split by session/episode before matching')
    scores = [[(0, 0.0) for unused in range(len(reference) + 1)] for unused in range(len(visual) + 1)]
    moves = {}
    for vi in range(1, len(visual) + 1):
        for ri in range(1, len(reference) + 1):
            choices = [(scores[vi - 1][ri], 'visual'), (scores[vi][ri - 1], 'reference')]
            before, after = visual[vi - 1], reference[ri - 1]
            if before['event_type'] == after['event_type'] and interval_distance(before, after) <= tolerance_ms:
                count, cost = scores[vi - 1][ri - 1]
                delta = abs((before['earliest_ms'] + before['latest_ms']) / 2 -
                            (after['earliest_ms'] + after['latest_ms']) / 2)
                choices.append(((count + 1, cost - delta), 'match'))
            scores[vi][ri], moves[vi, ri] = max(choices, key=lambda item: item[0])
    pairs, used_visual, used_reference = [], set(), set()
    vi, ri = len(visual), len(reference)
    while vi and ri:
        move = moves[vi, ri]
        if move == 'match':
            before, after = visual[vi - 1], reference[ri - 1]
            pairs.append({'visual_event_id': before['event_id'], 'kind6_event_id': after['event_id'],
                          'event_type': before['event_type'], 'interval_distance_ms': interval_distance(before, after),
                          'publication_minus_visual_ms': {
                              'min': after['publication_ms'] - before['latest_ms'],
                              'max': after['publication_ms'] - before['earliest_ms']}})
            used_visual.add(before['event_id'])
            used_reference.add(after['event_id'])
            vi, ri = vi - 1, ri - 1
        elif move == 'visual':
            vi -= 1
        else:
            ri -= 1
    return {'pairs': list(reversed(pairs)),
            'unmatched_visual': [event for event in visual if event['event_id'] not in used_visual],
            'unmatched_holding': [event for event in reference if event['event_id'] not in used_reference]}


def compare(analysis_path, log_path, session_path, out, tolerance_ms=1000, max_sync_error_ms=33):
    analysis_path, log_path = Path(analysis_path).resolve(), Path(log_path).resolve()
    analysis = read_json(analysis_path)
    if not analysis.get('complete') or analysis.get('kind6_used_for_detection') is not False:
        raise ValueError('Independent completed visual analysis is required before reading kind6')
    manifest_path = Path(analysis['manifest_path'])
    if digest(manifest_path) != analysis['manifest_sha256']:
        raise ValueError('Visual manifest changed')
    manifest = read_json(manifest_path)
    session = read_json(session_path)
    log_hash = digest(log_path)
    if (not session.get('same_session_confirmed') or not str(session.get('session_id', '')).strip()
            or not str(session.get('evidence', '')).strip()
            or session.get('video_sha256') != analysis['video_sha256']
            or session.get('jsonl_sha256') != log_hash):
        raise ValueError('Same-session confirmation/evidence or source hashes are missing/mismatched')
    if tolerance_ms < 0 or max_sync_error_ms <= 0:
        raise ValueError('Invalid comparison/synchronization tolerance')
    video_index = read_json(manifest_path.parent / 'video-index.json')
    by_index = {row['frame_index']: row for row in video_index['frames']}
    markers = {marker['id']: marker for marker in session['markers']}
    if set(markers) != {'A', 'B', 'C'} or len(session['markers']) != 3:
        raise ValueError('Require exactly three independent synchronization markers A/B/C')
    points = []
    for name in ('A', 'B', 'C'):
        marker = markers[name]
        if marker['frame_index'] not in by_index or not marker.get('description'):
            raise ValueError('Marker must cite an existing original frame and describe independent session evidence')
        video_ms = by_index[marker['frame_index']]['timestamp_ms']
        log_ms = marker['log_t_ms']
        if type(log_ms) not in (int, float) or not math.isfinite(log_ms) or type(marker['log_line']) is not int or marker['log_line'] < 1:
            raise ValueError('Invalid marker log time/line')
        points.append((video_ms, log_ms))
    if not points[0][0] < points[1][0] < points[2][0] or not points[0][1] < points[1][1] < points[2][1]:
        raise ValueError('Markers must be strictly chronological in both clocks')
    scale = (points[2][1] - points[0][1]) / (points[2][0] - points[0][0])
    offset = points[0][1] - scale * points[0][0]
    error_b = points[1][1] - (offset + scale * points[1][0])
    if abs(error_b) > max_sync_error_ms:
        raise ValueError(f'Synchronization rejected: held-out marker B error={error_b:.3f}ms; fix markers, not matching tolerance')
    references, actual_markers, stats = load_reference(log_path, points[0][1], points[2][1],
                                                      {marker['log_line'] for marker in markers.values()})
    for marker in markers.values():
        actual = actual_markers.get(marker['log_line'])
        if not actual or actual['t'] != marker['log_t_ms']:
            raise ValueError('Synchronization log line does not contain the declared timestamp')
    if digest(log_path) != log_hash:
        raise ValueError('JSONL changed during comparison; use an immutable snapshot')
    visual, excluded = [], []
    for event in analysis['events']:
        if (event['event_type'] == 'indeterminate' or event['review_required'] or event.get('conflicts_with')
                or event['earliest_ms'] < points[0][0] or event['latest_ms'] > points[2][0]):
            excluded.append(event)
            continue
        transformed = copy.deepcopy(event)
        transformed['earliest_ms'] = offset + scale * event['earliest_ms']
        transformed['latest_ms'] = offset + scale * event['latest_ms']
        visual.append(transformed)
    result = {'schema_version': 1, 'analysis_sha256': digest(analysis_path), 'jsonl_sha256': log_hash,
              'session_sha256': digest(session_path), 'session_id': session['session_id'],
              'session_evidence': session['evidence'], 'visual_review_status': analysis['review_status'],
              'sync': {'scale': scale, 'offset_ms': offset, 'drift_ms_per_minute': (scale - 1) * 60000,
                       'held_out_B_error_ms': error_b, 'max_B_error_ms': max_sync_error_ms,
                       'valid_video_interval_ms': [points[0][0], points[2][0]],
                       'absolute_order_caveat': 'Marker systematic capture-to-pipe delay is unknown unless independently measured'},
              'matching_tolerance_ms': tolerance_ms, 'reference_stats': stats,
              'excluded_visual': excluded, **pair_events(visual, references, tolerance_ms)}
    write_json(out, result)
    return result
