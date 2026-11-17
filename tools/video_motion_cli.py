"""Offline CLI. No imports of the bot runtime, injectors or live process readers."""

import argparse
import json
import os
import sys
from pathlib import Path

from video_motion.compare import compare
from video_motion.media import inspect_video, prepare, rectangle, write_json
from video_motion.pipeline import accept_pilot, analyze, review_human
from video_motion.vision import DEFAULT_MODEL, OpenAIVision, load_api_key


def parser():
    result = argparse.ArgumentParser(description='Independent offline visual stop/resume annotation')
    commands = result.add_subparsers(dest='command', required=True)
    inspect = commands.add_parser('inspect', help='Inspect real presentation timestamps without uploading anything')
    inspect.add_argument('--video', required=True)
    inspect.add_argument('--out', required=True)
    inspect.add_argument('--ffprobe', default='ffprobe')
    extract = commands.add_parser('prepare', help='Extract consecutive cropped/masked original frames')
    extract.add_argument('--video', required=True)
    extract.add_argument('--out', required=True)
    extract.add_argument('--roi', required=True, type=rectangle)
    extract.add_argument('--mask', action='append', default=[], type=rectangle)
    extract.add_argument('--confirm-isolation', action='store_true')
    extract.add_argument('--start-ms', type=float, default=0)
    extract.add_argument('--duration-ms', type=float, default=25000)
    extract.add_argument('--full-video', action='store_true')
    extract.add_argument('--pilot-acceptance')
    extract.add_argument('--ffmpeg', default='ffmpeg')
    extract.add_argument('--ffprobe', default='ffprobe')
    detect = commands.add_parser('analyze', help='API vision only; this command accepts NO JSONL or kind6 input')
    detect.add_argument('--manifest', required=True)
    detect.add_argument('--out', required=True)
    detect.add_argument('--model', default=os.environ.get('OPENAI_VISION_MODEL', DEFAULT_MODEL))
    detect.add_argument('--env-file', help='Optional local file; read only OPENAI_API_KEY, never print it')
    detect.add_argument('--stride-ms', type=float, default=100)
    detect.add_argument('--batch-size', type=int, default=96)
    detect.add_argument('--overlap', type=int, default=24)
    detect.add_argument('--calibration-start-ms', type=float)
    detect.add_argument('--calibration-duration-ms', type=float, default=2000)
    detect.add_argument('--stop-min-ms', type=float)
    detect.add_argument('--context-ms', type=float, default=800)
    detect.add_argument('--max-requests', type=int, default=80)
    detect.add_argument('--max-images', type=int, default=6000)
    detect.add_argument('--api-timeout', type=float, default=90)
    detect.add_argument('--retries', type=int, default=1)
    approve = commands.add_parser('accept-pilot', help='Record explicit review of the pilot before full-video work')
    approve.add_argument('--analysis', required=True)
    approve.add_argument('--out', required=True)
    approve.add_argument('--reviewer', required=True)
    approve.add_argument('--basis', choices=['human', 'automatic-only'], required=True)
    approve.add_argument('--notes', required=True)
    approve.add_argument('--human-review')
    review = commands.add_parser('review-human', help='Compare independent human annotations and record missed/extra automatic events')
    review.add_argument('--analysis', required=True)
    review.add_argument('--annotations', required=True)
    review.add_argument('--out', required=True)
    review.add_argument('--tolerance-ms', type=float, default=250)
    evaluate = commands.add_parser('compare', help='ONLY here read holding, after visual annotation is frozen')
    evaluate.add_argument('--analysis', required=True)
    evaluate.add_argument('--jsonl', required=True)
    evaluate.add_argument('--session', required=True)
    evaluate.add_argument('--out', required=True)
    evaluate.add_argument('--tolerance-ms', type=float, default=1000)
    evaluate.add_argument('--max-sync-error-ms', type=float, default=33)
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == 'inspect':
            result = inspect_video(args.video, args.ffprobe)
            write_json(args.out, result)
            print(json.dumps({key: result[key] for key in ('duration_ms', 'width', 'height', 'frame_count', 'avg_frame_rate', 'variable_frame_timing', 'anomalies')}))
        elif args.command == 'prepare':
            result = prepare(args.video, args.out, args.roi, args.mask, args.start_ms, args.duration_ms,
                             args.confirm_isolation, args.full_video, args.pilot_acceptance, args.ffmpeg, args.ffprobe)
            print(json.dumps({'stage': result['stage'], 'frames': len(result['frames']),
                              'manifest': str(Path(args.out) / 'manifest.json')}))
        elif args.command == 'analyze':
            key = load_api_key(args.env_file)
            client = OpenAIVision(key, args.model, Path(args.out) / 'requests', args.max_requests,
                                  args.max_images, args.api_timeout, args.retries)
            result = analyze(args.manifest, args.out, client, args.stride_ms, args.batch_size, args.overlap,
                             args.calibration_start_ms, args.calibration_duration_ms, args.stop_min_ms, args.context_ms)
            print(json.dumps({'events': len(result['events']), 'review_status': result['review_status'],
                              'api_calls': result['api_calls_this_run']}))
        elif args.command == 'accept-pilot':
            result = accept_pilot(args.analysis, args.out, args.reviewer, args.basis, args.notes, args.human_review)
            print(json.dumps({'accepted': result['accepted'], 'human_validated': result['human_validated']}))
        elif args.command == 'review-human':
            result = review_human(args.analysis, args.annotations, args.out, args.tolerance_ms)
            print(json.dumps({'missed': len(result['errors']['missed_by_automatic']),
                              'extra': len(result['errors']['extra_automatic'])}))
        else:
            result = compare(args.analysis, args.jsonl, args.session, args.out, args.tolerance_ms, args.max_sync_error_ms)
            print(json.dumps({'pairs': len(result['pairs']), 'unmatched_visual': len(result['unmatched_visual']),
                              'unmatched_holding': len(result['unmatched_holding']), 'sync': result['sync']}))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        if args.command == 'analyze' and not (Path(args.out) / 'analysis.json').exists():
            write_json(Path(args.out) / 'status.json', {'complete': False, 'status': 'blocked', 'reason': str(error)})
        print('BLOCKED: ' + str(error), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
