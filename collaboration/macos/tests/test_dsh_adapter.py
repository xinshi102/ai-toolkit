import importlib.util
from pathlib import Path
import tempfile
import unittest
import json
spec = importlib.util.spec_from_file_location('dsh_adapter', Path(__file__).parents[1] / 'dsh_adapter.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Tests(unittest.TestCase):
    def test_traversal(self):
        for value in ('../x', '/tmp/x', 'x/y', '..', 'x\\y', ''):
            with self.assertRaises(ValueError): m.filename(value)

    def test_no_overwrite_or_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            d = Path(root)
            (d/'brief.json').write_text(json.dumps({'nonce':'n','required_keys':[]}))
            (d/'out.json').write_text('existing')
            with self.assertRaises(FileExistsError): m.run(d,'brief.json','out.json')
            (d/'out.json').unlink()
            (d/'out.json').symlink_to(d/'missing')
            with self.assertRaises(FileExistsError): m.run(d,'brief.json','out.json')

    def test_invalid_brief(self):
        with tempfile.TemporaryDirectory() as root:
            d = Path(root)
            (d/'brief.json').write_text(json.dumps({'nonce':'n','required_keys':'bad'}))
            with self.assertRaises(ValueError): m.run(d,'brief.json','out.json')

if __name__ == '__main__': unittest.main()
