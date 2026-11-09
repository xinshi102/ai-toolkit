import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_executor_hermes as hermes


class FakeProc:
    returncode = 0
    stdout = 'ok'
    stderr = ''


def fake_run(command, capture_output=True, text=True, timeout=240, cwd=None):
    Path(cwd, 'ping.json').write_text(json.dumps({'nonce': 'n', 'harness': 'hermes', 'ok': True}), encoding='utf-8')
    return FakeProc()


class HermesExecutorTests(unittest.TestCase):
    def test_brief_and_artifact(self):
        goal = {'objective': 'write ping.json', 'required_keys': ['nonce', 'harness', 'ok'], 'artifact': 'ping.json'}
        with tempfile.TemporaryDirectory() as workspace, mock.patch.object(hermes.subprocess, 'run', fake_run):
            result = hermes.executor_for(goal)({'workspace': workspace, 'attempt': 1, 'defects': []})
            self.assertTrue(Path(workspace, 'goal-brief.json').is_file())
            self.assertEqual(Path(result['artifact']).name, 'ping.json')
            self.assertEqual(json.loads(Path(result['artifact']).read_text())['harness'], 'hermes')


if __name__ == '__main__':
    unittest.main()
