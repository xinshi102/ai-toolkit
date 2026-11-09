import json
from pathlib import Path
import sys
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_runner


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

    def test_decision_package_has_defaults_for_whitelisted_reasons(self):
        state = {'goalId': 'g', 'objective': 'x', 'attempts': [{}],
                 'wake': {'reason': 'irreversible_action', 'question': '删掉旧数据？'}}
        text = goal_runner.decision_markdown(state)
        self.assertIn('A. 授权执行', text)
        self.assertIn('B. 换可逆方案或停止', text)


if __name__ == '__main__':
    unittest.main()
