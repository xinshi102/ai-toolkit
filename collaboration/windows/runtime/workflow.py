"""Project-scoped workflow controller over the existing durable Queue.

Agents produce the graph; people need not maintain it. This module executes explicit
dependencies and acceptance rules, not autonomous semantic planning.
"""
import argparse
import contextlib
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from task_runner import BASE, PROJECT, Queue, hidden_options, inside, lock

MAX_BINDING = 32768
TERMINAL = {"succeeded", "failed", "cancelled", "blocked", "interrupted", "unknown"}
_BACKGROUND_WORKERS = []


@contextlib.contextmanager
def state_lock(path, timeout=2):
    """Wait briefly for a concurrent state edit; never retry body exceptions."""
    deadline = time.monotonic() + timeout
    with contextlib.ExitStack() as stack:
        while True:
            try:
                stack.enter_context(lock(path))
                break
            except (PermissionError, BlockingIOError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(min(0.01, max(0, deadline - time.monotonic())))
        yield


def relative_path(root, name):
    if not isinstance(name, str) or not name or Path(name).is_absolute() or re.match(r"^[A-Za-z]:", name):
        raise ValueError("write/check/binding path must be relative")
    if ".." in Path(name.replace("\\", "/")).parts:
        raise ValueError("parent path traversal forbidden")
    return inside(root / name, root)


def overlap(a, b):
    a, b = os.path.normcase(str(a)), os.path.normcase(str(b))
    return a == b or a.startswith(b.rstrip("/\\") + os.sep) or b.startswith(a.rstrip("/\\") + os.sep)


class Workflow:
    def __init__(self, root, state):
        self.root = Path(root).absolute()
        self.state = inside(Path(state).absolute(), self.root)
        self.state.mkdir(parents=True, exist_ok=True)
        self.path = self.state / "workflow.json"

    def load(self):
        data = json.loads(self.path.read_text(encoding="utf-8"))
        if os.path.normcase(data.get("project_root", "")) != os.path.normcase(str(self.root)):
            raise ValueError("workflow project root binding differs")
        return data

    def save(self, data):
        temporary = self.state / ("workflow-" + uuid.uuid4().hex + ".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, self.path)

    def queue(self):
        return Queue(self.state / "queue", project_root=self.root)

    def validate(self, graph):
        nodes = graph.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            raise ValueError("nonempty nodes array required")
        ids = [n.get("id") for n in nodes]
        if any(not isinstance(i, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", i) for i in ids) or len(set(ids)) != len(ids):
            raise ValueError("node IDs must be unique safe strings")
        by_id = {n["id"]: n for n in nodes}
        for node in nodes:
            if not isinstance(node.get("depends_on", []), list) or any(d not in by_id for d in node.get("depends_on", [])):
                raise ValueError("unknown dependency")
            if not isinstance(node.get("prompt", ""), str):
                raise ValueError("prompt must be text")
            if type(node.get("input_version", 1)) is not int or node.get("input_version", 1) < 1:
                raise ValueError("input_version must be a positive integer")
            if not node.get("external"):
                if node.get("provider", "codex") not in ("codex", "codex-workspace", "dsh-workspace", "codebuddy-workspace", "dsh-text", "local-test"):
                    raise ValueError("unknown provider")
                if not node.get("owner"):
                    raise ValueError("owner required")
                if not isinstance(node.get("checks"), list) or not node["checks"]:
                    raise ValueError("explicit acceptance checks required")
            if not isinstance(node.get("write_paths", []), list):
                raise ValueError("write_paths must be array")
            for name in node.get("write_paths", []):
                relative_path(self.root, name)
            for check in node.get("checks", []):
                kind = check.get("kind")
                if kind not in ("file_exists", "file_contains", "file_json_keys", "final_json_keys", "final_json_values", "python_unittest"):
                    raise ValueError("unknown check kind")
                if kind.startswith("file_"):
                    relative_path(self.root, check.get("path"))
                if kind == "file_contains" and (not isinstance(check.get("contains"), str) or not check["contains"]):
                    raise ValueError("file_contains requires nonempty text")
                if kind.endswith("json_keys") and (not isinstance(check.get("keys"), list) or not check["keys"]):
                    raise ValueError("json_keys requires nonempty keys")
                if kind == "final_json_values" and (not isinstance(check.get("values"), dict) or not check["values"]):
                    raise ValueError("final_json_values requires nonempty values")
                if kind == "python_unittest":
                    if not isinstance(check.get("module"), str) or not re.fullmatch(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*", check["module"]):
                        raise ValueError("unittest module must be a dotted Python identifier")
                    relative_path(self.root, check.get("cwd", "."))
                    duration = check.get("timeout_seconds", 60)
                    if type(duration) not in (int, float) or not 1 <= duration <= 180:
                        raise ValueError("unittest timeout must be 1..180")
            for match in re.finditer(r"\{\{(?:result|file):([^}:]+)(?::[^}]+)?\}\}", node.get("prompt", "")):
                if match[1] not in node.get("depends_on", []):
                    raise ValueError("bindings require an explicit direct dependency")
        visiting, visited = set(), set()
        def visit(node_id):
            if node_id in visiting:
                raise ValueError("dependency cycle")
            if node_id in visited:
                return
            visiting.add(node_id)
            for dep in by_id[node_id].get("depends_on", []):
                visit(dep)
            visiting.remove(node_id)
            visited.add(node_id)
        for node_id in ids:
            visit(node_id)

    def init(self, graph):
        self.validate(graph)
        reserved = {"status", "attempts", "task_id", "pending_binding", "result", "checks_result", "reason"}
        if any(reserved.intersection(n) for n in graph["nodes"]):
            raise ValueError("initial nodes cannot contain runtime-owned fields")
        with state_lock(self.state / "state.lock"):
            if self.path.exists():
                raise ValueError("workflow already initialized")
            data = {"id": graph.get("id", uuid.uuid4().hex), "revision": 1, "project_root": str(self.root),
                    "input_version": graph.get("version", 1), "nodes": copy.deepcopy(graph["nodes"]),
                    "history": [], "status": "ready"}
            for n in data["nodes"]:
                n.update(status="waiting" if n.get("external") else "pending", attempts=[])
            self.save(data)
            return data

    def bind(self, node, nodes):
        def replacement(match):
            kind, node_id, name = match[1], match[2], match[3]
            source = nodes[node_id]
            if source["status"] != "accepted":
                raise ValueError("binding source not accepted")
            if kind == "result":
                value = json.dumps(source.get("result"), ensure_ascii=False)
            else:
                path = relative_path(self.root, name)
                allowed = [relative_path(self.root, x) for x in source.get("write_paths", [])]
                if not any(path == p or path.is_relative_to(p) for p in allowed):
                    raise ValueError("artifact binding outside producer write_paths")
                if path.stat().st_size > MAX_BINDING:
                    raise ValueError("artifact binding exceeds 32 KiB")
                verified = next((c for c in source.get("checks_result", []) if c.get("ok") and c.get("sha256")
                                 and c.get("check", {}).get("kind", "").startswith("file_")
                                 and relative_path(self.root, c["check"]["path"]) == path), None)
                if verified is None:
                    raise ValueError("artifact binding requires an accepted file snapshot check")
                raw = path.read_bytes()
                if hashlib.sha256(raw).hexdigest() != verified["sha256"]:
                    raise ValueError("artifact changed since acceptance; revise producer before binding")
                value = raw.decode("utf-8")
            if len(value.encode("utf-8")) > MAX_BINDING:
                raise ValueError("result binding exceeds 32 KiB")
            return value
        return re.sub(r"\{\{(result|file):([^}:]+)(?::([^}]+))?\}\}", replacement, node.get("prompt", ""))

    def check(self, node, result, deadline=None):
        findings = []
        for rule in node["checks"]:
            try:
                kind = rule["kind"]
                detail = {}
                if kind == "python_unittest":
                    budget = None if deadline is None else deadline - time.monotonic()
                    if budget is not None and budget <= 0:
                        findings.append({"check": rule, "ok": False, "deferred": True, "reason": "controller time budget exhausted"})
                        continue
                    completed = subprocess.run([sys.executable, "-B", "-m", "unittest", "-v", rule["module"]],
                        cwd=relative_path(self.root, rule.get("cwd", ".")), stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=min(rule.get("timeout_seconds", 60), budget) if budget is not None else rule.get("timeout_seconds", 60),
                        text=True, encoding="utf-8", errors="replace", shell=False, **hidden_options())
                    detail = {"exit_code": completed.returncode, "output": completed.stdout[-16384:]}
                    if completed.returncode != 0:
                        findings.append({"check": rule, "ok": False, **detail, "reason": "unittest failed"})
                        continue
                elif kind.startswith("file_"):
                    path = relative_path(self.root, rule["path"])
                    if not path.is_file():
                        raise ValueError("file missing")
                    digest = hashlib.sha256()
                    with path.open("rb") as stream:
                        for chunk in iter(lambda: stream.read(65536), b""):
                            digest.update(chunk)
                    detail = {"sha256": digest.hexdigest()}
                    if kind != "file_exists":
                        if path.stat().st_size > 1048576:
                            raise ValueError("check file exceeds 1 MiB")
                        raw = path.read_bytes()
                        detail = {"sha256": hashlib.sha256(raw).hexdigest()}
                        text = raw.decode("utf-8-sig")
                        if kind == "file_contains" and rule["contains"] not in text:
                            raise ValueError("required text absent")
                        if kind == "file_json_keys":
                            obj = json.loads(text)
                            if not isinstance(obj, dict) or any(k not in obj for k in rule["keys"]):
                                raise ValueError("JSON keys absent")
                else:
                    obj = result.get("final_json")
                    if not isinstance(obj, dict):
                        raise ValueError("strict final JSON object required")
                    if kind == "final_json_keys" and any(k not in obj for k in rule["keys"]):
                        raise ValueError("final JSON keys absent")
                    if kind == "final_json_values" and any(k not in obj or type(obj[k]) is not type(v) or obj[k] != v for k, v in rule["values"].items()):
                        raise ValueError("final JSON values differ")
                findings.append({"check": rule, "ok": True, **detail})
            except subprocess.TimeoutExpired as exc:
                findings.append({"check": rule, "ok": False, "deferred": deadline is not None and time.monotonic() >= deadline,
                                 "reason": str(exc)})
            except (OSError, ValueError, TypeError) as exc:
                findings.append({"check": rule, "ok": False, "reason": str(exc)})
        return findings

    def tick(self, allow_test=False, deadline=None):
        # Run project validation outside the state lock. A concurrent revise/cancel
        # may invalidate this receipt; task ID + input version gate the writeback.
        snapshot = self.load()
        inspection = self.queue()
        try:
            observed = {r["id"]: r for r in inspection.status()}
        finally:
            inspection.db.close()
        checked = {}
        for node in snapshot["nodes"]:
            row = observed.get(node.get("task_id"))
            if node["status"] == "running" and row and row["state"] == "succeeded":
                checked[(node["id"], node["task_id"], node.get("input_version", 1))] = self.check(node, row.get("result") or {}, deadline)
        with state_lock(self.state / "state.lock"):
            data = self.load()
            queue = self.queue()
            try:
                rows = {r["id"]: r for r in queue.status()}
                by_binding = {r["spec"].get("workflow_binding"): r for r in rows.values()}
                nodes = {n["id"]: n for n in data["nodes"]}
                for node in nodes.values():
                    if node.get("pending_binding") and not node.get("task_id"):
                        row = by_binding.get(node["pending_binding"])
                        if row:
                            node["task_id"] = row["id"]
                            node["attempts"].append(row["id"])
                            node["status"] = "running"
                    if node.get("task_id") and node["status"] == "running":
                        row = rows.get(node["task_id"])
                        if row and row["state"] in TERMINAL:
                            checks = checked.get((node["id"], node["task_id"], node.get("input_version", 1)))
                            if row["state"] == "succeeded" and (checks is None or any(c.get("deferred") for c in checks)):
                                continue
                            node["result"] = row.get("result") or {}
                            node["checks_result"] = checks if row["state"] == "succeeded" else []
                            node["status"] = "accepted" if row["state"] == "succeeded" and all(c["ok"] for c in node["checks_result"]) else "failed"
                            node["reason"] = None if node["status"] == "accepted" else "transport or explicit acceptance failed"
                active = [n for n in nodes.values() if n["status"] == "running"]
                for node in nodes.values():
                    if node["status"] not in ("pending", "stale", "blocked") or node.get("external"):
                        continue
                    dependencies = [nodes[d] for d in node.get("depends_on", [])]
                    if any(d["status"] in ("failed", "cancelled", "blocked") for d in dependencies):
                        node.update(status="blocked", reason="dependency not accepted: " + ",".join(d["id"] for d in dependencies if d["status"] in ("failed", "cancelled", "blocked")))
                        continue
                    if any(d["status"] != "accepted" for d in dependencies):
                        node.update(status="pending", reason="waiting for accepted dependencies")
                        continue
                    paths = [relative_path(self.root, p) for p in node.get("write_paths", [])]
                    # Cancelled/revised attempts retain their reservation until the runner has stopped them.
                    reservations = list(active)
                    for prior in list(nodes.values()) + data["history"]:
                        if prior.get("task_id") in rows and rows[prior["task_id"]]["state"] not in TERMINAL - {"unknown"}:
                            reservations.append(prior)
                    if any(overlap(a, relative_path(self.root, b)) for a in paths for other in reservations for b in other.get("write_paths", [])):
                        node["reason"] = "waiting for overlapping write scope"
                        continue
                    try:
                        prompt = self.bind(node, nodes)
                        provider = node.get("provider", "codex")
                        spec = copy.deepcopy(node.get("queue_spec", {}))
                        spec.update(adapter=provider, cwd=str(self.root), prompt=prompt, depends_on=[],
                                    resources=sorted(set(node.get("resources", []) + ["write:" + os.path.normcase(str(p)) for p in paths])),
                                    permission=node.get("permission", "workspace-write" if provider.endswith("workspace") else "read-only"))
                        binding = node.get("pending_binding") or data["id"] + ":" + node["id"] + ":" + uuid.uuid4().hex
                        spec["workflow_binding"] = binding
                        node["pending_binding"] = binding
                        # Persist identity before enqueue: recovery reconciles any enqueue/save interruption.
                        self.save(data)
                        task_id = queue.enqueue(spec, allow_test=allow_test)
                        node.update(task_id=task_id, status="running", reason=None)
                        node["attempts"].append(task_id)
                        active.append(node)
                    except (ValueError, OSError) as exc:
                        node.update(status="failed", reason=str(exc))
                states = [n["status"] for n in nodes.values()]
                data["status"] = "accepted" if all(s == "accepted" for s in states) else "running" if "running" in states else "needs_attention"
                self.save(data)
                return data
            finally:
                queue.db.close()

    def revise(self, change):
        with state_lock(self.state / "state.lock"):
            data = self.load()
            if change.get("expected_revision") != data["revision"]:
                raise ValueError("revision conflict")
            by_id = {n["id"]: n for n in data["nodes"]}
            originals = copy.deepcopy(by_id)
            changed = set()
            reserved = {"status", "attempts", "task_id", "pending_binding", "result", "checks_result", "reason"}
            for patch in change.get("nodes", []):
                node_id = patch["id"]
                if reserved.intersection(patch):
                    raise ValueError("cannot revise runtime-owned fields")
                if node_id not in by_id:
                    by_id[node_id] = dict(patch, status="pending", attempts=[])
                    data["nodes"].append(by_id[node_id])
                else:
                    by_id[node_id].update(patch)
                changed.add(node_id)
            changed.update(change.get("retry", []))
            changed.update(change.get("inputs", {}).keys())
            if not changed.issubset(by_id):
                raise ValueError("unknown revised node")
            for node_id in change.get("inputs", {}):
                if not by_id[node_id].get("external"):
                    raise ValueError("input updates require external nodes")
            self.validate(data)
            affected = set(changed)
            while True:
                new = {n["id"] for n in data["nodes"] if affected.intersection(n.get("depends_on", []))}
                if new.issubset(affected):
                    break
                affected.update(new)
            queue = self.queue()
            try:
                pending = {r["spec"].get("workflow_binding"): r["id"] for r in queue.status()}
                for node_id in affected:
                    node = by_id[node_id]
                    if node.get("pending_binding") and not node.get("task_id"):
                        task = pending.get(node["pending_binding"])
                        if task:
                            node["task_id"] = task
                            originals[node_id]["task_id"] = task
                    data["history"].append(copy.deepcopy(originals.get(node_id, node)))
                    if node.get("task_id"):
                        queue.cancel(node["task_id"])
                    for key in ("task_id", "pending_binding", "result", "checks_result", "reason"):
                        node.pop(key, None)
                    node["input_version"] = node.get("input_version", 1) + 1
                    node["status"] = "waiting" if node.get("external") else "stale"
                for node_id, payload in change.get("inputs", {}).items():
                    node = by_id[node_id]
                    node["result"] = payload.get("result")
                    node["status"] = "accepted"
                data["revision"] += 1
                data["status"] = "ready"
                self.save(data)
                return data
            finally:
                queue.db.close()

    def cancel(self, node_id):
        with state_lock(self.state / "state.lock"):
            data = self.load()
            node = next((n for n in data["nodes"] if n["id"] == node_id), None)
            if node is None:
                raise ValueError("unknown workflow node")
            if node["status"] in ("accepted", "failed", "cancelled"):
                return data  # Replacing accepted/failed evidence is a revise operation.
            queue = self.queue()
            try:
                if node.get("pending_binding") and not node.get("task_id"):
                    row = next((r for r in queue.status() if r["spec"].get("workflow_binding") == node["pending_binding"]), None)
                    if row:
                        node["task_id"] = row["id"]
                if node.get("task_id"):
                    queue.cancel(node["task_id"])
                node.update(status="cancelled", reason="cancelled by controller")
                data["revision"] += 1
                data["status"] = "running" if any(n["status"] == "running" for n in data["nodes"]) else "needs_attention"
                self.save(data)
                return data
            finally:
                queue.db.close()

    def run(self, max_concurrency=2, timeout_seconds=None, allow_test=False):
        if not 1 <= max_concurrency <= 16 or timeout_seconds is not None and timeout_seconds <= 0:
            raise ValueError("invalid concurrency or timeout")
        worker = None
        started = time.monotonic()
        deadline = None if timeout_seconds is None else started + timeout_seconds
        with lock(self.state / "controller.lock"):
            while True:
                data = self.tick(allow_test, deadline)
                if data["status"] in ("accepted", "needs_attention"):
                    if worker is not None:
                        try:
                            worker.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            _BACKGROUND_WORKERS.append(worker)
                    return data
                if timeout_seconds is not None and time.monotonic() - started >= timeout_seconds:
                    if worker is not None and worker.poll() is None:
                        _BACKGROUND_WORKERS.append(worker)
                    return dict(data, status="timeout", resumable=True)
                if worker is None or worker.poll() is not None:
                    worker = subprocess.Popen([sys.executable, "-B", str(BASE / "task_runner.py"),
                        "--project-root", str(self.root), "--state", str(self.state / "queue"), "run",
                        "--idle-timeout", "1", "--max-concurrency", str(max_concurrency)],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        **hidden_options())
                time.sleep(0.1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", default=str(PROJECT))
    parser.add_argument("--state", required=True)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("init").add_argument("manifest")
    p = sub.add_parser("run")
    p.add_argument("--max-concurrency", type=int, default=2)
    p.add_argument("--timeout-seconds", type=float)
    p.add_argument("--allow-test-adapter", action="store_true")
    sub.add_parser("status")
    sub.add_parser("revise").add_argument("change")
    sub.add_parser("cancel").add_argument("node")
    args = parser.parse_args()
    flow = Workflow(args.project_root, args.state)
    if args.action == "init":
        result = flow.init(json.loads(Path(args.manifest).read_text(encoding="utf-8-sig")))
    elif args.action == "revise":
        result = flow.revise(json.loads(Path(args.change).read_text(encoding="utf-8-sig")))
    elif args.action == "run":
        result = flow.run(args.max_concurrency, args.timeout_seconds, args.allow_test_adapter)
    elif args.action == "cancel":
        result = flow.cancel(args.node)
    else:
        result = flow.load()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        sys.exit(2)
