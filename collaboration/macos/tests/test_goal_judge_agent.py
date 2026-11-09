import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_judge


def fake_run(verdict='pass', defects=None):
    def run(directory, model, prefix='judge', timeout=120):
        Path(directory, 'judge-design.json').write_text(
            json.dumps({'verdict': verdict, 'defects': defects or []}), encoding='utf-8')
        return {}
    return run


class AgentJudgeTests(unittest.TestCase):
    def context(self, root, ok=True):
        artifact = Path(root) / 'artifact.json'
        artifact.write_text('{"ok": true}', encoding='utf-8')
        command = 'python3 -c "import json,sys; sys.exit(0 if json.load(open(\'artifact.json\'))[\'ok\'] else 3)"'
        return {'workspace': root, 'result': {'artifact': str(artifact)},
                'goal': {'checks': [{'command': command}], 'subjective': ['文案是否清楚']}}

    def test_agent_judge_returns_model_verdict(self):
        with tempfile.TemporaryDirectory() as root, mock.patch.object(goal_judge.opencode_adapter, 'run', fake_run()):
            goal = {'acceptance': ['a'], 'subjective': ['文案清楚']}
            verdict = goal_judge.agent_judge(goal)({'workspace': root, 'result': {}})
            self.assertEqual(verdict['verdict'], 'pass')

    def test_hybrid_does_not_ask_agent_when_checks_fail(self):
        with tempfile.TemporaryDirectory() as root:
            goal = {'checks': [{'command': 'python3 -c "import sys; sys.exit(3)"'}], 'subjective': ['x']}
            context = {'workspace': root, 'result': {}}
            with mock.patch.object(goal_judge.opencode_adapter, 'run') as run:
                verdict = goal_judge.hybrid_judge(goal)(context)
                run.assert_not_called()
            self.assertEqual(verdict['verdict'], 'reject')

    def test_hybrid_escalates_when_checks_pass(self):
        with tempfile.TemporaryDirectory() as root:
            context = self.context(root)
            with mock.patch.object(goal_judge.opencode_adapter, 'run', side_effect=fake_run()) as run:
                verdict = goal_judge.hybrid_judge({'checks': [{'command': 'true'}], 'subjective': ['文案']})(context)
                self.assertEqual(run.call_count, 1)
            self.assertEqual(verdict['verdict'], 'pass')


if __name__ == '__main__':
    unittest.main()
