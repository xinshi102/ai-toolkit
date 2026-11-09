"""Independent adversarial checks, real SQLite Queue, no model calls."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from task_runner import PROJECT, Queue
import task_runner
from workflow import Workflow


class IndependentFlowTests(unittest.TestCase):
    def setUp(self):
        fixtures = PROJECT / '.work/runtime-tests'
        fixtures.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=fixtures, prefix='independent-')
        self.parent = Path(self.temporary.name)
        self.root = self.parent / '.work/runtime-tests/project'
        self.root.mkdir(parents=True)
        self.state = self.root / '.work/flow'
        self.flow = Workflow(self.root, self.state)

    def tearDown(self):
        self.temporary.cleanup()

    def node(self, name, **updates):
        data = {'id': name, 'owner': 'independent-test', 'provider': 'local-test',
                'prompt': name, 'write_paths': [name + '.txt'],
                'checks': [{'kind': 'file_contains', 'path': name + '.txt', 'contains': name}],
                'queue_spec': {'delay': .1, 'artifacts': [{'path': str(self.root / (name + '.txt')), 'content': name}]}}
        data.update(updates)
        return data

    def init(self, nodes):
        return self.flow.init({'id': 'independent-flow', 'nodes': nodes})

    def rows(self):
        q = self.flow.queue()
        try:
            return q.status()
        finally:
            q.db.close()

    def test_real_transport_failure_cannot_be_accepted_even_if_artifact_matches(self):
        a, b, c = self.node('a'), self.node('b', depends_on=['a']), self.node('c')
        a['queue_spec']['exit_code'] = 9
        self.init([a, b, c])
        data = self.flow.run(timeout_seconds=15, allow_test=True)
        self.assertEqual([n['status'] for n in data['nodes']], ['failed', 'blocked', 'accepted'])
        self.assertTrue((self.root / 'a.txt').exists())
        self.assertNotEqual(data['status'], 'accepted')

    def test_real_semantic_failure_cannot_accept_success_exit(self):
        a = self.node('a')
        a['checks'][0]['contains'] = 'required-new-content'
        self.init([a])
        data = self.flow.run(timeout_seconds=15, allow_test=True)
        self.assertEqual(data['nodes'][0]['status'], 'failed')
        self.assertEqual(self.rows()[0]['state'], 'succeeded')

    def test_enqueue_permission_error_fails_closed(self):
        self.init([self.node('a')])
        data = self.flow.tick(allow_test=False)
        self.assertEqual(data['nodes'][0]['status'], 'failed')
        self.assertEqual(self.rows(), [])
        self.assertNotEqual(data['status'], 'accepted')

    def test_restart_reconciles_actual_enqueued_binding_without_duplicate(self):
        self.init([self.node('a')])
        self.flow.tick(allow_test=True)
        data = self.flow.load()
        original = data['nodes'][0]['task_id']
        data['nodes'][0].pop('task_id')
        data['nodes'][0]['attempts'] = []
        data['nodes'][0]['status'] = 'pending'
        self.flow.save(data)
        fresh = Workflow(self.root, self.state)
        recovered = fresh.tick(allow_test=True)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(recovered['nodes'][0]['task_id'], original)

    def test_revise_unknown_old_attempt_reserves_and_cannot_release_new_version(self):
        self.init([self.node('a')])
        self.flow.tick(allow_test=True)
        q = self.flow.queue()
        try:
            old = q.claim()
            q.finish(old, 'unknown', {'reason': 'simulated unconfirmed owned process'})
            self.flow.revise({'expected_revision': 1, 'nodes': [{'id': 'a', 'prompt': 'new requirement'}]})
            data = self.flow.tick(allow_test=True)
            self.assertNotEqual(data['nodes'][0]['status'], 'accepted')
            self.assertEqual(len(q.status()), 1)
            self.assertEqual(q.status()[0]['state'], 'unknown')
            self.assertTrue(q.db.execute('SELECT COUNT(*) FROM resources').fetchone()[0] > 0)
            q.resolve_unknown(old)
            self.flow.tick(allow_test=True)
            self.assertEqual(len(q.status()), 2)
            self.assertNotEqual(self.flow.load()['nodes'][0]['task_id'], old)
            self.assertEqual(self.flow.load()['nodes'][0]['prompt'], 'new requirement')
        finally:
            q.db.close()

    def test_parent_child_case_insensitive_write_scopes_serialize(self):
        a, b = self.node('a'), self.node('b')
        a['write_paths'], b['write_paths'] = ['Src'], ['sRC/child.py']
        self.init([a, b])
        self.flow.tick(allow_test=True)
        self.assertEqual(len(self.rows()), 1)

    def test_file_binding_rejects_other_producer_scope(self):
        a, b, c = self.node('a'), self.node('b', depends_on=['a']), self.node('c')
        b['prompt'] = '{{file:a:private.txt}}'
        self.init([a, b, c])
        (self.root / 'private.txt').write_text('private-input', encoding='utf-8')
        data = self.flow.run(timeout_seconds=15, allow_test=True)
        self.assertEqual([n['status'] for n in data['nodes']], ['accepted', 'failed', 'accepted'])
        self.assertEqual(len(self.rows()), 2)
        self.assertIn('outside producer', data['nodes'][1]['reason'])

    def test_existing_queue_cannot_rebind_to_different_project_root(self):
        first = Queue(self.state / 'queue', project_root=self.root)
        first.db.close()
        with self.assertRaises(ValueError):
            wrong = Queue(self.state / 'queue', project_root=self.parent)
            wrong.db.close()

    def test_existing_workflow_cannot_rebind_to_different_project_root(self):
        self.init([self.node('a')])
        with self.assertRaises(ValueError):
            wrong = Workflow(self.parent, self.state)
            wrong.load()

    def test_init_rejects_caller_supplied_runtime_binding(self):
        a = self.node('a')
        a['pending_binding'] = 'an-old-workflow-receipt'
        with self.assertRaises(ValueError):
            self.init([a])

    def test_run_budget_cannot_be_exceeded_by_synchronous_acceptance(self):
        test_file = self.root / 'test_slow_acceptance.py'
        test_file.write_text('import unittest,time\nclass T(unittest.TestCase):\n def test_slow(self): time.sleep(1.4)\n', encoding='utf-8')
        a = self.node('a')
        a['checks'] = [{'kind': 'python_unittest', 'module': 'test_slow_acceptance', 'timeout_seconds': 2}]
        self.init([a])
        self.flow.tick(allow_test=True)
        q = self.flow.queue()
        try:
            task = q.claim()
            self.assertIsNotNone(task, self.flow.load())
            q.finish(task, 'succeeded', {'test_only': True})
        finally:
            q.db.close()
        start = time.monotonic()
        data = self.flow.run(timeout_seconds=.2, allow_test=True)
        elapsed = time.monotonic() - start
        self.assertLess(elapsed, .9, f'run budget .2s blocked for {elapsed:.3f}s, status={data["status"]}')

    def test_revision_during_real_file_validation_cannot_accept_old_receipt(self):
        marker = self.root / 'checking.marker'
        (self.root / 'test_revision_race.py').write_text(
            'import unittest,time\nfrom pathlib import Path\nclass T(unittest.TestCase):\n'
            ' def test_delayed(self):\n  Path("checking.marker").write_text("ready")\n  time.sleep(.5)\n', encoding='utf-8')
        a = self.node('a')
        a['checks'] = [{'kind': 'python_unittest', 'module': 'test_revision_race', 'timeout_seconds': 2}]
        self.init([a])
        self.flow.tick(allow_test=True)
        q = self.flow.queue()
        try:
            original = q.claim()
            q.finish(original, 'succeeded', {'test_only': True})
        finally:
            q.db.close()
        errors = []
        def inspect():
            try:
                self.flow.tick(allow_test=True)
            except Exception as exc:
                errors.append(exc)
        thread = threading.Thread(target=inspect)
        thread.start()
        deadline = time.monotonic() + 3
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(marker.exists())
        try:
            changed = self.flow.revise({'expected_revision': 1, 'nodes': [{'id': 'a', 'prompt': 'new-version'}]})
            self.assertEqual(changed['revision'], 2)
        finally:
            thread.join(timeout=4)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        now = self.flow.load()['nodes'][0]
        self.assertNotEqual(now['status'], 'accepted')
        self.assertNotEqual(now.get('task_id'), original)
        self.assertEqual(now['prompt'], 'new-version')

    def test_workspace_cancel_retains_resource_while_unconfirmed_descendant_writes(self):
        marker = self.root / 'descendant-ready.txt'
        output = self.root / 'descendant-write.txt'
        fixture = self.root / 'spawn_child.py'
        child = 'import time;from pathlib import Path;time.sleep(1.0);Path(' + repr(str(output)) + ').write_text("late-write")'
        fixture.write_text('import subprocess,sys,time\nfrom pathlib import Path\n'
            'p=subprocess.Popen([sys.executable,"-c",' + repr(child) + '])\n'
            'Path(' + repr(str(marker)) + ').write_text(str(p.pid))\ntime.sleep(4)\n', encoding='utf-8')
        q = self.flow.queue()
        task = q.enqueue({'cwd': str(self.root), 'adapter': 'codex-workspace', 'permission': 'workspace-write',
                          'prompt': 'fixture only; no model', 'resources': ['test-write-resource']})
        self.assertEqual(q.claim(), task)
        errors = []
        def execute_fixture():
            worker_queue = self.flow.queue()
            try:
                task_runner.execute(worker_queue, task)
            except Exception as exc:
                errors.append(exc)
            finally:
                worker_queue.db.close()
        # Replace only launch construction, preserving the real execute/cancel/DB
        # path and real Windows parent/child process behavior. No model is called.
        with patch.object(task_runner, 'command', return_value=([sys.executable, '-B', str(fixture)], '')):
            worker = threading.Thread(target=execute_fixture)
            worker.start()
            try:
                deadline = time.monotonic() + 3
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(marker.exists())
                q.cancel(task)
                worker.join(timeout=4)
                self.assertFalse(worker.is_alive())
                row = next(row for row in q.status() if row['id'] == task)
                resources_held = q.db.execute('SELECT COUNT(*) FROM resources WHERE task=?', (task,)).fetchone()[0]
                while not output.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertEqual(errors, [])
                self.assertFalse(output.exists() and row['state'] == 'cancelled' and resources_held == 0,
                                 'cancelled+released write scope while a descendant still wrote afterward')
            finally:
                worker.join(timeout=5)
                # This self-exiting fixture child gets no arbitrary termination.
                time.sleep(.1)
                q.db.close()


if __name__ == '__main__':
    unittest.main()
