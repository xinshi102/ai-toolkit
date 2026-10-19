"""Small project-scoped durable queue. Python standard library only."""
import argparse
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
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
PROJECTS_ROOT = Path(os.environ.get('XINSHI_PROJECTS_ROOT', str(PROJECT.parent))).absolute()


def dsh_program():
    configured = os.environ.get('XINSHI_DSH_PROGRAM')
    if not configured or not Path(configured).is_absolute() or not Path(configured).is_dir():
        raise ValueError('set XINSHI_DSH_PROGRAM to the absolute DSH installation directory')
    return Path(configured)
STATES = ("queued", "running", "succeeded", "failed", "cancelled", "interrupted", "blocked", "unknown")
DISABLED_FEATURES = ("hooks", "plugins", "remote_plugin", "apps", "computer_use", "browser_use",
                     "browser_use_external", "image_generation", "multi_agent", "workspace_dependencies")


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
            approved = PROJECTS_ROOT
            if not self.project.is_relative_to(approved) or not self.project.is_dir():
                raise ValueError('project root must be an existing project under XINSHI_PROJECTS_ROOT')
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
        adapter = spec.get("adapter", "codex")
        if adapter not in ("codex", "codex-workspace", "dsh", "dsh-text", "dsh-workspace", "codebuddy-workspace", "local-test"):
            raise ValueError("unknown adapter")
        if spec['permission'] == 'workspace-write' and adapter not in ('codex-workspace', 'dsh-workspace', 'codebuddy-workspace'):
            raise ValueError('workspace-write requires an explicit workspace adapter')
        if adapter == 'codex-workspace' and spec['permission'] != 'workspace-write':
            raise ValueError('codex-workspace requires workspace-write')
        if adapter in ('dsh-workspace', 'codebuddy-workspace') and spec['permission'] not in ('workspace-write','read-only'):
            raise ValueError('workspace provider requires explicit native permission')
        if adapter == "local-test" and not allow_test:
            raise ValueError("local adapter requires --allow-test-adapter")
        if adapter == "local-test":
            allowed_test_roots = (PROJECT / '.work/runtime-tests', self.project / '.work/runtime-tests')
            if not any(cwd.resolve().is_relative_to(p.resolve()) for p in allowed_test_roots):
                raise ValueError('local-test cwd must be a dedicated engine fixture directory')
        if adapter == "dsh-text":
            if spec["permission"] != "read-only" or spec.get("external_tools"):
                raise ValueError("dsh-text accepts read-only with no external tools only")
            timeout = spec.get("timeout_seconds", 180)
            if type(timeout) not in (int, float) or not 10 <= timeout <= 600:
                raise ValueError("dsh-text timeout_seconds must be 10..600")
        if adapter in ('codex','codex-workspace','dsh-workspace','codebuddy-workspace'):
            timeout = spec.get('timeout_seconds',600)
            if type(timeout) not in (int,float) or not 10 <= timeout <= 3600:
                raise ValueError('native execution timeout_seconds must be 10..3600')
        if not isinstance(spec.get("prompt", ""), str):
            raise ValueError("prompt must be a string")
        if len(spec.get("prompt", "").encode("utf-8")) > 65536:
            raise ValueError("prompt exceeds 64 KiB input bound")
        for field in ("depends_on", "resources"):
            if not isinstance(spec.get(field, []), list) or any(
                    not isinstance(x, str) or not x.strip() for x in spec.get(field, [])):
                raise ValueError(f"{field} must contain nonblank strings")
        artifacts = spec.get("artifacts", [])
        if not isinstance(artifacts, list):
            raise ValueError("artifacts must be a list")
        for item in artifacts:
            if not isinstance(item, dict) or "path" not in item:
                raise ValueError("artifact path required")
            inside(item["path"], cwd)
        spec["artifacts"] = [dict(item, path=str(inside(item["path"], cwd))) for item in artifacts]
        if adapter == "local-test":
            delay = spec.get("delay", 0)
            if type(delay) not in (int, float) or not 0 <= delay <= 60:
                raise ValueError("test delay must be 0..60 seconds")
            if type(spec.get("exit_code", 0)) is not int:
                raise ValueError("test exit code must be int")
            if type(spec.get("test_ignore_stdin", False)) is not bool:
                raise ValueError("test_ignore_stdin must be bool")
        return spec

    def enqueue(self, spec, allow_test=False):
        spec = self.validate(spec, allow_test)
        task = uuid.uuid4().hex
        with self.db:
            for dep in spec.get("depends_on", []):
                if not self.db.execute("SELECT 1 FROM tasks WHERE id=?", (dep,)).fetchone():
                    raise ValueError(f"unknown dependency {dep}")
            self.db.execute("INSERT INTO tasks(id,spec,state,updated) VALUES(?,?,?,?)",
                            (task, json.dumps(spec), "queued", time.time()))
            self.event(task, "enqueued", {"test_only": spec.get("adapter") == "local-test"})
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

    def recover(self, retry=False):
        # Exclude launch/recover races with a live worker. OS lock survives stale files.
        with lock(self.state / "worker.lock"):
            for row in self.db.execute("SELECT * FROM tasks WHERE state IN ('running','unknown')").fetchall():
                try:
                    with lock(self.state / (row["id"] + ".lock")):
                        previous = json.loads(row["result"]) if row["result"] else {}
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
            if pid_alive(row["pid"]):
                raise ValueError("recorded PID is still alive; verify identity before retry")
            self.finish(task, "cancelled" if row["cancel"] else "interrupted",
                        {"reason": "operator explicitly confirmed no task process remains"})


def hidden_options(detached=False):
    if os.name == "nt":
        flags = subprocess.CREATE_NO_WINDOW
        if detached:
            flags |= subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        return {"creationflags": flags}
    return {"start_new_session": True} if detached else {}


def native_request(spec):
    """Auditable request construction only; this does not grant execution permission."""
    if spec.get("adapter", "codex") == "dsh":
        program = dsh_program()
        return {"argv": [str(program / "DeepSeek Harness.exe"),
                         str(program / "resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
                         "headless", "--json", "-"], "stdin": spec.get("prompt", ""),
                "cwd": spec["cwd"], "env_delta": {"ELECTRON_RUN_AS_NODE": "1"}}
    binary = shutil.which("codex.exe" if os.name == "nt" else "codex")
    if not binary:
        raise ValueError("native harness executable not available")
    # Batch launchers would implicitly introduce cmd.exe parsing. Require a native executable.
    if os.name == "nt" and Path(binary).suffix.lower() not in (".exe", ".com"):
        raise ValueError("native .exe harness required; batch launchers are not accepted")
    return {"argv": [binary, "--no-daemon", "-a", "never", "--cd", spec["cwd"],
                     "exec", "--ephemeral", "--skip-git-repo-check", "--json",
                     "--sandbox", "workspace-write" if spec.get('adapter') == 'codex-workspace' else "read-only", "-"], "stdin": spec.get("prompt", ""),
            "cwd": spec["cwd"], "env_delta": {}}


def restricted_codex_request(spec):
    request = native_request(spec)
    binary = request["argv"][0]
    def probe(argv):
        completed = subprocess.run(argv, cwd=spec["cwd"], capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=20, shell=False,
                                   **hidden_options())
        if completed.returncode:
            raise ValueError("native permission preflight failed (raw configuration output withheld)")
        return completed.stdout
    def mcp_summary(output):
        value = json.loads(output)
        if not isinstance(value, list):
            raise ValueError("unrecognized MCP list schema")
        summary = []
        for item in value:
            name, enabled = item.get("name"), item.get("enabled")
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name) or type(enabled) is not bool:
                raise ValueError("unverifiable MCP identity or state")
            summary.append({"name": name, "enabled": enabled})
        return summary
    discovered = mcp_summary(probe([binary, "--no-daemon", "mcp", "list", "--json"]))
    options = ["-c", "notify=[]"]
    for feature in DISABLED_FEATURES:
        options += ["--disable", feature]
    for item in discovered:
        options += ["-c", f"mcp_servers.{item['name']}.enabled=false"]
    prefix = [binary, "--no-daemon", *options]
    features = {}
    for line in probe([*prefix, "features", "list"]).splitlines():
        cells = line.split()
        if len(cells) >= 3 and cells[-1] in ("true", "false"):
            features[cells[0]] = cells[-1] == "true"
    if any(features.get(feature) is not False for feature in DISABLED_FEATURES):
        raise ValueError("required capability disable could not be verified")
    effective = mcp_summary(probe([*prefix, "mcp", "list", "--json"]))
    if {v["name"] for v in effective} != {v["name"] for v in discovered} or any(v["enabled"] for v in effective):
        raise ValueError("effective MCP disable verification failed")
    request["argv"] = [binary, *options, *request["argv"][1:]]
    request["preflight"] = {"features": {f: False for f in DISABLED_FEATURES}, "mcp": effective,
                            "scope": "single-invocation audited feature/MCP disables plus native shell sandbox",
                            "sandbox": 'workspace-write' if spec.get('adapter') == 'codex-workspace' else 'read-only'}
    return request


def restricted_dsh_text_request(spec):
    """Prompt-only DSH; the required plugin denies every tool before execution."""
    program = dsh_program()
    binary = program / "DeepSeek Harness.exe"
    archive = program / "resources/app.asar"
    script = archive / "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
    patch, guard = BASE / "dsh-text.patch.yml", BASE / "dsh-text-guard.mjs"
    # app.asar is one OS file: only Electron's fs can stat its virtual contents.
    if not all(path.is_file() for path in (binary, archive, patch, guard)):
        raise ValueError("dsh-text executable or required protection files missing")
    probe_script = ("const fs=require('node:fs');process.stdout.write(JSON.stringify({entry_file:"
                    "fs.statSync(" + json.dumps(str(script)) + ").isFile()}));")
    probe = subprocess.run([str(binary), "-e", probe_script], cwd=spec["cwd"],
        env=dict(os.environ, ELECTRON_RUN_AS_NODE="1"), capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=20, shell=False, **hidden_options())
    try:
        entry_verified = probe.returncode == 0 and json.loads(probe.stdout) == {"entry_file": True}
    except ValueError:
        entry_verified = False
    if not entry_verified:
        raise ValueError("dsh-text fixed ASAR entry preflight failed; native diagnostic output withheld")
    from patch_config import render_patch
    patch = render_patch(patch)
    return {"argv": [str(binary), str(script), "--profile", "headless", "--patch",
                     str(patch), "--json", "-"],
            "stdin": spec.get("prompt", ""), "cwd": spec["cwd"],
            "env_delta": {"ELECTRON_RUN_AS_NODE": "1", "DSH_PERMISSION_MODE": "read-only",
                          "XINSHI_RUNTIME_DIR": str(BASE).replace('\\', '/')}}


def parse_dsh_text_log(lines):
    """Transport/policy proof only. The controller must accept answer semantics."""
    audits, events, errors = [], [], []
    for line in lines:
        if line.startswith("DSH_TEXT_AUDIT "):
            try:
                audit = json.loads(line[len("DSH_TEXT_AUDIT "):])
                if not isinstance(audit, dict):
                    raise ValueError("not an object")
                audits.append(audit)
            except ValueError:
                errors.append("malformed guard audit")
        else:
            try:
                event = json.loads(line)
                if isinstance(event, dict):
                    events.append(event)
            except ValueError:
                pass  # Native startup diagnostics are not NDJSON events.
    ready = [a for a in audits if a.get("type") == "guard_ready"]
    sessions = [e for e in events if e.get("type") == "session"]
    session_id = sessions[0].get("sessionId") if len(sessions) == 1 else None
    policies = [a for a in audits if a.get("type") == "effective_policy"]
    policy_ok = bool(session_id and policies) and all(
        p.get("sessionId") == session_id and p.get("sandbox") == "read-only"
        and p.get("approval") == "never" and p.get("allToolsDenied") is True
        and p.get("valid") is True for p in policies)
    blocked = sum(a.get("type") == "blocked_tool" for a in audits)
    tools = sum(e.get("type") in ("tool_call", "tool_result") for e in events)
    ends = [e for e in events if e.get("type") == "status" and e.get("phase") == "turn_end"]
    completed = len(ends) == 1 and ends[0].get("reason", {}).get("kind") == "completed"
    finals = [e for e in events if e.get("type") == "final"]
    final = finals[0].get("text") if len(finals) == 1 else None
    guard_ok = len(ready) == 1 and ready[0].get("allToolsDenied") is True
    if any(e.get("type") == "error" for e in events):
        errors.append("native error event")
    passed = bool(guard_ok and policy_ok and completed and isinstance(final, str)
                  and final.strip() and not blocked and not tools and not errors)
    result = {"guard_ready": guard_ok, "session_id": session_id,
              "effective_policies": policies, "blocked_tool_count": blocked,
              "tool_event_count": tools, "policy_verified": policy_ok,
              "protocol_errors": errors, "transport_policy_passed": passed,
              "terminal_event": "turn.completed" if passed else "dsh-text.rejected",
              "final_text": final, "semantic_acceptance": "controller-required"}
    if isinstance(final, str):
        try:
            result["final_json"] = json.loads(final)
        except ValueError:
            pass
    return result


def command(spec):
    if spec.get("adapter", "codex") == "local-test":
        argv = [sys.executable, "-B", str(BASE / "local_adapter.py")]
        if spec.get("test_ignore_stdin"):
            argv += ["--ignore-stdin", str(spec.get("delay", 0))]
        return argv, json.dumps(spec)
    if spec.get("adapter") == "dsh-text":
        request = restricted_dsh_text_request(spec)
        spec['_native_env'] = request['env_delta']
        spec["_preflight"] = {"fixed_asar_entry_verified": True,
                              "scope": "Electron filesystem stat only; no model inference"}
        return request["argv"], request["stdin"]
    if spec.get('adapter') == 'dsh-workspace':
        from dsh_workspace import request as dsh_request
        request = dsh_request(spec)
        spec['_native_env'] = request['env_delta']
        spec['_preflight'] = request.get('preflight', {'permission': spec['permission']})
        return request['argv'], request['stdin']
    if spec.get('adapter') == 'codebuddy-workspace':
        from codebuddy_workspace import request as codebuddy_request
        request = codebuddy_request(spec)
        spec['_native_env'] = request['env_delta']
        spec['_preflight'] = request['preflight']
        return request['argv'], request['stdin']
    native_request(spec)  # Constructed but never launched without a verified permission profile.
    if spec.get("adapter", "codex") in ("codex", "codex-workspace"):
        request = restricted_codex_request(spec)
        spec["_preflight"] = request["preflight"]
        return request["argv"], request["stdin"]
    raise ValueError("dsh native read-only CLI flags not verified; adapter disabled pending verification")


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
        result = {"exit_code": None, "terminal_event": None, "artifacts_verified": False,
                  "test_only": spec.get("adapter") == "local-test",
                  "permission_scope": spec.get("permission"), "external_tools": spec.get("external_tools"),
                  "attempt_id": row["attempt_id"]}
        process = None
        try:
            spec = queue.validate(spec, allow_test=True)  # Revalidate paths immediately before execution.
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
                if spec.get('adapter') in ('codex-workspace','dsh-workspace','codebuddy-workspace'):
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
                execution_deadline = time.monotonic() + spec.get("timeout_seconds", 180 if spec.get('adapter')=='dsh-text' else 600)
                while process.poll() is None:
                    cancelled = queue.db.execute("SELECT cancel FROM tasks WHERE id=?", (task,)).fetchone()[0]
                    timed_out = spec.get("adapter") != "local-test" and time.monotonic() > execution_deadline
                    if cancelled or timed_out or (not input_done.is_set() and time.monotonic() > input_deadline):
                        if timed_out:
                            result["execution_error"] = "native execution timed out"
                        elif not cancelled:
                            result["input_error"] = "stdin delivery timed out"
                        process.terminate()  # Only this task's directly owned Popen object.
                        try:
                            process.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            process.kill()
                        break
                    time.sleep(0.05)
                result["exit_code"] = process.wait()
                result["process_ended_at"] = time.time()
                writer.join(timeout=1)
                if input_errors or not input_done.is_set():
                    result["input_error"] = input_errors[0] if input_errors else "stdin writer did not finish"
            if spec.get('adapter') in ('codex-workspace','dsh-workspace','codebuddy-workspace'):
                result['process_tree_confirmed_stopped'] = process.close(timeout=5)
                result['tree_closed_at'] = time.time()
                if not result['process_tree_confirmed_stopped']:
                    result['reason'] = 'owned process tree termination unconfirmed; resources retained'
                    queue.finish(task, 'unknown', result)
                    return
            terminal_types = ("local_test.completed",) if result["test_only"] else ("turn.completed", "turn.failed", "error")
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
            for line in lines:
                try:
                    event = json.loads(line)
                    if event.get("type") in terminal_types:
                        result["terminal_event"] = event["type"]
                except (ValueError, AttributeError):
                    pass
            if spec.get("adapter") == "dsh-text":
                result.update(parse_dsh_text_log(lines))
            elif spec.get('adapter') == 'dsh-workspace':
                from dsh_workspace import parse_log
                result.update(parse_log(lines, spec['permission']))
            elif spec.get('adapter') == 'codebuddy-workspace':
                from codebuddy_workspace import parse_log
                parsed = parse_log(lines, spec['permission'])
                result.update(parsed)
                result['native_terminal_event'] = parsed['terminal_event']
                result['terminal_event'] = 'turn.completed' if parsed['transport_policy_passed'] else 'turn.failed'
            elif spec.get('adapter','codex') in ('codex','codex-workspace'):
                native_events=[]
                for line in lines:
                    try:
                        event=json.loads(line)
                        if isinstance(event,dict): native_events.append(event)
                    except ValueError:
                        pass
                finals=[e['item']['text'] for e in native_events if e.get('type')=='item.completed'
                        and e.get('item',{}).get('type')=='agent_message' and isinstance(e['item'].get('text'),str)]
                if finals:
                    result['final_text']=finals[-1]
                    try: result['final_json']=json.loads(finals[-1])
                    except ValueError: pass
                result['transport_policy_passed']=bool(finals and result['terminal_event']=='turn.completed'
                    and not any(e.get('type') in ('error','turn.failed') for e in native_events))
                result['semantic_acceptance']='controller-required'
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
            success = (result["exit_code"] == 0 and result["terminal_event"] in
                       ("local_test.completed", "turn.completed") and result["artifacts_verified"] is not False
                       and not result.get("input_error") and not result.get("execution_error")
                       and result.get('transport_policy_passed',True))
            queue.finish(task, "cancelled" if cancelled else "succeeded" if success else "failed", result)
        except Exception as exc:
            if process is not None and spec.get('adapter') in ('codex-workspace','dsh-workspace','codebuddy-workspace'):
                result['error'] = str(exc)
                result['process_tree_confirmed_stopped'] = process.close(timeout=5)
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
