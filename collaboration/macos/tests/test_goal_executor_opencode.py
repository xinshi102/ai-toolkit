import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_executor_opencode as executor_module


def fake_run(directory, model, prefix='goal', timeout=150):
    Path(directory, 'goal-design.json').write_text(json.dumps({'nonce': 'n', 'answer': 42}), encoding='utf-8')
    return {'model': model, 'exit_code': 0, 'accepted': True, 'session_ids': ['s']}


class ExecutorTests(unittest.TestCase):
    def goal(self):
        return {
            'goalId': 'g', 'objective': 'write answer 42',
            'required_keys': ['nonce', 'answer'], 'robust_keys': ['verified'],
            'retry_note': 'Also include verified set to true.',
        }

    def test_first_attempt_brief_has_no_retry_material(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(executor_module.opencode_adapter, 'run', fake_run):
            result = executor_module.executor_for(self.goal())({'workspace': root, 'attempt': 1, 'defects': []})
            brief = json.loads(Path(root, 'goal-brief.json').read_text(encoding='utf-8'))
            self.assertEqual(brief['required_keys'], ['nonce', 'answer'])
            self.assertNotIn('verified', brief['task'])
            self.assertEqual(result['artifact'], str(Path(root, 'goal-design.json')))

    def test_retry_brief_carries_defects_and_extra_keys(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(executor_module.opencode_adapter, 'run', fake_run):
            executor_module.executor_for(self.goal())({'workspace': root, 'attempt': 2, 'defects': ['verified must be true']})
            brief = json.loads(Path(root, 'goal-brief.json').read_text(encoding='utf-8'))
            self.assertEqual(brief['required_keys'], ['nonce', 'answer', 'verified'])
            self.assertIn('verified must be true', brief['task'])
            self.assertIn('Also include verified set to true.', brief['task'])


if __name__ == '__main__':
    unittest.main()
