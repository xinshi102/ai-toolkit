import json
from pathlib import Path
import sys
import unittest

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_draft


class DraftNormalizeTests(unittest.TestCase):
    def test_required_keys_follow_check_keys_and_artifact_follows_file(self):
        data = {
            'goalId': 'g', 'objective': 'o', 'acceptance': ['a'],
            'artifact': 'goal-design.json', 'required_keys': ['nonce', 'result'],
            'budget': {'attempts': 2, 'maxSeconds': 300},
            'checks': [
                {'desc': 'ok', 'command': "python3 -c \"import json; d=json.load(open('liveC.json')); assert d.get('ok') is True\""},
                {'desc': 'nonce', 'command': "python3 -c \"import json; a=json.load(open('liveC.json')); b=json.load(open('goal-brief.json')); assert a['nonce']==b['nonce']\""},
            ],
        }
        goal = goal_draft.normalize(data, 'do it')
        self.assertEqual(goal['artifact'], 'liveC.json')
        self.assertIn('ok', goal['required_keys'])
        self.assertNotIn('result', goal['required_keys'])

    def test_skeleton_keeps_request(self):
        goal = goal_draft.skeleton('写一个报告')
        self.assertEqual(goal['objective'], '写一个报告')
        self.assertEqual(goal['checks'], [])


if __name__ == '__main__':
    unittest.main()
