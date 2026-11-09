"""Tests for the local Codex token meter."""
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import token_meter


def _write(path: Path, events):
    with path.open('w', encoding='utf-8') as fh:
        for ev in events:
            fh.write(json.dumps(ev, ensure_ascii=False) + '\n')


def _token(ts, inp, cached, out, reason, total, primary=10, secondary=20):
    return {
        'timestamp': ts,
        'type': 'event_msg',
        'payload': {
            'type': 'token_count',
            'info': {
                'last_token_usage': {
                    'input_tokens': inp, 'cached_input_tokens': cached,
                    'output_tokens': out, 'reasoning_output_tokens': reason,
                },
                'total_token_usage': {'total_tokens': total},
            },
            'rate_limits': {
                'primary': {'used_percent': primary, 'resets_at': 1792562910, 'window_minutes': 300},
                'secondary': {'used_percent': secondary, 'resets_at': 1793082813, 'window_minutes': 10080},
            },
        },
    }


class TokenMeterTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'rollout-2026-10-21T09-00-00-test.jsonl'

    def tearDown(self):
        self.tmp.cleanup()

    def test_parse_and_summarize(self):
        _write(self.path, [
            {'timestamp': '2026-10-21T01:00:00Z', 'type': 'session_meta',
             'payload': {'id': 's1', 'cwd': 'E:/x'}},
            {'timestamp': '2026-10-21T01:00:01Z', 'type': 'turn_context',
             'payload': {'cwd': 'E:/x', 'model': 'gpt-test'}},
            _token('2026-10-21T01:06:00Z', 1000, 800, 50, 10, 1050, primary=10),
            _token('2026-10-21T01:07:00Z', 2000, 1500, 60, 20, 3110, primary=12),
        ])
        data = token_meter.parse_session(self.path)
        self.assertEqual(data['id'], 's1')
        self.assertEqual(data['cwd'], 'E:/x')
        self.assertEqual(data['model'], 'gpt-test')
        self.assertEqual(len(data['calls']), 2)
        self.assertEqual(data['calls'][0]['uncached'], 200)

        now = datetime(2026, 10, 21, 9, 30, tzinfo=timezone(timedelta(hours=8)))
        out = token_meter.summarize([data], now=now)
        self.assertEqual(out['periods']['last_5h']['calls'], 2)
        self.assertEqual(out['periods']['last_5h']['input'], 3000)
        self.assertEqual(out['periods']['last_5h']['cached'], 2300)
        self.assertEqual(out['periods']['last_5h']['uncached'], 700)
        self.assertEqual(out['periods']['last_5h']['output'], 110)
        self.assertEqual(out['periods']['last_5h']['reasoning'], 30)
        self.assertEqual(out['quota']['primary_used'], 12)
        self.assertEqual(out['quota']['secondary_used'], 20)
        self.assertEqual(out['recent'][0]['input'], 2000)
        self.assertEqual(out['sessions'][0]['session'], 's1')
        self.assertEqual(len(out['hourly']), 1)

    def test_duplicate_token_event_is_not_double_counted(self):
        event = _token('2026-10-21T01:06:00Z', 1000, 800, 50, 10, 1050)
        _write(self.path, [
            {'timestamp': '2026-10-21T01:00:00Z', 'type': 'session_meta',
             'payload': {'id': 's2', 'cwd': 'E:/x'}},
            event, event,
        ])
        data = token_meter.parse_session(self.path)
        self.assertEqual(len(data['calls']), 1)

    def test_missing_last_usage_falls_back_to_total_delta(self):
        _write(self.path, [
            {'timestamp': '2026-10-21T01:00:00Z', 'type': 'session_meta',
             'payload': {'id': 's3', 'cwd': 'E:/x'}},
            {'timestamp': '2026-10-21T01:05:00Z', 'type': 'event_msg',
             'payload': {'type': 'token_count',
                         'info': {'last_token_usage': {}, 'total_token_usage': {'total_tokens': 500}}}},
            {'timestamp': '2026-10-21T01:06:00Z', 'type': 'event_msg',
             'payload': {'type': 'token_count',
                         'info': {'last_token_usage': {}, 'total_token_usage': {'total_tokens': 900}}}},
        ])
        data = token_meter.parse_session(self.path)
        self.assertEqual([c['input'] for c in data['calls']], [500, 400])

    def test_formatting(self):
        self.assertEqual(token_meter.fmt(999), '999')
        self.assertEqual(token_meter.fmt(1500), '1.5k')
        self.assertEqual(token_meter.fmt(2_500_000), '2.50M')


if __name__ == '__main__':
    unittest.main()
