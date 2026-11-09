"""Controller tests use a deterministic queue double; no model is invoked."""
import copy
import contextlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from workflow import Workflow, state_lock
from task_runner import PROJECT, lock


class FakeDB:
    def close(self):
        pass


class FakeQueue:
    def __init__(self):
        self.rows = []
        self.db = FakeDB()

    def status(self):
        return copy.deepcopy(self.rows)

    def enqueue(self, spec, allow_test=False):
        task = str(len(self.rows) + 1)
        self.rows.append(dict(id=task, spec=copy.deepcopy(spec), state="queued", result=None))
        return task

    def cancel(self, task):
        row = next(r for r in self.rows if r["id"] == task)
        if row["state"] != "running":
            row["state"] = "cancelled"
        row["cancel_requested"] = True

    def finish(self, task, result=None, state="succeeded"):
        row = next(r for r in self.rows if r["id"] == task)
        row.update(state=state, result=result or {})


def node(name, **kw):
    return dict(id=name, owner="test", provider="dsh-text", prompt="test", write_paths=[],
                checks=[{"kind": "final_json_values", "values": {"approved": True}}], **kw)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.flow = Workflow(self.root, self.root / ".work/flow")
        self.q = FakeQueue()
        self.patch = patch.object(self.flow, "queue", return_value=self.q)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def init(self, nodes):
        self.flow.init({"id": "tests", "nodes": nodes})

    def test_dependency_binds_actual_accepted_result(self):
        b = node("b", depends_on=["a"])
        b["prompt"] = "input={{result:a}}"
        self.init([node("a"), b])
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 1)
        self.q.finish("1", {"final_json": {"approved": True}, "actual": 47})
        self.flow.tick()
        self.assertIn('"actual": 47', self.q.rows[1]["spec"]["prompt"])

    def test_semantic_failure_blocks_only_dependents(self):
        self.init([node("a"), node("b", depends_on=["a"]), node("c")])
        self.flow.tick()
        self.q.finish("1", {"final_json": {"approved": False}})
        self.q.finish("2", {"final_json": {"approved": True}})
        data = self.flow.tick()
        self.assertEqual([n["status"] for n in data["nodes"]], ["failed", "blocked", "accepted"])
        self.assertEqual(data["status"], "needs_attention")

    def test_parent_child_write_paths_serialize(self):
        a, b, c = node("a"), node("b"), node("c")
        a["write_paths"], b["write_paths"], c["write_paths"] = ["src"], ["src/a.py"], ["docs"]
        self.init([a, b, c])
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 2)
        self.assertTrue(self.q.rows[0]["spec"]["resources"][0].startswith("write:"))
        self.q.finish("1", {"final_json": {"approved": True}})
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 3)

    def test_restore_does_not_duplicate_and_enqueue_crash_reconciles(self):
        self.init([node("a")])
        self.flow.tick()
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 1)
        data = self.flow.load()
        data["nodes"][0].pop("task_id")
        data["nodes"][0]["attempts"] = []
        data["nodes"][0]["status"] = "pending"
        self.flow.save(data)
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 1)
        self.assertEqual(self.flow.load()["nodes"][0]["task_id"], "1")

    def test_revision_invalidates_descendants_preserves_independent(self):
        self.init([node("a"), node("b", depends_on=["a"]), node("c")])
        self.flow.tick()
        for row in self.q.rows:
            self.q.finish(row["id"], {"final_json": {"approved": True}})
        self.flow.tick()
        self.q.finish("3", {"final_json": {"approved": True}})
        self.flow.tick()
        data = self.flow.revise({"expected_revision": 1, "nodes": [{"id": "a", "prompt": "changed"}]})
        self.assertEqual([n["status"] for n in data["nodes"]], ["stale", "stale", "accepted"])
        self.assertEqual(data["history"][0]["prompt"], "test")
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 4)
        with self.assertRaisesRegex(ValueError, "revision conflict"):
            self.flow.revise({"expected_revision": 1, "retry": ["a"]})

    def test_failed_acceptance_retry_creates_new_underlying_attempt(self):
        self.init([node("a")])
        self.flow.tick()
        self.q.finish("1", {"final_json": {"approved": False}})
        self.flow.tick()
        self.flow.revise({"expected_revision": 1, "retry": ["a"]})
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 2)
        self.assertEqual(self.flow.load()["nodes"][0]["attempts"], ["1", "2"])

    def test_external_wait_returns_and_input_update_releases(self):
        self.init([{"id": "data", "external": True}, node("a", depends_on=["data"])])
        self.assertEqual(self.flow.run()["status"], "needs_attention")
        self.flow.revise({"expected_revision": 1, "inputs": {"data": {"result": {"rows": 5}}}})
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 1)

    def test_artifact_binding_checks_scope_and_size(self):
        a, b = node("a"), node("b", depends_on=["a"])
        a["write_paths"] = ["out"]
        a["checks"].append({"kind": "file_exists", "path": "out/value.txt"})
        b["prompt"] = "{{file:a:out/value.txt}}"
        self.init([a, b])
        (self.root / "out").mkdir()
        (self.root / "out/value.txt").write_text("real-result", encoding="utf-8")
        self.flow.tick()
        self.q.finish("1", {"final_json": {"approved": True}})
        self.flow.tick()
        self.assertEqual(self.q.rows[1]["spec"]["prompt"], "real-result")
        (self.root / "out/value.txt").write_text("modified-after-acceptance", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "changed since acceptance"):
            self.flow.bind(b, {"a": self.flow.load()["nodes"][0]})
        with self.assertRaises(ValueError):
            self.flow.bind(dict(prompt="{{file:a:private.txt}}"), {"a": self.flow.load()["nodes"][0]})

    def test_checks_and_path_traversal(self):
        a = node("a")
        a["checks"] = [{"kind": "file_contains", "path": "out.txt", "contains": "good"},
                       {"kind": "file_json_keys", "path": "obj.json", "keys": ["x"]}]
        (self.root / "out.txt").write_text("good")
        (self.root / "obj.json").write_text('{"x":1}')
        self.assertTrue(all(c["ok"] for c in self.flow.check(a, {})))
        a["write_paths"] = ["../escape"]
        with self.assertRaises(ValueError):
            self.init([a])

    def test_running_cancel_reserves_write_scope(self):
        a, b = node("a"), node("b")
        a["write_paths"], b["write_paths"] = ["src"], ["src/x"]
        self.init([a, b])
        self.flow.tick()
        self.q.rows[0]["state"] = "running"
        self.flow.cancel("a")
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 1)
        self.q.finish("1", state="cancelled")
        self.flow.tick()
        self.assertEqual(len(self.q.rows), 2)

    def test_cancel_accepted_is_noop(self):
        self.init([node("a")])
        self.flow.tick()
        self.q.finish("1", {"final_json": {"approved": True}})
        self.flow.tick()
        result = self.flow.cancel("a")
        self.assertEqual(result["status"], "accepted")
        self.assertEqual(result["nodes"][0]["status"], "accepted")
        self.assertEqual(result["revision"], 1)

    def test_cycle_and_binding_without_dependency_rejected(self):
        with self.assertRaisesRegex(ValueError, "cycle"):
            self.init([node("a", depends_on=["b"]), node("b", depends_on=["a"])])
        a = node("a")
        a["prompt"] = "{{result:b}}"
        with self.assertRaises(ValueError):
            self.init([a, node("b")])

    def test_controller_runs_real_unittest(self):
        (self.root / "test_actual.py").write_text("import unittest\nclass T(unittest.TestCase):\n def test_true(self): self.assertEqual(2+2,4)\n")
        a = node("a")
        a["checks"] = [{"kind": "python_unittest", "module": "test_actual"}]
        self.flow.validate({"nodes": [a]})
        checked = self.flow.check(a, {})
        self.assertTrue(checked[0]["ok"])
        self.assertIn("Ran 1 test", checked[0]["output"])
        a["checks"][0]["module"] = "test_actual;danger"
        with self.assertRaises(ValueError):
            self.flow.validate({"nodes": [a]})

    def test_project_root_rebinding_rejected(self):
        self.init([node("a")])
        rebound = Workflow(self.root.parent, self.flow.state)
        with self.assertRaisesRegex(ValueError, "root binding"):
            rebound.load()

    def test_validation_does_not_hold_lock_or_accept_cancelled_receipt(self):
        self.init([node("a")])
        self.flow.tick()
        self.q.finish("1", {"final_json": {"approved": True}})
        entered, resume = threading.Event(), threading.Event()
        def inspect(*args):
            entered.set()
            resume.wait(3)
            return [{"ok": True}]
        with patch.object(self.flow, "check", side_effect=inspect):
            worker = threading.Thread(target=self.flow.tick)
            worker.start()
            self.assertTrue(entered.wait(2))
            self.flow.cancel("a")
            resume.set()
            worker.join(3)
        self.assertEqual(self.flow.load()["nodes"][0]["status"], "cancelled")

    def test_overall_timeout_bounds_validation_and_leaves_resumable(self):
        (self.root / "test_slow.py").write_text("import unittest,time\nclass T(unittest.TestCase):\n def test_wait(self): time.sleep(2)\n")
        a = node("a")
        a["checks"] = [{"kind": "python_unittest", "module": "test_slow"}]
        self.init([a])
        self.flow.tick()
        self.q.finish("1", {})
        began = time.monotonic()
        result = self.flow.run(timeout_seconds=0.3)
        self.assertEqual(result["status"], "timeout")
        self.assertLess(time.monotonic() - began, 1.3)
        self.assertEqual(self.flow.load()["nodes"][0]["status"], "running")

    def test_state_lock_waits_for_short_contention(self):
        entered, release = threading.Event(), threading.Event()
        path = self.flow.state / "contention.lock"
        def hold():
            with lock(path):
                entered.set()
                release.wait(2)
        owner = threading.Thread(target=hold)
        owner.start()
        self.assertTrue(entered.wait(1))
        timer = threading.Timer(0.06, release.set)
        timer.start()
        try:
            began = time.monotonic()
            with state_lock(path):
                self.assertGreaterEqual(time.monotonic() - began, 0.04)
        finally:
            release.set()
            owner.join(2)
            timer.join(2)

    def test_state_lock_body_permission_error_is_not_retried(self):
        attempts = []
        @contextlib.contextmanager
        def acquire(path):
            attempts.append(path)
            yield
        failure = PermissionError("business operation denied")
        with patch("workflow.lock", side_effect=acquire):
            with self.assertRaises(PermissionError) as caught:
                with state_lock(self.flow.state / "body.lock"):
                    raise failure
        self.assertIs(caught.exception, failure)
        self.assertEqual(len(attempts), 1)

    def test_state_lock_contention_timeout_is_bounded(self):
        path = self.flow.state / "bounded.lock"
        with lock(path):
            began = time.monotonic()
            with self.assertRaises((PermissionError, BlockingIOError)):
                with state_lock(path, timeout=0.04):
                    self.fail("overlapping lock must not be acquired")
            self.assertGreaterEqual(time.monotonic() - began, 0.03)
            self.assertLess(time.monotonic() - began, 0.5)


class RealQueueIntegration(unittest.TestCase):
    def test_real_runner_parallel_dependency_and_resume(self):
        fixtures = PROJECT / ".work/runtime-tests"
        fixtures.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=fixtures) as directory:
            root = Path(directory)
            flow = Workflow(root, root / ".work/flow")
            def writer(name, path, depends=None):
                n = node(name, depends_on=depends or [])
                n.update(provider="local-test", write_paths=[path],
                         checks=[{"kind": "file_contains", "path": path, "contains": name}],
                         queue_spec={"delay": 0.15, "artifacts": [{"path": str(root / path), "content": name}]})
                return n
            a, b, c = writer("a", "a.txt"), writer("b", "b.txt"), writer("c", "c.txt", ["a", "b"])
            c["prompt"] = "{{file:a:a.txt}}/{{file:b:b.txt}}"
            flow.init({"id": "real-queue-test", "nodes": [a, b, c]})
            result = flow.run(timeout_seconds=15, allow_test=True)
            self.assertEqual(result["status"], "accepted", result)
            q = flow.queue()
            try:
                rows = q.status()
                self.assertEqual(len(rows), 3)
                self.assertEqual(rows[2]["spec"]["prompt"], "a/b")
                intervals = sorted((r["result"]["process_started_at"], r["result"]["process_ended_at"]) for r in rows[:2])
                self.assertLess(intervals[1][0], intervals[0][1])
                self.assertTrue(all(r["result"]["test_only"] for r in rows))
            finally:
                q.db.close()
            self.assertEqual(flow.run(timeout_seconds=2, allow_test=True)["status"], "accepted")


if __name__ == "__main__":
    unittest.main()
