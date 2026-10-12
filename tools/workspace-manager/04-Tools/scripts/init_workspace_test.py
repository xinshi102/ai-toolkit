import json
import tempfile
import unittest
import subprocess
import sys
from pathlib import Path
from init_workspace import initialize


class InitializationTests(unittest.TestCase):
    def test_empty_workspace_and_existing_data(self):
        with tempfile.TemporaryDirectory() as temp:
            skills = Path(temp)/'技能'; skills.mkdir()
            root=Path(temp)/'工作区'
            initialize(root, skills)
            manifest=json.loads((root/'08-System/manifests/harnesses.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['harnesses'][0]['domain'],'personal')
            registry=root/'08-System/inventory/registry.json'
            before=registry.read_bytes()
            with self.assertRaises(ValueError): initialize(root, skills)
            self.assertEqual(registry.read_bytes(),before)
            self.assertTrue((root/'04-Tools/scripts/file_lock.py').is_file())
            run=subprocess.run([sys.executable,str(root/'04-Tools/scripts/manager.py'),'report'],capture_output=True,text=True,encoding='utf-8')
            self.assertEqual(run.returncode,0,run.stdout+run.stderr)
            dashboard=(root/'00-HOME/DASHBOARD.md').read_text(encoding='utf-8')
            self.assertIn('UNVERIFIED',dashboard)
            self.assertNotIn('/Users/xinshi',dashboard)


if __name__=='__main__': unittest.main()
