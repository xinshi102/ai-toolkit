import json, os, tempfile, time, unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class LiveFixTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ['AI_COLLAB_DATA'] = str(Path(self.tmp.name) / 'data')
        self.root = Path(self.tmp.name) / 'runs'
        import importlib, inbox, suspend
        self.inbox = importlib.reload(inbox); self.suspend = suspend

    def tearDown(self):
        os.environ.pop('AI_COLLAB_DATA', None); self.tmp.cleanup()

    def pkg(self, name, ok, age=0, cont=None, failures=('tool_error',)):
        d = self.root / name; d.mkdir(parents=True)
        spec = {'task_id': name, 'prompt': 'p'}
        if cont: spec['continuation_of'] = cont
        (d / 'spec.json').write_text(json.dumps(spec), encoding='utf-8')
        rec = {'ok': ok, 'attempts': 3, 'failures': [] if ok else list(failures), 'session_id': 's'}
        (d / 'receipt.json').write_text(json.dumps(rec), encoding='utf-8')
        t = time.time() - age
        for f in d.iterdir(): os.utime(f, (t, t))
        os.utime(d, (t, t))
        return d

    def kinds(self):
        return [(i['kind'], i['id']) for i in self.inbox.collect([self.root])['items']]

    def test_old_failures_hidden(self):
        self.pkg('old-fail', False, age=10 * 86400)
        self.assertFalse([k for k in self.kinds() if k[0] == 'fail'])

    def test_failure_superseded_by_ok_continuation(self):
        self.pkg('f1', False)
        self.pkg('f1-c', True, cont='f1')
        self.assertNotIn(('fail', 'fail:f1'), self.kinds())

    def test_later_is_not_a_decision(self):
        if hasattr(self.suspend, 'record_later'):
            self.suspend.record_later({'later': {'after_minutes': 5, 'why': 'x'}}, package_dir=str(self.root), session_id='s')
            self.assertFalse([k for k in self.kinds() if k[0] == 'decide'])


if __name__ == '__main__':
    unittest.main()
