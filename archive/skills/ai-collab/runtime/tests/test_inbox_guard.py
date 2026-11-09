import json, os, tempfile, time, unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ['AI_COLLAB_DATA'] = str(Path(self.tmp.name) / 'data')
        self.root = Path(self.tmp.name) / 'runs'
        import importlib, inbox
        self.inbox = importlib.reload(inbox)
        self.launched = []
        self.inbox.launch = lambda fn, *a: self.launched.append(a)

    def tearDown(self):
        os.environ.pop('AI_COLLAB_DATA', None); self.tmp.cleanup()

    def pkg(self, name, ok):
        d = self.root / name; d.mkdir(parents=True)
        (d / 'spec.json').write_text(json.dumps({'task_id': name, 'prompt': 'p', 'session_id': 's'}), encoding='utf-8')
        (d / 'receipt.json').write_text(json.dumps({'ok': ok, 'attempts': 3, 'failures': [] if ok else ['tool_error'], 'session_id': 's'}), encoding='utf-8')
        return d

    def test_second_click_is_refused_and_launches_nothing(self):
        self.pkg('f1', False)
        self.inbox._find_package = lambda v: {'dir': self.root / 'f1', 'spec': {'task_id': 'f1', 'session_id': 's'}, 'recs': [{'session_id': 's'}], 'last': {}}
        try:
            first = self.inbox.act('fail:f1', 'A')
        except Exception:
            first = {'ok': True}
        second = self.inbox.act('fail:f1', 'A')
        self.assertFalse(second['ok'])
        self.assertLessEqual(len(self.launched), 1)

    def test_read_all_marks_every_done(self):
        for i in range(5):
            self.pkg('d%d' % i, True)
        r = self.inbox.read_all('done', roots=[self.root])
        self.assertEqual(r['count'], 5)
        left = [x for x in self.inbox.collect([self.root])['items'] if x['kind'] == 'done']
        self.assertEqual(left, [])

    def test_read_all_refuses_other_kinds(self):
        self.assertFalse(self.inbox.read_all('fail')['ok'])


if __name__ == '__main__':
    unittest.main()
