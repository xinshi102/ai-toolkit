import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
import goal_batch


def state(goal_id, status='done', wake=None, cost=None):
    return {'runId': goal_id + '-r', 'goalId': goal_id, 'status': status, 'wake': wake,
            'attempts': [{'verdict': 'pass'}], 'cost': cost or {'wallSeconds': 1.0, 'tokens': {'total': 10}}}


class BatchTests(unittest.TestCase):
    def test_runs_milestones_in_order_and_aggregates(self):
        with tempfile.TemporaryDirectory() as home:
            plan = {'planId': 'p', 'milestones': [
                {'goalId': 'm1', 'objective': 'one', 'acceptance': ['a'], 'checks': [{'command': 'true'}]},
                {'goalId': 'm2', 'objective': 'two', 'acceptance': ['a'], 'checks': [{'command': 'true'}]},
            ]}
            plan_path = Path(home, 'plan.json'); plan_path.write_text(json.dumps(plan), encoding='utf-8')
            with mock.patch.object(goal_batch.goal_runner, 'run_goal_file',
                                   side_effect=[state('m1'), state('m2')]) as run:
                report = goal_batch.run_batch(plan_path, home=home, notify=False)
            self.assertEqual(report['status'], 'done')
            self.assertEqual(run.call_count, 2)
            self.assertEqual(report['cost']['milestones'], 2)
            self.assertEqual(report['cost']['tokens'], 20)
            self.assertTrue(Path(report['reportPath']).is_file())

    def test_stops_on_blocked_milestone_and_keeps_decision(self):
        with tempfile.TemporaryDirectory() as home:
            plan = {'planId': 'p', 'milestones': [
                {'goalId': 'm1', 'objective': 'one', 'acceptance': ['a'], 'checks': [{'command': 'true'}]},
                {'goalId': 'm2', 'objective': 'two', 'acceptance': ['a'], 'checks': [{'command': 'true'}]},
            ]}
            plan_path = Path(home, 'plan.json'); plan_path.write_text(json.dumps(plan), encoding='utf-8')
            blocked = state('m1', status='blocked', wake={'reason': 'budget_exhausted', 'question': '继续？'})
            with mock.patch.object(goal_batch.goal_runner, 'run_goal_file', return_value=blocked):
                report = goal_batch.run_batch(plan_path, home=home, notify=False)
            self.assertEqual(report['status'], 'blocked')
            self.assertEqual(report['decision']['question'], '继续？')
            self.assertEqual(len(report['milestones']), 1)


if __name__ == '__main__':
    unittest.main()
