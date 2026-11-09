import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_executor_codex as codex


class FakeProc:
    returncode = 0
    stdout = 'ok'
    stderr = ''


def fake_run(command, capture_output=True, text=True, timeout=180, **kwargs):
    workspace = Path(command[command.index('--cd') + 1])
    workspace.joinpath('ping.json').write_text(json.dumps({'nonce': 'n', 'harness': 'codex', 'ok': True}), encoding='utf-8')
    return FakeProc()


class CodexExecutorTests(unittest.TestCase):
    def test_brief_and_artifact(self):
        goal = {'objective': 'write ping.json', 'required_keys': ['nonce', 'harness', 'ok'], 'artifact': 'ping.json'}
        with tempfile.TemporaryDirectory() as workspace, mock.patch.object(codex.subprocess, 'run', fake_run):
            result = codex.executor_for(goal)({'workspace': workspace, 'attempt': 1, 'defects': []})
            brief = json.loads(Path(workspace, 'goal-brief.json').read_text(encoding='utf-8'))
            self.assertEqual(brief['required_keys'], ['nonce', 'harness', 'ok'])
            self.assertEqual(Path(result['artifact']).name, 'ping.json')
            self.assertTrue(result['evidence'][0]['exit_code'] == 0)


if __name__ == '__main__':
    unittest.main()
