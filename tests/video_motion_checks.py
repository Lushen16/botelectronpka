"""Contract and media integration tests; API responses here are explicit test doubles."""

import copy
import hashlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))

from video_motion.compare import compare, decode_kind6, pair_events
from video_motion.media import (batches, digest, inspect_video, load_acceptance, prepare,
                                read_json, run, sample_frames, write_json)
from video_motion.pipeline import (accept_pilot, analyze, consolidate, overlap_conflicts,
                                   recording_ambiguities, review_human)
from video_motion.vision import (DEFAULT_MODEL, OpenAIVision, build_request, load_api_key,
                                validate_observation)


def rows_for(times):
    return [{'frame_index': index, 'timestamp_ms': value, 'pts_ms': value,
             'pixel_sha256': str(index)} for index, value in enumerate(times)]


def event(rows, kind='stop'):
    return {'event_id': 'fixture-event', 'event_type': kind,
            'earliest_ms': rows[1]['timestamp_ms'], 'latest_ms': rows[2]['timestamp_ms'],
            'frame_before': rows[1]['frame_index'], 'frame_after': rows[2]['frame_index'],
            'evidence_frames': [row['frame_index'] for row in rows],
            'reason': 'Synthetic visual response; not a real model judgment',
            'review_required': False, 'confidence': .99}


def segment(rows, state='moving'):
    return {'state': state, 'frame_before': rows[0]['frame_index'], 'frame_after': rows[-1]['frame_index'],
            'evidence_frames': [rows[0]['frame_index'], rows[-1]['frame_index']],
            'reason': 'Test-double continuous segment', 'review_required': False}


class SyntheticVision:
    model = 'TEST-DOUBLE-NOT-OPENAI'

    def __init__(self):
        self.requests, self.images, self.calls = 0, 0, []

    def call(self, root, rows, purpose, context):
        self.requests += 1
        self.images += len(rows)
        self.calls.append({'purpose': purpose, 'context': context, 'frames': rows})
        if purpose == 'calibration':
            return {'step_intervals': [
                {'frame_before': rows[0]['frame_index'], 'frame_after': rows[2]['frame_index'], 'reason': 'Fixture interval'},
                {'frame_before': rows[2]['frame_index'], 'frame_after': rows[4]['frame_index'], 'reason': 'Fixture interval'}],
                'evidence_frames': [row['frame_index'] for row in rows[:5]],
                'reason': 'Synthetic calibration for pipeline tests only', 'review_required': False}
        events = []
        for when, kind in [(5000, 'stop'), (9000, 'resume')]:
            before = [row for row in rows if row['timestamp_ms'] < when]
            after = [row for row in rows if row['timestamp_ms'] >= when]
            if before and after:
                events.append({'event_id': 'mock-' + kind, 'event_type': kind,
                    'earliest_ms': before[-1]['timestamp_ms'], 'latest_ms': after[0]['timestamp_ms'],
                    'frame_before': before[-1]['frame_index'], 'frame_after': after[0]['frame_index'],
                    'evidence_frames': [row['frame_index'] for row in rows],
                    'reason': 'MOCK boundary; no visual inference or API call performed',
                    'review_required': False, 'confidence': None})
        return {'events': events, 'segments': [segment(rows)]}


class MotionContractTests(unittest.TestCase):
    def test_timestamp_sampling_and_tail(self):
        rows = rows_for([0, 33, 71, 105, 160, 220, 250])
        selected = sample_frames(rows, 100)
        self.assertEqual([row['timestamp_ms'] for row in selected], [0, 105, 220, 250])

    def test_batch_overlap_covers_all_original_ids(self):
        rows = rows_for(range(30))
        parts = list(batches(rows, 10, 4))
        self.assertEqual({row['frame_index'] for part in parts for row in part}, set(range(30)))
        self.assertEqual(parts[0][-4:], parts[1][:4])

    def test_unknown_frame_and_false_timestamp_are_rejected(self):
        rows = rows_for([0, 100, 200, 300, 400, 500])
        for change in ({'frame_after': 88}, {'latest_ms': 201}, {'evidence_frames': [0, 99]}):
            item = event(rows)
            item.update(change)
            with self.assertRaises(ValueError):
                validate_observation({'events': [item], 'segments': [segment(rows)]}, rows, 200)

    def test_missing_coverage_is_rejected(self):
        rows = rows_for([0, 100, 200, 300])
        with self.assertRaises(ValueError):
            validate_observation({'events': [], 'segments': [segment(rows[1:])]}, rows, 100)

    def test_inadequate_stop_confirmation_requires_review(self):
        rows = rows_for([0, 100, 200, 300])
        result = validate_observation({'events': [event(rows)], 'segments': [segment(rows)]}, rows, 200)
        self.assertTrue(result['events'][0]['review_required'])

    def test_duplicate_events_merge_and_conflicts_survive(self):
        rows = rows_for([0, 100, 200, 400, 600])
        original = event(rows)
        opposite = event(rows, 'resume')
        merged = consolidate([original, copy.deepcopy(original), opposite])
        self.assertEqual(len(merged), 2)
        self.assertTrue(all(item['review_required'] and item['conflicts_with'] for item in merged))

    def test_identical_pixels_are_not_evidence_of_a_stop(self):
        rows = rows_for([0, 100, 200, 300, 400])
        for row in rows:
            row['pixel_sha256'] = 'same-pixels'
        ambiguous = recording_ambiguities(rows, 250, [])
        self.assertEqual(len(ambiguous), 1)
        self.assertEqual(ambiguous[0]['event_type'], 'indeterminate')

    def test_disagreement_in_overlapping_batches_is_preserved(self):
        rows = rows_for([0, 100, 200, 300, 400])
        conflicts = overlap_conflicts([segment(rows[:4], 'moving'), segment(rows[1:], 'stopped')], rows)
        self.assertEqual(len(conflicts), 1)
        self.assertEqual(conflicts[0]['event_type'], 'indeterminate')
        self.assertTrue(conflicts[0]['review_required'])

    def test_decode_reuses_existing_hex_kind6_contract(self):
        payload = {'luring': {'holding': True, 'mode': 'dynamic'}}
        line = json.dumps({'kind': 6, 't': 123, 'd': json.dumps(payload).encode().hex()})
        self.assertEqual(decode_kind6(line)['payload'], payload)
        self.assertIsNone(decode_kind6('{"kind":5}'))

    def test_one_to_one_matching_keeps_unmatched_visual_motion(self):
        first = {'event_id': 'v1', 'event_type': 'stop', 'earliest_ms': 100, 'latest_ms': 120}
        second = dict(first, event_id='v2', earliest_ms=500, latest_ms=520)
        reference = dict(first, event_id='r1', publication_ms=150)
        result = pair_events([first, second], [reference], 1000)
        self.assertEqual(len(result['pairs']), 1)
        self.assertEqual(len(result['unmatched_visual']), 1)

    def test_missing_key_does_not_trigger_network(self):
        with patch.dict(os.environ, {}, clear=True), patch('urllib.request.urlopen') as network:
            self.assertIsNone(load_api_key())
            with self.assertRaisesRegex(ValueError, 'Missing OPENAI_API_KEY'):
                OpenAIVision(None)
            network.assert_not_called()

    def test_secret_file_reads_only_explicit_openai_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '.env'
            path.write_text('DEPLOY_API_KEY=not-openai\nOPENAI_API_KEY="test-not-a-real-secret"\n')
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(load_api_key(path), 'test-not-a-real-secret')


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg and ffprobe required')
class MotionMediaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        output = os.environ.get('VIDEO_MOTION_TEST_OUTPUT')
        cls.temporary = None
        if output:
            base = Path(output).resolve()
            base.mkdir(parents=True, exist_ok=True)
            cls.root = Path(tempfile.mkdtemp(prefix='synthetic-', dir=base))
        else:
            cls.temporary = tempfile.TemporaryDirectory()
            cls.root = Path(cls.temporary.name)
        cls.video = cls.root / 'SYNTHETIC-NOT-POKEALLIANCE.mkv'
        run(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i',
             'testsrc2=size=256x160:rate=10:duration=25', '-vf', 'setpts=PTS+2/TB',
             '-c:v', 'ffv1', str(cls.video)])
        cls.manifest = prepare(cls.video, cls.root / 'pilot', [0, 0, 200, 140],
                               [[170, 0, 30, 30]], confirmed=True)
        cls.manifest_path = cls.root / 'pilot' / 'manifest.json'

    @classmethod
    def tearDownClass(cls):
        if cls.temporary:
            cls.temporary.cleanup()

    def test_extraction_maps_original_pts_and_preserves_crop(self):
        rows = self.manifest['frames']
        self.assertEqual(len(rows), 250)
        self.assertEqual(rows[0]['timestamp_ms'], 0)
        self.assertAlmostEqual(rows[0]['pts_ms'], 2000)
        self.assertEqual(rows[-1]['frame_index'], 249)
        image_path = self.root / 'pilot' / rows[0]['image']
        with Image.open(image_path) as image:
            self.assertEqual(image.size, (200, 140))
            self.assertEqual(image.convert('RGB').getpixel((180, 10)), (0, 0, 0))

    def test_vfr_is_not_resampled_into_cfr(self):
        video = self.root / 'variable.mkv'
        run(['ffmpeg', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i',
             'testsrc2=size=64x64:rate=10:duration=2', '-vf', r'select=not(eq(n\,5))',
             '-fps_mode', 'passthrough', '-c:v', 'ffv1', str(video)])
        result = inspect_video(video)
        self.assertEqual(result['frame_count'], 19)
        self.assertTrue(result['variable_frame_timing'])
        times = [row['timestamp_ms'] for row in result['frames']]
        self.assertTrue(any(after - before == 200 for before, after in zip(times, times[1:])))

    def test_isolation_confirmation_is_mandatory(self):
        with self.assertRaisesRegex(ValueError, 'isolation'):
            prepare(self.video, self.root / 'unsafe', [0, 0, 200, 140])

    def test_request_contains_explicit_frame_ids_times_and_only_crops(self):
        rows = self.manifest['frames'][:5]
        request = build_request(self.manifest_path.parent, rows, DEFAULT_MODEL, 'detection', {'stop_min_ms': 300})
        content = request['input'][0]['content']
        texts = [part['text'] for part in content if part['type'] == 'input_text']
        self.assertTrue(any('frame_id=0 timestamp_ms=0.000000' in text for text in texts))
        self.assertEqual(len([part for part in content if part['type'] == 'input_image']), 5)
        self.assertFalse(request['store'])
        self.assertNotIn('jsonl', json.dumps(request))

    def test_api_contract_cache_and_budget_without_network(self):
        rows = self.manifest['frames'][:6]
        model_result = {'events': [], 'segments': [segment(rows)]}

        class Response:
            headers = {'x-request-id': 'synthetic-request'}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def read(self):
                return json.dumps({'status': 'completed', 'id': 'mock', 'model': DEFAULT_MODEL,
                    'output': [{'content': [{'type': 'output_text', 'text': json.dumps(model_result)}]}]}).encode()

        cache = self.root / 'http-test-cache'
        client = OpenAIVision('fake-test-key', cache=cache, max_requests=1, max_images=6)
        with patch('urllib.request.urlopen', return_value=Response()) as network:
            self.assertEqual(client.call(self.manifest_path.parent, rows, 'detection', {}), model_result)
            self.assertEqual(client.call(self.manifest_path.parent, rows, 'detection', {}), model_result)
            self.assertEqual(network.call_count, 1)
            sent = network.call_args.args[0]
            self.assertEqual(sent.full_url, 'https://api.openai.com/v1/responses')
            self.assertNotIn('fake-test-key', next(cache.glob('*.json')).read_text())
            with self.assertRaisesRegex(ValueError, 'budget'):
                client.call(self.manifest_path.parent, rows, 'detection', {'different': True})
            self.assertEqual(network.call_count, 1)

    def test_pilot_refinement_review_and_comparison_end_to_end(self):
        client = SyntheticVision()
        out = self.root / 'annotation'
        analysis = analyze(self.manifest_path, out, client)
        self.assertTrue(analysis['complete'])
        self.assertEqual(analysis['review_status'], 'automatic-not-human-validated')
        self.assertFalse(analysis['kind6_used_for_detection'])
        self.assertEqual({item['event_type'] for item in analysis['events']}, {'stop', 'resume'})
        self.assertTrue(any(call['purpose'] == 'refinement' for call in client.calls))
        for call in client.calls:
            if call['purpose'] == 'refinement':
                ids = [row['frame_index'] for row in call['frames']]
                self.assertTrue(all(after == before + 1 for before, after in zip(ids, ids[1:])))
        self.assertTrue((out / 'review.html').exists())
        self.assertTrue(list(out.glob('evidence-*.jpg')))
        self.assertEqual(analysis['coverage']['coarse_frame_count'], 250)
        gate_path = self.root / 'acceptance.json'
        gate = accept_pilot(out / 'analysis.json', gate_path, 'AUTOMATED TEST', 'automatic-only',
                            'Synthetic plumbing test, no human review, no game accuracy claim')
        self.assertFalse(gate['human_validated'])
        load_acceptance(gate_path, digest(self.video), self.manifest['isolation'])
        with self.assertRaises(ValueError):
            load_acceptance(gate_path, 'other-video', self.manifest['isolation'])
        with self.assertRaisesRegex(ValueError, 'requires a matching'):
            accept_pilot(out / 'analysis.json', self.root / 'invalid-human-gate.json', 'test', 'human', 'No annotation supplied')
        human_path = self.root / 'SYNTHETIC-human-annotations.json'
        write_json(human_path, {'video_sha256': digest(self.video), 'reviewer': 'TEST DOUBLE, NOT A HUMAN',
                               'events': [analysis['events'][0]]})
        human_result = review_human(out / 'analysis.json', human_path, self.root / 'human-diff.json')
        self.assertEqual(len(human_result['errors']['extra_automatic']), 1)
        full = prepare(self.video, self.root / 'full', [0, 0, 200, 140], [[170, 0, 30, 30]],
                       confirmed=True, full=True, acceptance=gate_path)
        self.assertEqual(full['stage'], 'full')
        self.assertEqual(full['frozen_calibration'], analysis['calibration'])
        full_client = SyntheticVision()
        full_analysis = analyze(self.root / 'full' / 'manifest.json', self.root / 'full-annotation', full_client)
        self.assertTrue(full_analysis['coverage']['all_video_covered'])
        self.assertFalse(any(call['purpose'] == 'calibration' for call in full_client.calls))

        records = []
        for timestamp in range(0, 25000, 100):
            payload = {'paused': False, 'luring': {'mode': 'dynamic', 'holding': 5000 <= timestamp < 9000}}
            records.append({'kind': 6, 't': 100000 + timestamp, 'd': json.dumps(payload).encode().hex()})
        log = self.root / 'SYNTHETIC-kind6.jsonl'
        log.write_text(''.join(json.dumps(row) + '\n' for row in records), encoding='utf-8')
        session = {'video_sha256': digest(self.video), 'jsonl_sha256': digest(log),
                   'same_session_confirmed': True, 'session_id': 'SYNTHETIC-TEST-ONLY',
                   'evidence': 'Fabricated matching clocks for software integration testing only',
                   'markers': [{'id': name, 'frame_index': frame_index, 'log_line': frame_index + 1,
                                'log_t_ms': 100000 + frame_index * 100,
                                'description': 'Synthetic marker, not observed in a game'}
                               for name, frame_index in [('A', 0), ('B', 125), ('C', 249)]]}
        session_path = self.root / 'session.json'
        write_json(session_path, session)
        comparison = compare(out / 'analysis.json', log, session_path, self.root / 'comparison.json')
        self.assertEqual(len(comparison['pairs']), 2)
        self.assertEqual(comparison['sync']['held_out_B_error_ms'], 0)
        self.assertEqual(len(comparison['unmatched_visual']), 0)
        session['markers'][1]['log_t_ms'] += 100
        write_json(session_path, session)
        with self.assertRaisesRegex(ValueError, 'Synchronization rejected'):
            compare(out / 'analysis.json', log, session_path, self.root / 'invalid.json')
        print('Synthetic evidence retained at: ' + str(self.root))


if __name__ == '__main__':
    unittest.main(verbosity=2)
