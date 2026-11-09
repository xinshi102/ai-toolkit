import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_executor_dsh


def fake_run(directory, brief, output, timeout=300, shared=True, **kwargs):
    Path(directory, output).write_text(json.dumps({'nonce': 'n', 'ok': True}), encoding='utf-8')
    return {'model': 'DeepSeek-Flash', 'exit_code': 0, 'accepted': True, 'session_id': 'session-x'}


class DshExecutorTests(unittest.TestCase):
    def test_artifact_and_brief_are_written(self):
        goal = {'objective': 'write hello.json', 'required_keys': ['nonce', 'ok'], 'artifact': 'hello.json'}
        with tempfile.TemporaryDirectory() as workspace, mock.patch.object(goal_executor_dsh.dsh_adapter, 'run', fake_run):
            result = goal_executor_dsh.executor_for(goal)({'workspace': workspace, 'attempt': 1, 'defects': []})
            brief = json.loads(Path(workspace, 'goal-brief.json').read_text(encoding='utf-8'))
            self.assertEqual(brief['required_keys'], ['nonce', 'ok'])
            self.assertEqual(Path(result['artifact']).name, 'hello.json')
            self.assertEqual(json.loads(Path(result['artifact']).read_text())['ok'], True)
            self.assertIsNone(result['usage'])


if __name__ == '__main__':
    unittest.main()
