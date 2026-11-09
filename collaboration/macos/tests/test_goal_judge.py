import json
from pathlib import Path
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_judge


class CommandJudgeTests(unittest.TestCase):
    def goal(self, command, desc='check'):
        return {'checks': [{'command': command, 'desc': desc}]}

    def test_pass_when_every_check_exits_zero(self):
        with tempfile.TemporaryDirectory() as workspace:
            judge = goal_judge.command_judge(self.goal('python3 -c "print(1)"'))
            verdict = judge({'goal': {}, 'attempt': 1, 'result': {}, 'workspace': workspace})
            self.assertEqual(verdict['verdict'], 'pass')

    def test_reject_lists_command_exit_and_output_tail(self):
        with tempfile.TemporaryDirectory() as workspace:
            judge = goal_judge.command_judge(self.goal('python3 -c "import sys; sys.exit(3)"', 'answer is 42'))
            verdict = judge({'goal': {}, 'attempt': 1, 'result': {}, 'workspace': workspace})
            self.assertEqual(verdict['verdict'], 'reject')
            self.assertIn('answer is 42', verdict['defects'][0])
            self.assertIn('exit 3', verdict['defects'][0])

    def test_checks_run_inside_the_attempt_workspace(self):
        with tempfile.TemporaryDirectory() as workspace:
            Path(workspace, 'artifact.json').write_text('{"ok": true}', encoding='utf-8')
            judge = goal_judge.command_judge(self.goal(
                'python3 -c "import json; assert json.load(open(\'artifact.json\'))[\'ok\'] is True"'))
            verdict = judge({'goal': {}, 'attempt': 1, 'result': {}, 'workspace': workspace})
            self.assertEqual(verdict['verdict'], 'pass')


if __name__ == '__main__':
    unittest.main()
