"""Small project-scoped durable queue. Python standard library only."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

BASE = Path(os.path.abspath(__file__)).parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))
PROJECT = BASE.parent
if os.name == "nt":
    canonical = Path(os.environ.get("AI_COLLAB_HOME") or PROJECT)
    if canonical.is_dir() and canonical.resolve() == PROJECT.resolve():
        PROJECT = canonical
        BASE = PROJECT / "runtime"
from adapters import adapter_for  # noqa: E402
from adapters.base import hidden_options  # noqa: E402
from guard import StallMonitor, stop_process  # noqa: E402
STATES = ("queued", "running", "succeeded", "failed", "cancelled", "interrupted", "blocked", "unknown")


def inside(path, root):
    if not Path(path).is_absolute():
        raise ValueError("absolute paths are required")
    resolved, resolved_root = Path(path).resolve(), Path(root).resolve()
    if not resolved.is_relative_to(resolved_root):
        raise ValueError(f"path outside allowed root: {resolved}")
    # Check physical targets, persist the stable canonical entry, not a junction's old target.
    return Path(os.path.abspath(root)) / resolved.relative_to(resolved_root)


@contextlib.contextmanager
def lock(path):
    path = inside(path, path.parent)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    if os.fstat(handle.fileno()).st_size == 0:
        handle.write(b"0")
        handle.flush()
    handle.seek(0)
    acquired = False
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        acquired = True
        yield
    finally:
        if acquired:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def pid_alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
        handle = kernel.OpenProcess(0x100000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied: conservatively alive.
        try:
            return kernel.WaitForSingleObject(handle, 0) == 258
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class Queue:
    def __init__(self, state, project_root=None):
        self.project = Path(os.path.abspath(project_root or PROJECT))
        if project_root is not None:
            approved = Path(os.environ.get('AI_COLLAB_PROJECTS') or Path(os.path.abspath(project_root)).anchor)
            if not self.project.is_relative_to(approved) or not self.project.is_dir():
                raise ValueError('project root must be an existing canonical project under Projects')
        self.state = inside(state, self.project)
        self.state.mkdir(parents=True, exist_ok=True)
        database = inside(self.state / "tasks.sqlite", self.state)
        self.db = sqlite3.connect(database, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS tasks(
          id TEXT PRIMARY KEY, spec TEXT NOT NULL, state TEXT NOT NULL,
          cancel INTEGER DEFAULT 0, pid INTEGER, result TEXT, updated REAL);
        CREATE TABLE IF NOT EXISTS resources(name TEXT PRIMARY KEY, task TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,
          task TEXT, event TEXT, detail TEXT, time REAL);
        CREATE TABLE IF NOT EXISTS control(key TEXT PRIMARY KEY,value TEXT);
        """)
        self.db.commit()
        if "attempt_id" not in {r[1] for r in self.db.execute("PRAGMA table_info(tasks)")}:
            with self.db:
                self.db.execute("ALTER TABLE tasks ADD COLUMN attempt_id TEXT")
        identity = os.path.normcase(os.path.abspath(self.project))
        try:
            with self.db:
                bound = self.db.execute("SELECT value FROM control WHERE key='project_root'").fetchone()
                if bound is not None and bound[0] != identity:
                    raise ValueError('queue state is bound to a different project root')
                if bound is None:
                    if self.db.execute('SELECT 1 FROM tasks LIMIT 1').fetchone() and identity != os.path.normcase(os.path.abspath(PROJECT)):
                        raise ValueError('legacy nonempty queue root cannot be inferred; resume through original shared project')
                    self.db.execute("INSERT OR IGNORE INTO control VALUES('project_root',?)", (identity,))
                    actual = self.db.execute("SELECT value FROM control WHERE key='project_root'").fetchone()[0]
                    if actual != identity:
                        raise ValueError('queue root changed during binding')
        except Exception:
            self.db.close()
            raise

    def event(self, task, event, detail=None):
        self.db.execute("INSERT INTO events(task,event,detail,time) VALUES(?,?,?,?)",
                        (task, event, json.dumps(detail), time.time()))

    def validate(self, spec, allow_test=False):
        if not isinstance(spec, dict):
            raise ValueError("manifest must be an object")
        if any(not isinstance(key, str) or key.startswith("_") for key in spec):
            raise ValueError("manifest cannot contain private runtime fields")
        spec = dict(spec)
        if "cwd" not in spec or "permission" not in spec:
            raise ValueError("explicit cwd and permission are required")
        cwd = inside(spec["cwd"], self.project)
        spec["cwd"] = str(cwd)
        if not cwd.is_dir():
            raise ValueError("cwd must exist")
        if spec["permission"] not in ("read-only", "shell-read-only", "workspace-write"):
            raise ValueError("unsupported permission")
        if spec["permission"] == "shell-read-only" and spec.get("external_tools") != "existing-user-authorization":
            raise ValueError("shell-read-only requires explicit external_tools=existing-user-authorization scope")
        adapter = adapter_for(spec)
        adapter.validate_adapter(spec, {'allow_test': allow_test, 'project': PROJECT, 'queue': self})
        if not isinstance(spec.get("prompt", ""), str):
            raise ValueError("prompt must be a string")
        if len(spec.get("prompt", "").encode("utf-8")) > 65536:
            raise ValueError("prompt exceeds 64 KiB input bound")
        for field in ("depends_on", "resources"):
            if not isinstance(spec.get(field, []), list) or any(
                    not isinstance(x, str) or not x.strip() for x in spec.get(field, [])):
                raise ValueError(f"{field} must contain nonblank strings")
        spec = adapter.prepare_spec(spec)
        artifacts = spec.get("artifacts", [])
        if not isinstance(artifacts, list):
            raise ValueError("artifacts must be a list")
        for item in artifacts:
            if not isinstance(item, dict) or "path" not in item:
                raise ValueError("artifact path required")
            inside(item["path"], cwd)
        spec["artifacts"] = [dict(item, path=str(inside(item["path"], cwd))) for item in artifacts]
        adapter.validate_tail(spec, {'allow_test': allow_test, 'project': PROJECT, 'queue': self})
        return spec

    def enqueue(self, spec, allow_test=False):
        spec = self.validate(spec, allow_test)
        adapter = adapter_for(spec)
        spec = adapter.prepare_enqueue(
            spec, lambda task_id: self.db.execute(
                'SELECT spec,state,result FROM tasks WHERE id=?', (task_id,)).fetchone())
        task = uuid.uuid4().hex
        with self.db:
            for dep in spec.get("depends_on", []):
                if not self.db.execute("SELECT 1 FROM tasks WHERE id=?", (dep,)).fetchone():
                    raise ValueError(f"unknown dependency {dep}")
            self.db.execute("INSERT INTO tasks(id,spec,state,updated) VALUES(?,?,?,?)",
                            (task, json.dumps(spec), "queued", time.time()))
            self.event(task, "enqueued", {"test_only": adapter.test_only})
        return task

    def status(self):
        return [dict(r) | {"spec": json.loads(r["spec"]),
                          "result": json.loads(r["result"]) if r["result"] else None}
                for r in self.db.execute("SELECT * FROM tasks ORDER BY updated,id")]

    def cancel(self, task):
        with self.db:
            row = self.db.execute("SELECT state FROM tasks WHERE id=?", (task,)).fetchone()
            if not row:
                raise ValueError("unknown task")
            if row["state"] in ("succeeded", "failed", "cancelled", "blocked"):
                return
            state = row["state"] if row["state"] in ("running", "unknown") else "cancelled"
            self.db.execute("UPDATE tasks SET cancel=1,state=?,updated=? WHERE id=?",
                            (state, time.time(), task))
            self.event(task, "cancel_requested")

    def claim(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            for row in self.db.execute("SELECT * FROM tasks WHERE state='queued' ORDER BY updated,id").fetchall():
                spec = json.loads(row["spec"])
                deps = [self.db.execute("SELECT state FROM tasks WHERE id=?", (d,)).fetchone()[0]
                        for d in spec.get("depends_on", [])]
                if any(d in ("failed", "cancelled", "blocked") for d in deps):
                    self.db.execute("UPDATE tasks SET state='blocked',result=?,updated=? WHERE id=?",
                                    (json.dumps({"reason": "dependency failed or cancelled", "dependencies": deps}),
                                     time.time(), row["id"]))
                    self.event(row["id"], "dependency_blocked", deps)
                    continue
                if any(d != "succeeded" for d in deps):
                    continue
                resources = sorted(set(spec.get("resources", [])))
                if any(self.db.execute("SELECT 1 FROM resources WHERE name=?", (r,)).fetchone()
                       for r in resources):
                    continue
                for resource in resources:
                    self.db.execute("INSERT INTO resources VALUES(?,?)", (resource, row["id"]))
                self.db.execute("UPDATE tasks SET state='running',pid=NULL,result=NULL,attempt_id=?,updated=? WHERE id=?",
                                (uuid.uuid4().hex, time.time(), row["id"]))
                self.event(row["id"], "claimed", resources)
                self.db.commit()
                return row["id"]
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def finish(self, task, state, result):
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            row = self.db.execute("SELECT cancel FROM tasks WHERE id=?", (task,)).fetchone()
            if row and row["cancel"] and state != "unknown":
                state = "cancelled"
            self.db.execute("UPDATE tasks SET state=?,result=?,updated=? WHERE id=?",
                            (state, json.dumps(result), time.time(), task))
            if state != "unknown":
                self.db.execute("DELETE FROM resources WHERE task=?", (task,))
            self.event(task, state, result)
        spec = json.loads(self.db.execute('SELECT spec FROM tasks WHERE id=?', (task,)).fetchone()[0])
        try:
            adapter_for(spec).on_finish(self.state, task, spec, result, state)
        except OSError:
            self.event(task, 'board_record_failed', {'reason': 'round export unavailable'})

    def recover(self, retry=False):
        # Exclude launch/recover races with a live worker. OS lock survives stale files.
        with lock(self.state / "worker.lock"):
            for row in self.db.execute("SELECT * FROM tasks WHERE state IN ('running','unknown')").fetchall():
                try:
                    with lock(self.state / (row["id"] + ".lock")):
                        previous = json.loads(row["result"]) if row["result"] else {}
                        adapter = adapter_for(json.loads(row['spec']))
                        if adapter.shared_host:
                            self.finish(row['id'], 'unknown', dict(previous,
                                reason=adapter.shared_host_reason))
                            continue
                        if previous.get("launch_intent") and not (
                                previous.get("process_start_confirmed") and previous.get("attempt_id") == row["attempt_id"]):
                            self.finish(row["id"], "unknown", {"reason": "this attempt has no confirmed process identity; manual verification required",
                                                                 "launch_intent": True, "attempt_id": row["attempt_id"]})
                            continue
                        if pid_alive(row["pid"]):
                            self.finish(row["id"], "unknown", {"reason": "possible orphan or reused PID; manual process verification required",
                                                                 "pid": row["pid"]})
                            continue
                        if not row["pid"] and (previous.get("launch_intent") or row["state"] == "unknown"):
                            self.finish(row["id"], "unknown", {"reason": "launch outcome unknown; manual process verification required",
                                                                 "launch_intent": True})
                            continue
                        self.finish(row["id"], "cancelled" if row["cancel"] else "interrupted",
                                    {"exit_code": None, "terminal_event": None,
                                     "artifacts_verified": False, "reason": "executor absent; outcome unknown"})
                except (OSError, BlockingIOError):
                    continue
            if retry:
                with self.db:
                    # Explicit retry may repeat an interrupted read-only inference, never completed work.
                    self.db.execute("UPDATE tasks SET state='queued',pid=NULL,result=NULL,attempt_id=NULL,updated=? WHERE state='interrupted' AND cancel=0",
                                    (time.time(),))
                    self.event(None, "explicit_recovery_retry")

    def resolve_unknown(self, task):
        with lock(self.state / "worker.lock"), lock(self.state / (task + ".lock")):
            row = self.db.execute("SELECT * FROM tasks WHERE id=? AND state='unknown'", (task,)).fetchone()
            if not row:
                raise ValueError("task must be unknown")
            adapter = adapter_for(json.loads(row['spec']))
            if adapter.shared_host:
                raise ValueError(adapter.shared_unknown_error)
            if pid_alive(row["pid"]):
                raise ValueError("recorded PID is still alive; verify identity before retry")
            self.finish(task, "cancelled" if row["cancel"] else "interrupted",
                        {"reason": "operator explicitly confirmed no task process remains"})


def command(spec):
    """Build the launch command through the registered adapter.

    Kept as a module-level function because callers and tests replace this
    single launch-construction step while exercising the real execute path.
    """
    return adapter_for(spec).build_command(spec)


def execute(queue, task):
    with lock(queue.state / (task + ".lock")):
        row = queue.db.execute("SELECT * FROM tasks WHERE id=?", (task,)).fetchone()
        if row["state"] != "running":
            return
        if row["cancel"]:
            queue.finish(task, "cancelled", {"exit_code": None, "terminal_event": None,
                                            "artifacts_verified": False, "reason": "cancelled before launch"})
            return
        spec = json.loads(row["spec"])
        adapter = adapter_for(spec)
        result = {"exit_code": None, "terminal_event": None, "artifacts_verified": False,
                  "test_only": adapter.test_only,
                  "permission_scope": spec.get("permission"), "external_tools": spec.get("external_tools"),
                  "attempt_id": row["attempt_id"]}
        process = None
        try:
            spec = queue.validate(spec, allow_test=True)  # Revalidate paths immediately before execution.
            adapter.prepare_launch(spec, queue.state, task)
            argv, stdin = command(spec)
            if "_preflight" in spec:
                result["preflight"] = spec["_preflight"]
            log = inside(queue.state / (task + ".jsonl"), queue.state)
            with log.open("wb") as out:
                with queue.db:
                    queue.db.execute("UPDATE tasks SET result=? WHERE id=?", (json.dumps(
                        {"launch_intent": True, "attempt_id": row["attempt_id"]}), task))
                    queue.event(task, "launch_intent")
                result["process_started_at"] = time.time()
                if adapter.owned_process:
                    from owned_process import OwnedProcess
                    process_factory = OwnedProcess
                else:
                    process_factory = subprocess.Popen
                process = process_factory(argv, cwd=spec["cwd"], stdin=subprocess.PIPE,
                                           stdout=out, stderr=subprocess.STDOUT, shell=False,
                                           env=dict(os.environ, **spec.get('_native_env', {})),
                                           **hidden_options())
                with queue.db:
                    queue.db.execute("UPDATE tasks SET pid=?,result=? WHERE id=?", (process.pid, json.dumps(
                        {"launch_intent": True, "process_start_confirmed": True, "attempt_id": row["attempt_id"]}), task))
                    queue.event(task, "process_started", {"argv": argv, "pid": process.pid})
                input_done = threading.Event()
                input_errors = []
                def write_input():
                    try:
                        process.stdin.write(stdin.encode("utf-8"))
                        process.stdin.close()
                    except (OSError, ValueError) as input_error:
                        input_errors.append(str(input_error))
                    finally:
                        try:
                            process.stdin.close()
                        except (OSError, ValueError):
                            pass
                        input_done.set()
                writer = threading.Thread(target=write_input, daemon=True)
                writer.start()
                input_deadline = time.monotonic() + 10
                stall_timeout = spec.get('timeout_seconds', adapter.timeout_default)
                stall_monitor = StallMonitor(log, adapter=adapter.name, timeout=stall_timeout)
                denial_monitor = adapter.denial_monitor(log)
                while process.poll() is None:
                    cancelled = queue.db.execute("SELECT cancel FROM tasks WHERE id=?", (task,)).fetchone()[0]
                    stall = stall_monitor.poll()
                    denial = denial_monitor.poll() if denial_monitor else None
                    if stall:
                        if stall.get('category') == 'timeout':
                            result['execution_error'] = 'native execution timed out'
                        else:
                            result['stall'] = stall
                            result['stop_evidence'] = stall
                            result['execution_error'] = '%s: %s' % (
                                stall.get('category', 'stall'), stall.get('reason', ''))
                    if denial:
                        result['execution_error'] = 'native command policy denied; stopped without retry'
                        result['stop_evidence'] = denial
                    if cancelled or stall or denial or (not input_done.is_set() and time.monotonic() > input_deadline):
                        if not cancelled and not stall and not denial:
                            result["input_error"] = "stdin delivery timed out"
                        adapter.stop(process, spec)
                        if process.poll() is None:
                            stop_process(process)
                        break
                    time.sleep(0.05)
                result["exit_code"] = process.wait()
                result["process_ended_at"] = time.time()
                stall_monitor.poll()  # Drain lines written just before exit.
                result['max_turns_hit'] = stall_monitor.max_turns_hit
                writer.join(timeout=1)
                if input_errors or not input_done.is_set():
                    result["input_error"] = input_errors[0] if input_errors else "stdin writer did not finish"
            if adapter.owned_process:
                result['process_tree_confirmed_stopped'] = process.close(timeout=5)
                result['tree_closed_at'] = time.time()
                if not result['process_tree_confirmed_stopped']:
                    result['reason'] = 'owned process tree termination unconfirmed; resources retained'
                    queue.finish(task, 'unknown', result)
                    return
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
            from controller_usage import extract_usage
            result['usage'] = extract_usage(lines, adapter.name)
            for line in lines:
                try:
                    event = json.loads(line)
                    if event.get("type") in adapter.terminal_types:
                        result["terminal_event"] = event["type"]
                except (ValueError, AttributeError):
                    pass
            cancel_pending = queue.db.execute("SELECT cancel FROM tasks WHERE id=?", (task,)).fetchone()[0]
            result.update(adapter.parse_result(lines, spec, result, bool(cancel_pending)))
            if result.get('_force_unknown'):
                result['reason'] = result.pop('_force_unknown')
                queue.finish(task, 'unknown', result)
                return
            verified = []
            for item in spec.get("artifacts", []):
                path = inside(item["path"], spec["cwd"])
                ok = path.is_file()
                digest = hashlib.sha256(path.read_bytes()).hexdigest() if ok else None
                if item.get("sha256"):
                    ok = ok and digest == item["sha256"]
                verified.append({"path": str(path), "ok": ok, "sha256": digest})
            result["artifacts"] = verified
            result["artifacts_verified"] = all(a["ok"] for a in verified) if verified else None
            result["artifact_policy"] = "declared-files" if verified else "no-artifacts-declared"
            cancelled = queue.db.execute("SELECT cancel FROM tasks WHERE id=?", (task,)).fetchone()[0]
            success = (result["exit_code"] == 0 and result["terminal_event"] in adapter.success_events
                       and result["artifacts_verified"] is not False
                       and not result.get("input_error") and not result.get("execution_error")
                       and result.get('transport_policy_passed',True))
            queue.finish(task, "cancelled" if cancelled else "succeeded" if success else "failed", result)
        except Exception as exc:
            if process is not None and adapter.owned_process:
                result['error'] = str(exc)
                result['process_tree_confirmed_stopped'] = process.close(timeout=5)
                if adapter.shared_host:
                    result['reason'] = adapter.shared_failure_reason
                    queue.finish(task, 'unknown', result)
                    return
                if not result['process_tree_confirmed_stopped']:
                    result['reason'] = 'owned process tree termination unconfirmed; resources retained'
                    queue.finish(task,'unknown',result)
                    return
                queue.finish(task,'failed',result)
                return
            if process is not None and process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired) as cleanup_error:
                    result["error"] = str(exc)
                    result["cleanup_error"] = str(cleanup_error)
                    result["reason"] = "process termination unconfirmed; resources retained"
                    queue.finish(task, "unknown", result)
                    return
            result["error"] = str(exc)
            queue.finish(task, "failed", result)


def run(queue, idle_timeout, max_concurrency=2):
    with lock(queue.state / "worker.lock"):
        with queue.db:
            queue.db.execute("DELETE FROM control WHERE key='stop'")
        idle_since = time.monotonic()
        active = {}
        while True:
            for task, child in list(active.items()):
                if child.poll() is not None:
                    del active[task]
                    idle_since = time.monotonic()
            stopping = queue.db.execute("SELECT 1 FROM control WHERE key='stop'").fetchone()
            if stopping and not active:
                return
            while not stopping and queue.db.execute(
                    "SELECT COUNT(*) FROM tasks WHERE state IN ('running','unknown')").fetchone()[0] < max_concurrency:
                task = queue.claim()
                if not task:
                    break
                # Independent executor persists its own result if this controller exits unexpectedly.
                child = subprocess.Popen([sys.executable, "-B", str(BASE / "task_runner.py"),
                                          "--project-root", str(queue.project), "--state", str(queue.state), "_execute", task],
                                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                         stderr=subprocess.DEVNULL, **hidden_options(detached=True))
                active[task] = child
                idle_since = time.monotonic()
            if not active and time.monotonic() - idle_since >= idle_timeout:
                return
            time.sleep(0.05)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", required=True, help="project-internal durable state directory")
    parser.add_argument('--project-root', help='canonical project root; defaults to this shared project')
    sub = parser.add_subparsers(dest="action", required=True)
    enqueue = sub.add_parser("enqueue")
    enqueue.add_argument("manifest")
    enqueue.add_argument("--allow-test-adapter", action="store_true")
    sub.add_parser("status")
    sub.add_parser("events")
    for name in ("run", "launch"):
        p = sub.add_parser(name)
        p.add_argument("--idle-timeout", type=float, default=3)
        p.add_argument("--max-concurrency", type=int, default=2)
    sub.add_parser("shutdown")
    sub.add_parser("cancel").add_argument("task")
    sub.add_parser("_execute").add_argument("task")
    sub.add_parser("recover").add_argument("--retry", action="store_true")
    resolve = sub.add_parser("resolve-unknown")
    resolve.add_argument("task")
    resolve.add_argument("--confirm-no-process-running", action="store_true", required=True)
    args = parser.parse_args()
    queue = Queue(args.state, args.project_root)
    if args.action == "enqueue":
        print(queue.enqueue(json.loads(Path(args.manifest).read_text(encoding="utf-8-sig")), args.allow_test_adapter))
    elif args.action == "status":
        print(json.dumps(queue.status(), ensure_ascii=False, indent=2))
    elif args.action == "events":
        print(json.dumps([dict(r) for r in queue.db.execute("SELECT * FROM events ORDER BY seq")], indent=2))
    elif args.action == "cancel":
        queue.cancel(args.task)
    elif args.action == "recover":
        queue.recover(args.retry)
    elif args.action == "resolve-unknown":
        queue.resolve_unknown(args.task)
    elif args.action == "_execute":
        execute(queue, args.task)
    elif args.action == "shutdown":
        with queue.db:
            queue.db.execute("INSERT OR REPLACE INTO control VALUES('stop','1')")
    elif args.action == "run":
        if not 0 <= args.idle_timeout <= 3600:
            raise ValueError("idle timeout must be 0..3600")
        if not 1 <= args.max_concurrency <= 16:
            raise ValueError("max concurrency must be 1..16")
        run(queue, args.idle_timeout, args.max_concurrency)
    elif args.action == "launch":
        if not 0 <= args.idle_timeout <= 3600:
            raise ValueError("idle timeout must be 0..3600")
        if not 1 <= args.max_concurrency <= 16:
            raise ValueError("max concurrency must be 1..16")
        child = subprocess.Popen([sys.executable, "-B", str(BASE / "task_runner.py"), '--project-root', str(queue.project), "--state", str(queue.state),
                                  "run", "--idle-timeout", str(args.idle_timeout),
                                  "--max-concurrency", str(args.max_concurrency)],
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, **hidden_options(detached=True))
        print(json.dumps({"worker_pid": child.pid, "detached": True, "idle_timeout": args.idle_timeout,
                          "max_concurrency": args.max_concurrency}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, sqlite3.Error) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        sys.exit(2)
