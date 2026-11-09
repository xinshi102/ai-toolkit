import json
from pathlib import Path
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_quota


def write_quota(home, rows):
    Path(home, 'console-quota.json').write_text(json.dumps({'rows': rows}), encoding='utf-8')


class QuotaTests(unittest.TestCase):
    def test_missing_snapshot_is_not_hot(self):
        with tempfile.TemporaryDirectory() as home:
            self.assertTrue(goal_quota.check(home)['ok'])

    def test_hot_row_blocks_new_work(self):
        with tempfile.TemporaryDirectory() as home:
            write_quota(home, [{'agent': 'Codex', 'pct_used': 97, 'period': '5h'}])
            result = goal_quota.check(home)
            self.assertFalse(result['ok'])
            self.assertEqual(result['hot'][0]['agent'], 'Codex')

    def test_below_limit_passes(self):
        with tempfile.TemporaryDirectory() as home:
            write_quota(home, [{'agent': 'Codex', 'pct_used': 24, 'period': 'week'}])
            self.assertTrue(goal_quota.check(home)['ok'])


if __name__ == '__main__':
    unittest.main()
