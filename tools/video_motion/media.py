import hashlib
import json
import math
import statistics
import subprocess
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageDraw


def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(path)


def run(command, timeout=600):
    try:
        result = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise ValueError(f'Media command exceeded {timeout}s; processing incomplete') from error
    if result.returncode:
        raise ValueError('Media command failed: ' + result.stderr.decode('utf-8', errors='replace')[-1800:])
    return result


def inspect_video(video, ffprobe='ffprobe'):
    video = Path(video).resolve()
    result = run([ffprobe, '-v', 'warning', '-select_streams', 'v:0', '-show_frames',
                  '-show_streams', '-show_format', '-show_entries',
                  'frame=pts,best_effort_timestamp,pts_time,best_effort_timestamp_time,duration_time:'
                  'stream=index,width,height,avg_frame_rate,r_frame_rate,time_base,start_time,duration,nb_frames:'
                  'format=duration,start_time,format_name', '-of', 'json', str(video)])
    data = json.loads(result.stdout)
    if not data.get('streams') or not data.get('frames'):
        raise ValueError('No decoded video frames')
    stream = data['streams'][0]
    time_base = Fraction(stream['time_base'])
    rows = []
    for index, frame in enumerate(data['frames']):
        source = 'pts' if frame.get('pts') is not None else 'best_effort_timestamp'
        timestamp = frame.get(source)
        if timestamp is None:
            raise ValueError(f'Frame {index} has no presentation timestamp; FPS interpolation is forbidden')
        pts_ms = float(int(timestamp) * time_base * 1000)
        rows.append({'frame_index': index, 'pts': int(timestamp), 'pts_ms': pts_ms,
                     'timestamp_source': source})
    origin = rows[0]['pts_ms']
    for row in rows:
        row['timestamp_ms'] = round(row['pts_ms'] - origin, 6)
    deltas = [after['timestamp_ms'] - before['timestamp_ms'] for before, after in zip(rows, rows[1:])]
    positive = [delta for delta in deltas if delta > 0]
    normal = statistics.median(positive) if positive else None
    anomalies = []
    for index, delta in enumerate(deltas):
        if delta <= 0 or (normal and delta > max(normal * 3, 100)):
            anomalies.append({'frame_before': index, 'frame_after': index + 1,
                              'earliest_ms': rows[index]['timestamp_ms'],
                              'latest_ms': rows[index + 1]['timestamp_ms'],
                              'reason': 'non-increasing-pts' if delta <= 0 else 'presentation-gap'})
    last_duration = data['frames'][-1].get('duration_time')
    last_duration_ms = float(Fraction(last_duration) * 1000) if last_duration is not None else None
    if last_duration_ms is not None and last_duration_ms <= 0:
        last_duration_ms = None
    duration = rows[-1]['timestamp_ms'] + (last_duration_ms if last_duration_ms is not None else (normal or 0))
    return {'schema_version': 1, 'video_path': str(video), 'video_sha256': digest(video),
            'width': stream['width'], 'height': stream['height'], 'time_base': str(time_base),
            'origin_pts_ms': origin, 'duration_ms': duration, 'frame_count': len(rows),
            'duration_source': 'last-frame-pts-plus-frame-duration' if last_duration_ms is not None else 'last-frame-pts-plus-estimated-median-interval',
            'container_timing': data.get('format', {}),
            'avg_frame_rate': stream.get('avg_frame_rate'), 'r_frame_rate': stream.get('r_frame_rate'),
            'median_frame_interval_ms': normal,
            'variable_frame_timing': bool(positive and max(positive) - min(positive) > max(1, (normal or 0) * .05)),
            'probe_warnings': result.stderr.decode('utf-8', errors='replace'),
            'anomalies': anomalies, 'frames': rows,
            'session_status': 'unverified-until-independent-markers-and-log-are-checked'}


def rectangle(text):
    values = [int(value) for value in text.split(',')]
    if len(values) != 4 or values[0] < 0 or values[1] < 0 or min(values[2:]) < 1:
        raise ValueError('Rectangle must be x,y,width,height with nonnegative origin and positive size')
    return values


def isolation_config(metadata, roi, masks, confirmed):
    if not confirmed:
        raise ValueError('Explicit visual isolation confirmation is required before preparing API images')
    x, y, width, height = roi
    if x + width > metadata['width'] or y + height > metadata['height']:
        raise ValueError('ROI lies outside video')
    for left, top, mask_width, mask_height in masks:
        if left + mask_width > width or top + mask_height > height:
            raise ValueError('Masks use crop-local coordinates and must lie inside ROI')
    return {'roi': roi, 'masks': masks, 'confirmed_no_shiba_indicators': True,
            'confirmation_scope': 'Operator verified character, floor and landmarks remain; holding/phase/count overlays excluded'}


def prepare(video, out, roi, masks=(), start_ms=0, duration_ms=25000,
            confirmed=False, full=False, acceptance=None, ffmpeg='ffmpeg', ffprobe='ffprobe'):
    out = Path(out).resolve()
    if out.exists() and any(out.iterdir()):
        raise ValueError('Preparation output must be absent or empty; preserve previous artifacts')
    metadata = inspect_video(video, ffprobe)
    isolation = isolation_config(metadata, list(roi), [list(mask) for mask in masks], confirmed)
    if any(item['reason'] == 'non-increasing-pts' for item in metadata['anomalies']):
        raise ValueError('Non-increasing presentation timestamps require recording repair/review before analysis')
    if full:
        if not acceptance:
            raise ValueError('Full-video processing requires a checked pilot acceptance file')
        gate = load_acceptance(acceptance, metadata['video_sha256'], isolation)
        start_ms, duration_ms = 0, metadata['duration_ms']
    else:
        gate = None
        if not 20000 <= duration_ms <= 30000:
            raise ValueError('Pilot must cover 20-30 seconds')
        if start_ms < 0 or start_ms + duration_ms > metadata['duration_ms'] + 1:
            raise ValueError('Requested pilot is not fully present in video')
    end_ms = start_ms + duration_ms
    selected = [row.copy() for row in metadata['frames'] if start_ms <= row['timestamp_ms'] < end_ms]
    if len(selected) < 2:
        raise ValueError('Too few frames')
    out.mkdir(parents=True, exist_ok=True)
    frames_dir = out / 'frames'
    frames_dir.mkdir()
    first, last = selected[0]['frame_index'], selected[-1]['frame_index']
    x, y, width, height = roi
    filters = [fr'select=between(n\,{first}\,{last})', f'crop={width}:{height}:{x}:{y}:exact=1']
    for left, top, mask_width, mask_height in masks:
        filters.append(f'drawbox=x={left}:y={top}:w={mask_width}:h={mask_height}:color=black:t=fill')
    extracted = run([ffmpeg, '-v', 'warning', '-nostdin', '-noautorotate', '-i', str(Path(video).resolve()),
                     '-map', '0:v:0', '-vf', ','.join(filters), '-fps_mode', 'passthrough',
                     '-start_number', '0', str(frames_dir / '%08d.png')])
    images = sorted(frames_dir.glob('*.png'))
    if len(images) != len(selected):
        raise ValueError(f'Decoded count mismatch: expected {len(selected)}, got {len(images)}')
    for ordinal, (row, image_path) in enumerate(zip(selected, images)):
        destination = frames_dir / f"frame-{row['frame_index']:09d}.png"
        image_path.rename(destination)
        with Image.open(destination) as image:
            pixels = image.convert('RGB')
            pixel_hash = hashlib.sha256(pixels.tobytes()).hexdigest()
        row.update({'image': str(destination.relative_to(out)), 'image_sha256': digest(destination),
                    'pixel_sha256': pixel_hash, 'extraction_ordinal': ordinal})
    manifest = {'schema_version': 1, 'metadata': {key: value for key, value in metadata.items() if key != 'frames'},
                'stage': 'full' if full else 'pilot', 'start_ms': start_ms, 'end_ms': end_ms,
                'isolation': isolation, 'pilot_acceptance': str(Path(acceptance).resolve()) if acceptance else None,
                'frozen_calibration': gate['calibration'] if gate else None,
                'extraction_warnings': extracted.stderr.decode('utf-8', errors='replace'), 'frames': selected}
    write_json(out / 'video-index.json', metadata)
    write_json(out / 'manifest.json', manifest)
    return manifest


def load_acceptance(path, video_sha256, isolation):
    gate = read_json(path)
    analysis_path = Path(gate['analysis_path'])
    if not gate.get('accepted') or digest(analysis_path) != gate['analysis_sha256']:
        raise ValueError('Pilot acceptance is invalid or analysis changed')
    if digest(analysis_path.parent / 'review.html') != gate['review_html_sha256']:
        raise ValueError('Pilot visual review changed after acceptance')
    if gate.get('human_review_path') and digest(gate['human_review_path']) != gate['human_review_sha256']:
        raise ValueError('Human review changed after acceptance')
    analysis = read_json(analysis_path)
    manifest_path = Path(analysis['manifest_path'])
    if digest(manifest_path) != analysis['manifest_sha256']:
        raise ValueError('Pilot manifest changed')
    manifest = read_json(manifest_path)
    if manifest['stage'] != 'pilot' or manifest['metadata']['video_sha256'] != video_sha256:
        raise ValueError('Pilot belongs to another video/stage')
    if manifest['isolation'] != isolation:
        raise ValueError('Isolation differs from checked pilot')
    if not analysis.get('complete') or not analysis.get('calibration'):
        raise ValueError('Incomplete pilot cannot be accepted')
    return {'calibration': analysis['calibration'], 'review_basis': gate['review_basis']}


def sample_frames(frames, stride_ms):
    if not math.isfinite(stride_ms) or stride_ms < 0:
        raise ValueError('Invalid sampling stride')
    selected = [frames[0]]
    for row in frames[1:]:
        if row['timestamp_ms'] - selected[-1]['timestamp_ms'] >= stride_ms - 1e-6:
            selected.append(row)
    if selected[-1]['frame_index'] != frames[-1]['frame_index']:
        selected.append(frames[-1])
    return selected


def batches(frames, size, overlap):
    if size < 3 or overlap < 1 or overlap >= size:
        raise ValueError('Require 1 <= overlap < batch size and batch size >= 3')
    start = 0
    while start < len(frames):
        yield frames[start:start + size]
        if start + size >= len(frames):
            break
        start += size - overlap


def contact_sheet(frames, root, path):
    width, height, columns = 256, 190, 4
    canvas = Image.new('RGB', (width * columns, height * math.ceil(len(frames) / columns)), 'white')
    draw = ImageDraw.Draw(canvas)
    for index, row in enumerate(frames):
        left, top = (index % columns) * width, (index // columns) * height
        with Image.open(root / row['image']) as image:
            image = image.convert('RGB')
            image.thumbnail((width, height - 26))
            canvas.paste(image, (left, top + 25))
        draw.text((left + 4, top + 3), f"frame={row['frame_index']} t={row['timestamp_ms']:.3f}ms", fill='black')
    canvas.save(path)
