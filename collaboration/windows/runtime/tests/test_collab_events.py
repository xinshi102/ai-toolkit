"""Tests for the event bus, budget breaker, gate rules and state snapshots."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import budget
import events
import gate
import state


class EventsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'events.db'

    def tearDown(self):
        self.tmp.cleanup()

    def test_emit_list_and_consume(self):
        first = events.emit(self.db, 't1', 'task_started', payload={'n': 1})
        second = events.emit(self.db, 't1', 'task_succeeded', status='ok',
                             payload={'artifact': 'out.txt'})
        self.assertGreater(second, first)
        rows = events.list_events(self.db)
        self.assertEqual([r['id'] for r in rows], [first, second])
        self.assertEqual(rows[0]['payload']['n'], 1)
        self.assertEqual(events.mark_consumed(self.db, [first]), 1)
        self.assertEqual(len(events.list_events(self.db, unconsumed=True)), 1)
        self.assertEqual(events.mark_consumed(self.db, [first]), 0)

    def test_wait_returns_new_events(self):
        base = events.emit(self.db, 't2', 'progress')
        events.emit(self.db, 't2', 'task_succeeded', status='ok')
        rows = events.wait(self.db, since_id=base, timeout=2, interval=0.2)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['type'], 'task_succeeded')

    def test_payload_truncated(self):
        events.emit(self.db, 't3', 'progress', payload={'blob': 'x' * 20000})
        row = events.list_events(self.db)[0]
        self.assertTrue(row['payload'].get('_truncated'))


class BudgetTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'budget.db'

    def tearDown(self):
        self.tmp.cleanup()

    def test_token_limit_blocks_and_emits_once(self):
        budget.start(self.db, 'b1', token_limit=10, time_limit=60, poll_limit=5)
        self.assertTrue(budget.charge(self.db, 'b1', 5)['ok'])
        result = budget.charge(self.db, 'b1', 10)
        self.assertFalse(result['ok'])
        self.assertIn('tokens', result['exceeded'])
        self.assertEqual(result['status'], 'blocked')
        rows = [r for r in events.list_events(self.db)
                if r['type'] == 'budget_exceeded']
        self.assertEqual(len(rows), 1)
        # Already blocked: the breaker must not emit again.
        budget.charge(self.db, 'b1', 100)
        rows = [r for r in events.list_events(self.db)
                if r['type'] == 'budget_exceeded']
        self.assertEqual(len(rows), 1)

    def test_poll_and_time_limits(self):
        budget.start(self.db, 'b2', token_limit=100, time_limit=-1, poll_limit=1)
        self.assertIn('time', budget.check(self.db, 'b2')['exceeded'])
        budget.start(self.db, 'b3', token_limit=100, time_limit=60, poll_limit=1)
        self.assertTrue(budget.poll(self.db, 'b3')['ok'])
        self.assertFalse(budget.poll(self.db, 'b3')['ok'])


class GateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / 'gate.db'
        self.state_dir = Path(self.tmp.name) / 'state'
        self.state_dir.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_ignored_event_is_consumed_without_wake(self):
        events.emit(self.db, 'g1', 'task_started')
        result = gate.run_once(self.db, self.state_dir, dry_run=True)
        self.assertFalse(result[0]['wake'])
        self.assertEqual(events.list_events(self.db, unconsumed=True), [])

    def test_success_wakes_gate2_with_snapshot(self):
        st = state.new_state('g1', plan='phase 1: build; phase 2: test',
                             acceptance={'test': 'pytest passes'})
        state.save_state(self.state_dir / 'g1.json', st)
        events.emit(self.db, 'g1', 'task_succeeded', status='ok',
                    payload={'artifact': 'out.txt', 'stdout': 'x' * 5000})
        result = gate.run_once(self.db, self.state_dir, dry_run=True)
        self.assertTrue(result[0]['wake'])
        self.assertEqual(result[0]['gate_type'], 'gate2')
        self.assertLessEqual(len(json.dumps(result[0]['snapshot'], ensure_ascii=False)), 4096)
        self.assertNotIn('stdout', json.dumps(result[0]['snapshot'], ensure_ascii=False))
        self.assertEqual(gate.list_gates(self.db)[0]['verdict'], 'DRY_RUN')

    def test_deviation_wakes_gate1(self):
        events.emit(self.db, 'g2', 'deviation', severity='warning',
                    payload={'reason': 'scope changed'})
        result = gate.run_once(self.db, self.state_dir, dry_run=True)
        self.assertTrue(result[0]['wake'])
        self.assertEqual(result[0]['gate_type'], 'gate1')

    def test_cooldown_suppresses_duplicate_type_in_one_batch(self):
        events.emit(self.db, 'g3', 'task_failed', status='failed')
        events.emit(self.db, 'g3', 'task_failed', status='failed')
        result = gate.run_once(self.db, self.state_dir, dry_run=True, cooldown=60)
        self.assertEqual(len(result), 2)
        self.assertTrue(result[0]['wake'])
        self.assertFalse(result[1]['wake'])
        self.assertEqual(result[1]['reason'], 'cooldown')

    def test_wake_command_verdict_is_recorded(self):
        events.emit(self.db, 'g4', 'task_failed', status='failed')
        cmd = (f'"{sys.executable}" -c "print(\'VERDICT: PASS\'); '
               f'print(\'REASON: looks fine\')"')
        result = gate.run_once(self.db, self.state_dir, wake_cmd=cmd,
                               dry_run=False, timeout=30)
        self.assertEqual(result[0]['verdict'], 'PASS')
        self.assertEqual(gate.list_gates(self.db)[0]['verdict'], 'PASS')
        self.assertEqual(gate.list_gates(self.db)[0]['reason'], 'looks fine')

    def test_state_roundtrip_and_hash(self):
        st = state.new_state('g5', plan='P')
        path = self.state_dir / 'g5.json'
        state.save_state(path, st)
        loaded = state.load_state(path, 'g5')
        self.assertEqual(loaded['plan'], 'P')
        self.assertEqual(loaded['plan_hash'], state.plan_hash('P'))


if __name__ == '__main__':
    unittest.main()
