import json
from pathlib import Path
import sys
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_runner


class LockTests(unittest.TestCase):
    def test_second_lock_is_refused(self):
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            with goal_runner.goal_lock(home):
                with self.assertRaises(goal_runner.GoalBusy):
                    with goal_runner.goal_lock(home):
                        pass


class DecisionTests(unittest.TestCase):
    def test_decision_package_uses_reason_options_and_paths(self):
        state = {
            'goalId': 'g1', 'objective': 'ship it', 'attempts': [{}, {}],
            'wake': {'reason': 'budget_exhausted', 'question': '还要继续吗？', 'options': ['A. 加预算', 'B. 停']},
        }
        text = goal_runner.decision_markdown(state)
        self.assertIn('【需要你决定】D-g1-2-01', text)
        self.assertIn('budget_exhausted', text)
        self.assertIn('A. 加预算', text)
        self.assertIn('回复 A 或 B', text)

    def test_report_contains_time_and_token_cost(self):
        state = {
            'goalId': 'g', 'objective': 'x', 'status': 'done',
            'attempts': [{'verdict': 'pass', 'artifact': '/tmp/a.json'}],
            'wake': None,
            'cost': {'wallSeconds': 12.5, 'executorSeconds': 11.0, 'judgeSeconds': 0.2,
                     'attempts': 1, 'tokens': {'total': 321, 'cost': 0.0, 'steps': 2}},
        }
        text = goal_runner.report_markdown(state)
        self.assertIn('12.5s', text)
        self.assertIn('321 tok', text)
        self.assertIn('/tmp/a.json', text)

    def test_decision_package_has_defaults_for_whitelisted_reasons(self):
        state = {'goalId': 'g', 'objective': 'x', 'attempts': [{}],
                 'wake': {'reason': 'irreversible_action', 'question': '删掉旧数据？'}}
        text = goal_runner.decision_markdown(state)
        self.assertIn('A. 授权执行', text)
        self.assertIn('B. 换可逆方案或停止', text)


if __name__ == '__main__':
    unittest.main()
