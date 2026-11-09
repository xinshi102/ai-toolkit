import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('goal_loop', Path(__file__).parents[1] / 'goal_loop.py')
loop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(loop)


def goal(**overrides):
    value = {"goalId": "g1", "objective": "produce ok artifact", "acceptance": ["artifact.ok == true"],
             "budget": {"attempts": 2, "maxSeconds": 60}}
    value.update(overrides)
    return value


def write_artifact(workspace, ok):
    path = Path(workspace) / 'artifact.json'
    path.write_text(json.dumps({"ok": ok}), encoding='utf-8')
    return str(path)


class PassTests(unittest.TestCase):
    def test_first_attempt_pass_never_wakes_user(self):
        with tempfile.TemporaryDirectory() as home:
            calls = []

            def executor(context):
                calls.append(context)
                return {"artifact": write_artifact(context['workspace'], True)}

            state = loop.run_goal(goal(), executor=executor, judge=lambda c: {"verdict": "pass"}, home=home)
            self.assertEqual(state['status'], 'done')
            self.assertIsNone(state['wake'])
            self.assertEqual(len(calls), 1)
            self.assertTrue((Path(home) / 'goals' / state['runId'] / 'goal.json').is_file())
            events = (Path(home) / 'goals' / state['runId'] / 'events.jsonl').read_text().splitlines()
            self.assertEqual([json.loads(line)['kind'] for line in events], ['goal', 'dispatch', 'result', 'judge', 'done'])


class RejectTests(unittest.TestCase):
    def test_reject_then_pass_holds_the_user_back(self):
        with tempfile.TemporaryDirectory() as home:
            defects_seen = []

            def executor(context):
                defects_seen.append(list(context['defects']))
                return {"artifact": write_artifact(context['workspace'], context['attempt'] >= 2)}

            def judge(context):
                data = json.loads(Path(context['result']['artifact']).read_text(encoding='utf-8'))
                return {"verdict": "pass"} if data['ok'] else {"verdict": "reject", "defects": ["set ok to true"]}

            state = loop.run_goal(goal(), executor=executor, judge=judge, home=home)
            self.assertEqual(state['status'], 'done')
            self.assertIsNone(state['wake'])
            self.assertEqual(defects_seen, [[], ["set ok to true"]])

    def test_attempt_budget_exhaustion_is_the_only_reason_to_wake(self):
        with tempfile.TemporaryDirectory() as home:
            state = loop.run_goal(
                goal(budget={"attempts": 2, "maxSeconds": 60}),
                executor=lambda c: {"artifact": write_artifact(c['workspace'], False)},
                judge=lambda c: {"verdict": "reject", "defects": ["still false"]},
                home=home,
            )
            self.assertEqual(state['status'], 'blocked')
            self.assertEqual(state['wake']['reason'], 'budget_exhausted')
            self.assertEqual(len(state['attempts']), 2)

    def test_time_budget_stops_before_the_next_dispatch(self):
        class Clock:
            def __init__(self):
                self.value = 0

            def __call__(self):
                self.value += 1
                return self.value

        with tempfile.TemporaryDirectory() as home:
            state = loop.run_goal(
                goal(budget={"attempts": 5, "maxSeconds": 1}),
                executor=lambda c: {"artifact": write_artifact(c['workspace'], False)},
                judge=lambda c: {"verdict": "reject", "defects": ["no"]},
                home=home,
                clock=Clock(),
            )
            self.assertEqual(state['status'], 'blocked')
            self.assertEqual(state['wake']['reason'], 'budget_exhausted')
            self.assertLess(len(state['attempts']), 5)


class CostTests(unittest.TestCase):
    def test_cost_records_executor_judge_time_and_tokens(self):
        class Clock:
            def __init__(self):
                self.value = 0

            def __call__(self):
                self.value += 1
                return self.value

        with tempfile.TemporaryDirectory() as home:
            def executor(context):
                return {'artifact': write_artifact(context['workspace'], True),
                        'usage': {'total': 100, 'cost': 0.0, 'steps': 2}}

            state = loop.run_goal(goal(), executor=executor, judge=lambda c: {'verdict': 'pass'},
                                  home=home, clock=Clock())
            cost = state['cost']
            self.assertEqual(cost['attempts'], 1)
            self.assertEqual(cost['tokens']['total'], 100)
            self.assertEqual(cost['tokens']['steps'], 2)
            self.assertGreater(cost['executorSeconds'], 0)
            self.assertGreaterEqual(cost['judgeSeconds'], 0)
            self.assertGreater(cost['wallSeconds'], 0)


class TokenBudgetTests(unittest.TestCase):
    def test_token_budget_stops_before_next_attempt(self):
        class Clock:
            def __init__(self):
                self.value = 0

            def __call__(self):
                self.value += 1
                return self.value

        with tempfile.TemporaryDirectory() as home:
            state = loop.run_goal(
                goal(budget={'attempts': 5, 'maxSeconds': 100, 'tokens': 50}),
                executor=lambda c: {'artifact': write_artifact(c['workspace'], False),
                                    'usage': {'total': 60, 'cost': 0.0, 'steps': 1}},
                judge=lambda c: {'verdict': 'reject', 'defects': ['no']},
                home=home, clock=Clock())
            self.assertEqual(state['status'], 'blocked')
            self.assertEqual(state['wake']['reason'], 'budget_exhausted')
            self.assertEqual(len(state['attempts']), 1)


class WakePolicyTests(unittest.TestCase):
    def test_whitelisted_judge_wake_is_recorded_with_question(self):
        with tempfile.TemporaryDirectory() as home:
            state = loop.run_goal(
                goal(),
                executor=lambda c: {"artifact": write_artifact(c['workspace'], True)},
                judge=lambda c: {"verdict": "need_user", "reason": "business_tradeoff", "question": "选 A 还是 B？"},
                home=home,
            )
            self.assertEqual(state['status'], 'blocked')
            self.assertEqual(state['wake']['reason'], 'business_tradeoff')
            self.assertEqual(state['wake']['question'], '选 A 还是 B？')

    def test_non_whitelisted_wake_reason_is_refused(self):
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaises(loop.GoalError):
                loop.run_goal(
                    goal(),
                    executor=lambda c: {"artifact": write_artifact(c['workspace'], True)},
                    judge=lambda c: {"verdict": "need_user", "reason": "finished_early"},
                    home=home,
                )

    def test_invalid_verdict_is_refused(self):
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaises(loop.GoalError):
                loop.run_goal(
                    goal(),
                    executor=lambda c: {"artifact": write_artifact(c['workspace'], True)},
                    judge=lambda c: {"verdict": "done"},
                    home=home,
                )


class ValidationTests(unittest.TestCase):
    def test_goal_requires_objective_acceptance_and_bounded_budget(self):
        for value in ({}, {"goalId": "x", "objective": "o", "acceptance": []},
                      goal(budget={"attempts": 0, "maxSeconds": 60}),
                      goal(budget={"attempts": 2, "maxSeconds": 0})):
            with self.subTest(value=value), self.assertRaises(loop.GoalError):
                loop.validate_goal(value)


if __name__ == '__main__':
    unittest.main()
