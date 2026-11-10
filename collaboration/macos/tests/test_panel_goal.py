import json
from pathlib import Path
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import panel_goal


class QueueTests(unittest.TestCase):
    def test_pop_queue_is_fifo(self):
        with tempfile.TemporaryDirectory() as home:
            Path(home, 'goals').mkdir()
            Path(home, 'goals', 'queue.jsonl').write_text(
                json.dumps({'objective': 'first'}) + '\n' + json.dumps({'objective': 'second'}) + '\n', encoding='utf-8')
            self.assertEqual(panel_goal.pop_queue(home)['objective'], 'first')
            self.assertEqual(panel_goal.pop_queue(home)['objective'], 'second')
            self.assertIsNone(panel_goal.pop_queue(home))


class PublishTests(unittest.TestCase):
    def test_publish_copies_done_artifact(self):
        with tempfile.TemporaryDirectory() as root:
            out = Path(root, 'out'); out.mkdir()
            artifact = Path(root, 'a.json'); artifact.write_text('{"ok": true}', encoding='utf-8')
            state = {'goalId': 'g', 'status': 'done', 'attempts': [{'artifact': str(artifact)}]}
            copied = panel_goal.publish(state, str(out))
            self.assertIsNotNone(copied)
            self.assertEqual(Path(copied).read_text(encoding='utf-8'), '{"ok": true}')
            self.assertEqual(Path(copied).name, 'g-a.json')

    def test_publish_skips_blocked(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(panel_goal.publish({'goalId': 'g', 'status': 'blocked'}, root))


if __name__ == '__main__':
    unittest.main()
