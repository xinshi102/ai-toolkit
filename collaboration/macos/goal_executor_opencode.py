"""OpenCode executor for the v4 goal loop.

Wraps the already-verified scoped adapter: the executor can only read the
brief and write the artifact inside its own attempt directory. No credentials
are read here; the adapter handles the short-lived child process.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import opencode_adapter

FREE_MODEL = opencode_adapter.__dict__.get("FREE_MODEL", "opencode/deepseek-v4.1-flash-free")


def read_usage(events_path):
    """Best-effort token/cost usage from the adapter's native event log."""
    total, cost, steps, last = 0, 0.0, 0, None
    try:
        lines = Path(events_path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "step_finish":
            steps += 1
            last = event.get("part") or {}
    if not last:
        return None
    tokens = last.get("tokens") or {}
    return {"total": tokens.get("total") or 0, "cost": last.get("cost") or 0.0, "steps": steps}


def executor_for(goal, *, model=FREE_MODEL, timeout=150):
    """Return an executor callable bound to one goal."""
    objective = goal["objective"]
    extra = goal.get("executor_notes", "")

    def executor(context):
        workspace = Path(context["workspace"])
        attempt = context["attempt"]
        defects = context.get("defects") or []
        required = list(goal.get("required_keys") or ["nonce", "answer"])
        if attempt > 1:
            required += [key for key in goal.get("robust_keys", []) if key not in required]
        task = objective
        if extra:
            task += " " + extra
        if defects:
            task += " Previous attempt was rejected for: " + "; ".join(defects) + "."
        if attempt > 1 and goal.get("retry_note"):
            task += " " + goal["retry_note"]
        brief = {
            "nonce": uuid.uuid4().hex,
            "required_keys": required,
            "task": task,
        }
        (workspace / "goal-brief.json").write_text(
            __import__("json").dumps(brief, ensure_ascii=False), encoding="utf-8"
        )
        receipt = opencode_adapter.run(workspace, model, prefix="goal", timeout=timeout)
        produced = workspace / "goal-design.json"
        artifact_name = goal.get("artifact") or "goal-design.json"
        if artifact_name != "goal-design.json" and produced.is_file():
            (workspace / artifact_name).write_text(produced.read_text(encoding="utf-8"), encoding="utf-8")
        artifact = workspace / artifact_name
        return {
            "artifact": str(artifact) if artifact.is_file() else None,
            "evidence": [{
                "model": receipt.get("model"),
                "exit_code": receipt.get("exit_code"),
                "accepted": receipt.get("accepted"),
                "session_ids": receipt.get("session_ids"),
                "errors": receipt.get("errors"),
            }],
            "usage": read_usage(workspace / "goal-events.jsonl"),
        }

    return executor
