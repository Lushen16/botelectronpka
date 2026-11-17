import copy
import hashlib
import html
import json
import math
from pathlib import Path

from .media import batches, contact_sheet, digest, load_acceptance, read_json, sample_frames, write_json
from .vision import (CALIBRATION_SCHEMA, PROMPT_VERSION, check_schema, checked_image,
                     validate_observation, validate_references)


def calibrate(root, frames, client, start_ms, duration_ms, stop_min_ms=None):
    window = [row for row in frames if start_ms <= row['timestamp_ms'] <= start_ms + duration_ms]
    if len(window) < 3:
        raise ValueError('Calibration needs at least three frames inside the selected interval')
    selected = sample_frames(window, max(20, duration_ms / 60))
    if len({row['pixel_sha256'] for row in selected}) < 3:
        raise ValueError('Calibration is static or possibly frozen; choose another visual interval')
    result = client.call(root, selected, 'calibration', {'start_ms': start_ms, 'duration_ms': duration_ms})
    check_schema(result, CALIBRATION_SCHEMA)
    if result['review_required'] or len(result['step_intervals']) < 2:
        raise ValueError('Normal step interval was not visually established; choose calibration interval/review it')
    if any(index not in {row['frame_index'] for row in selected} for index in result['evidence_frames']):
        raise ValueError('Calibration cited an unsent frame')
    intervals = []
    pairs = set()
    for interval in result['step_intervals']:
        lower, upper = validate_references(interval, selected)
        pair = (interval['frame_before'], interval['frame_after'])
        if pair in pairs:
            raise ValueError('Duplicate calibration interval is not independent step evidence')
        pairs.add(pair)
        intervals.append(upper - lower)
    if len(result['evidence_frames']) < 2 or not result['reason'].strip():
        raise ValueError('Calibration evidence is incomplete')
    ordered = sorted(intervals)
    normal_p90 = ordered[math.ceil(.9 * len(ordered)) - 1]
    chosen = math.ceil(max(100, normal_p90 * 1.5)) if stop_min_ms is None else stop_min_ms
    if not math.isfinite(chosen) or chosen <= normal_p90:
        raise ValueError('Stop threshold must exceed visually calibrated normal step interval')
    return {'schema_version': 1, 'model': client.model, 'normal_step_intervals_ms': intervals,
            'normal_step_p90_ms': normal_p90, 'stop_min_ms': chosen,
            'threshold_rule': 'max(100ms, ceil(1.5 * observed step p90))' if stop_min_ms is None else 'explicit operator override > normal step p90',
            'visual_result': result, 'human_validated': False, 'frozen_before_detection': True}


def event_from_rows(kind, before, after, reason, evidence=None):
    return {'event_id': '', 'event_type': kind, 'earliest_ms': before['timestamp_ms'],
            'latest_ms': after['timestamp_ms'], 'frame_before': before['frame_index'],
            'frame_after': after['frame_index'], 'evidence_frames': evidence or [before['frame_index'], after['frame_index']],
            'reason': reason, 'review_required': True, 'confidence': None}


def consolidate(events):
    merged = []
    for candidate in sorted(copy.deepcopy(events), key=lambda item: (item['earliest_ms'], item['latest_ms'], item['event_type'])):
        match = next((item for item in reversed(merged)
                      if item['event_type'] == candidate['event_type']
                      and min(item['latest_ms'], candidate['latest_ms']) >= max(item['earliest_ms'], candidate['earliest_ms'])), None)
        if match:
            match['earliest_ms'] = min(match['earliest_ms'], candidate['earliest_ms'])
            match['latest_ms'] = max(match['latest_ms'], candidate['latest_ms'])
            match['frame_before'] = min(match['frame_before'], candidate['frame_before'])
            match['frame_after'] = max(match['frame_after'], candidate['frame_after'])
            match['evidence_frames'] = sorted(set(match['evidence_frames'] + candidate['evidence_frames']))
            match['review_required'] = match['review_required'] or candidate['review_required']
            if candidate['reason'] not in match['reason']:
                match['reason'] += ' | ' + candidate['reason']
        else:
            merged.append(candidate)
    for index, item in enumerate(merged):
        identity = json.dumps([item['event_type'], item['frame_before'], item['frame_after']])
        item['event_id'] = 'visual-' + hashlib.sha256(identity.encode()).hexdigest()[:12]
        item['conflicts_with'] = []
    for index, item in enumerate(merged):
        for other in merged[index + 1:]:
            if other['earliest_ms'] > item['latest_ms']:
                break
            if item['event_type'] != other['event_type']:
                item['review_required'] = other['review_required'] = True
                item['conflicts_with'].append(other['event_id'])
                other['conflicts_with'].append(item['event_id'])
    return merged


def recording_ambiguities(frames, stop_min_ms, anomalies):
    events = []
    start = 0
    for index in range(1, len(frames) + 1):
        if index < len(frames) and frames[index]['pixel_sha256'] == frames[start]['pixel_sha256']:
            continue
        if frames[index - 1]['timestamp_ms'] - frames[start]['timestamp_ms'] >= stop_min_ms:
            events.append(event_from_rows('indeterminate', frames[start], frames[index - 1],
                          'Identical cropped pixels: same-tile dwell and frozen capture cannot be distinguished'))
        start = index
    by_index = {row['frame_index']: row for row in frames}
    for anomaly in anomalies:
        if anomaly['frame_before'] in by_index and anomaly['frame_after'] in by_index:
            events.append(event_from_rows('indeterminate', by_index[anomaly['frame_before']],
                                          by_index[anomaly['frame_after']], anomaly['reason']))
    return events


def candidates_from_segments(result, rows):
    by_index = {row['frame_index']: row for row in rows}
    ordered = sorted(result['segments'], key=lambda item: item['frame_before'])
    candidates = []
    for segment in ordered:
        if segment['state'] == 'indeterminate':
            candidates.append(event_from_rows('indeterminate', by_index[segment['frame_before']],
                by_index[segment['frame_after']], segment['reason'], segment['evidence_frames']))
    for before, after in zip(ordered, ordered[1:]):
        if before['state'] == after['state']:
            continue
        boundary = after['frame_before']
        previous = [row for row in rows if row['frame_index'] < boundary]
        if not previous:
            continue
        kind = {('moving', 'stopped'): 'stop', ('stopped', 'moving'): 'resume'}.get(
            (before['state'], after['state']), 'indeterminate')
        candidates.append(event_from_rows(kind, previous[-1], by_index[boundary],
                          'Segment boundary requires consecutive-frame refinement: ' + after['reason']))
    return candidates


def overlap_conflicts(segments, rows):
    by_index = {row['frame_index']: row for row in rows}
    candidates = []
    ordered = sorted(segments, key=lambda item: item['frame_before'])
    for index, first in enumerate(ordered):
        for second in ordered[index + 1:]:
            if second['frame_before'] >= first['frame_after']:
                break
            if first['state'] == second['state']:
                continue
            lower = max(first['frame_before'], second['frame_before'])
            upper = min(first['frame_after'], second['frame_after'])
            if lower < upper:
                candidates.append(event_from_rows('indeterminate', by_index[lower], by_index[upper],
                    'Overlapping batches disagree on visual state: ' + first['state'] + ' versus ' + second['state']))
    return consolidate(candidates)


def verify_manifest(path):
    path = Path(path).resolve()
    manifest = read_json(path)
    frames = manifest['frames']
    if not manifest['isolation'].get('confirmed_no_shiba_indicators'):
        raise ValueError('Unconfirmed visual isolation')
    if not frames or any(after['frame_index'] != before['frame_index'] + 1
                         or after['timestamp_ms'] <= before['timestamp_ms']
                         for before, after in zip(frames, frames[1:])):
        raise ValueError('Manifest must contain every original consecutive presentation frame in its interval')
    for row in frames:
        checked_image(path.parent, row)
    if digest(manifest['metadata']['video_path']) != manifest['metadata']['video_sha256']:
        raise ValueError('Source video changed after extraction')
    if manifest['stage'] == 'full':
        gate = load_acceptance(manifest['pilot_acceptance'], manifest['metadata']['video_sha256'], manifest['isolation'])
        if gate['calibration'] != manifest['frozen_calibration']:
            raise ValueError('Full analysis calibration differs from the checked pilot')
        if frames[0]['frame_index'] != 0 or frames[-1]['frame_index'] != manifest['metadata']['frame_count'] - 1:
            raise ValueError('Full-video manifest omits source frames')
    return manifest


def analyze(manifest_path, out, client, stride_ms=100, batch_size=96, overlap=24,
            calibration_start_ms=None, calibration_duration_ms=2000, stop_min_ms=None, context_ms=800):
    manifest_path, out = Path(manifest_path).resolve(), Path(out).resolve()
    manifest = verify_manifest(manifest_path)
    frames, root = manifest['frames'], manifest_path.parent
    if stride_ms < 0 or not math.isfinite(stride_ms) or context_ms < 0:
        raise ValueError('Invalid sampling/refinement interval')
    if not 4 <= batch_size <= 128 or not 1 <= overlap < batch_size:
        raise ValueError('Require batch size 4..128 and positive smaller overlap')
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'analysis.json').exists():
        raise ValueError('Completed analysis exists; use a new output directory')
    calibration_file = out / 'calibration.json'
    calibration_context = {'manifest_sha256': digest(manifest_path), 'model': client.model,
        'start_ms': calibration_start_ms if calibration_start_ms is not None else manifest['start_ms'],
        'duration_ms': calibration_duration_ms, 'requested_stop_min_ms': stop_min_ms}
    write_json(out / 'status.json', {'complete': False, 'stage': manifest['stage'],
                                   'visual_input_only': True, 'status': 'running'})
    if manifest['stage'] == 'full':
        frozen = manifest['frozen_calibration']
        if not frozen or frozen['model'] != client.model or (stop_min_ms is not None and stop_min_ms != frozen['stop_min_ms']):
            raise ValueError('Full analysis must preserve pilot model and frozen threshold')
    elif calibration_file.exists():
        saved = read_json(calibration_file)
        if saved['context'] != calibration_context:
            raise ValueError('Frozen calibration differs; use another analysis directory')
        frozen = saved['calibration']
    else:
        frozen = calibrate(root, frames, client, calibration_context['start_ms'], calibration_duration_ms, stop_min_ms)
    write_json(calibration_file, {'context': calibration_context, 'calibration': frozen})
    threshold = frozen['stop_min_ms']
    coarse_frames = sample_frames(frames, stride_ms)
    max_sample_gap = max(after['timestamp_ms'] - before['timestamp_ms'] for before, after in zip(coarse_frames, coarse_frames[1:]))
    normal_frame_gap = manifest['metadata']['median_frame_interval_ms']
    fine_overlap = max(overlap, math.ceil(threshold / normal_frame_gap) + 2)
    if fine_overlap >= batch_size:
        raise ValueError('Batch too short for frozen dwell threshold; increase --batch-size (up to 128)')
    coarse, segments, audits = [], [], []
    batch_records = []
    for index, rows in enumerate(batches(coarse_frames, batch_size, fine_overlap)):
        context = {'stop_min_ms': threshold, 'pass': 'coarse', 'batch_index': index,
                   'sample_stride_ms': stride_ms, 'max_sample_gap_ms': max_sample_gap}
        result = validate_observation(client.call(root, rows, 'detection', context), rows, threshold)
        coarse.extend(result['events'])
        coarse.extend(candidates_from_segments(result, rows))
        segments.extend(result['segments'])
        batch_records.append({'pass': 'coarse', 'frames': [row['frame_index'] for row in rows], 'result': result})
    conflicts = overlap_conflicts(segments, coarse_frames)
    coarse = consolidate(coarse + conflicts)
    final, refined_segments = list(conflicts), []
    for candidate_index, candidate in enumerate(coarse):
        margin = max(context_ms, threshold + max_sample_gap)
        window = [row for row in frames if candidate['earliest_ms'] - margin <= row['timestamp_ms'] <= candidate['latest_ms'] + margin]
        refined = []
        if len(window) >= 2:
            for index, rows in enumerate(batches(window, batch_size, fine_overlap)):
                context = {'stop_min_ms': threshold, 'pass': 'consecutive-refinement',
                           'candidate_index': candidate_index, 'batch_index': index,
                           'candidate_earliest_ms': candidate['earliest_ms'], 'candidate_latest_ms': candidate['latest_ms'],
                           'note': 'Every frame here is consecutive in the ORIGINAL video; reconsider independently from pixels'}
                result = validate_observation(client.call(root, rows, 'refinement', context), rows, threshold)
                refined.extend(result['events'])
                refined_segments.extend(result['segments'])
                batch_records.append({'pass': 'refinement', 'frames': [row['frame_index'] for row in rows], 'result': result})
        compatible = [item for item in refined if item['event_type'] == candidate['event_type']
                      and item['earliest_ms'] <= candidate['latest_ms'] + max_sample_gap
                      and item['latest_ms'] >= candidate['earliest_ms'] - max_sample_gap]
        if not compatible:
            candidate['review_required'] = True
            candidate['reason'] += ' [Consecutive-frame refinement did not corroborate this candidate]'
            final.append(candidate)
        final.extend(refined)
    final.extend(recording_ambiguities(frames, threshold, manifest['metadata']['anomalies']))
    final.extend(overlap_conflicts(refined_segments, frames))
    final = consolidate(final)
    recording_review = bool(manifest['metadata']['probe_warnings'].strip() or manifest['extraction_warnings'].strip())
    if recording_review:
        for item in final:
            item['review_required'] = True
            item['reason'] += ' [Media decoder warnings require recording review]'
    for state in ('moving', 'stopped', 'indeterminate'):
        examples = [segment for segment in segments if segment['state'] == state]
        for segment in examples[:2]:
            audits.append(segment)
    analysis = {'schema_version': 1, 'complete': True, 'stage': manifest['stage'],
                'manifest_path': str(manifest_path), 'manifest_sha256': digest(manifest_path),
                'video_sha256': manifest['metadata']['video_sha256'], 'model': client.model,
                'prompt_version': PROMPT_VERSION, 'visual_input_only': True, 'kind6_used_for_detection': False,
                'recording_review_required': recording_review,
                'review_status': 'automatic-not-human-validated', 'calibration': frozen,
                'coverage': {'start_ms': frames[0]['timestamp_ms'], 'end_ms': frames[-1]['timestamp_ms'],
                             'all_video_covered': manifest['stage'] == 'full',
                             'coarse_frame_count': len(coarse_frames), 'original_frame_count': len(frames),
                             'requested_sample_interval_ms': stride_ms, 'max_actual_sample_gap_ms': max_sample_gap,
                             'conservative_minimum_event_duration_ms': threshold + 2 * max_sample_gap,
                             'limitation': 'Conservative dwell plus two sampling gaps, NOT a recall guarantee; shorter events can be missed'},
                'api_calls_this_run': getattr(client, 'requests', None),
                'api_images_this_run': getattr(client, 'images', None),
                'events': final, 'segments': segments, 'continuous_audit_samples': audits,
                'batches': batch_records}
    write_json(out / 'analysis.json', analysis)
    write_json(out / 'events.json', final)
    build_review(analysis, out)
    write_json(out / 'status.json', {'complete': True, 'review_status': analysis['review_status'],
                                   'stage': manifest['stage'], 'status': 'automatic-annotation-complete'})
    return analysis


def build_review(analysis, out):
    out = Path(out)
    manifest = read_json(analysis['manifest_path'])
    root = Path(analysis['manifest_path']).parent
    by_index = {row['frame_index']: row for row in manifest['frames']}
    sections = []
    groups = [(event['event_id'] + ' ' + event['event_type'], event['reason'], event['evidence_frames'])
              for event in analysis['events']]
    groups += [('Continuous ' + segment['state'], segment['reason'], segment['evidence_frames'])
               for segment in analysis['continuous_audit_samples']]
    for index, (title, reason, evidence) in enumerate(groups):
        rows = [by_index[frame_index] for frame_index in sorted(set(evidence))]
        images = []
        for offset in range(0, len(rows), 32):
            sheet = out / f'evidence-{index:04d}-{offset // 32:03d}.jpg'
            contact_sheet(rows[offset:offset + 32], root, sheet)
            images.append(f'<img loading="lazy" src="{sheet.name}" alt="Chronological original frame IDs and timestamps">')
        sections.append(f'<section><h2>{html.escape(title)}</h2><p>{html.escape(reason)}</p>' + ''.join(images) + '</section>')
    text = '<!doctype html><meta charset="utf-8"><title>Independent visual review</title>'
    text += '<style>body{font:16px system-ui;max-width:1100px;margin:24px auto;padding:12px}img{max-width:100%}section{margin:30px 0}</style>'
    text += '<h1>Automatic annotations - NOT human validated</h1>'
    text += '<p>Review events AND continuous moving/stopped samples. No kind6 was used. Uncertainty and conflicts remain pending.</p>'
    text += '<pre>' + html.escape(json.dumps(analysis['calibration'], indent=2)) + '</pre>'
    (out / 'review.html').write_text(text + ''.join(sections), encoding='utf-8')


def review_human(analysis_path, annotations_path, out, tolerance_ms=250):
    from .compare import pair_events

    analysis_path = Path(analysis_path).resolve()
    analysis, human = read_json(analysis_path), read_json(annotations_path)
    manifest = read_json(analysis['manifest_path'])
    frames = manifest['frames']
    if human.get('video_sha256') != analysis['video_sha256'] or not human.get('reviewer'):
        raise ValueError('Human annotations must identify reviewer and the same video hash')
    if tolerance_ms < 0 or not math.isfinite(tolerance_ms):
        raise ValueError('Invalid human comparison tolerance')
    if len({item['event_id'] for item in human['events']}) != len(human['events']):
        raise ValueError('Human event IDs must be unique')
    for item in human['events']:
        lower, upper = validate_references(item, frames)
        if item['event_type'] not in ('stop', 'resume', 'indeterminate') or type(item.get('review_required')) is not bool:
            raise ValueError('Invalid human event type/review flag')
        if abs(item['earliest_ms'] - lower) > .001 or abs(item['latest_ms'] - upper) > .001:
            raise ValueError('Human annotation times must match cited original PTS frames')
    auto = [item for item in analysis['events'] if item['event_type'] != 'indeterminate']
    references = [dict(item, publication_ms=(item['earliest_ms'] + item['latest_ms']) / 2)
                  for item in human['events'] if item['event_type'] != 'indeterminate' and not item['review_required']]
    matched = pair_events(auto, references, tolerance_ms)
    result = {'analysis_sha256': digest(analysis_path), 'human_annotations_sha256': digest(annotations_path),
              'reviewer': human['reviewer'], 'tolerance_ms': tolerance_ms, 'comparison': matched,
              'errors': {'missed_by_automatic': matched['unmatched_holding'],
                         'extra_automatic': matched['unmatched_visual']},
              'caveat': 'Human annotation is a review source, not automatically infallible; unresolved frames remain pending'}
    write_json(out, result)
    return result


def accept_pilot(analysis_path, out, reviewer, basis, notes, human_review=None):
    analysis_path = Path(analysis_path).resolve()
    analysis = read_json(analysis_path)
    if analysis['stage'] != 'pilot' or not analysis['complete'] or not reviewer.strip() or not notes.strip():
        raise ValueError('Acceptance requires a completed pilot, reviewer identity and review notes')
    review = analysis_path.parent / 'review.html'
    if not review.exists() or basis not in ('human', 'automatic-only'):
        raise ValueError('Missing evidence review or invalid review basis')
    if basis == 'human':
        if not human_review or read_json(human_review)['analysis_sha256'] != digest(analysis_path):
            raise ValueError('Human acceptance requires a matching review-human report with errors recorded')
    gate = {'accepted': True, 'analysis_path': str(analysis_path), 'analysis_sha256': digest(analysis_path),
            'review_html_sha256': digest(review), 'reviewer': reviewer, 'review_basis': basis,
            'human_validated': basis == 'human', 'notes': notes,
            'human_review_path': str(Path(human_review).resolve()) if human_review else None,
            'human_review_sha256': digest(human_review) if human_review else None,
            'pending_event_ids': [event['event_id'] for event in analysis['events'] if event['review_required']]}
    write_json(out, gate)
    return gate
