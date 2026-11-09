"""OpenCode executor for the v4 goal loop.

Wraps the already-verified scoped adapter: the executor can only read the
brief and write the artifact inside its own attempt directory. No credentials
are read here; the adapter handles the short-lived child process.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import opencode_adapter

FREE_MODEL = opencode_adapter.__dict__.get("FREE_MODEL", "opencode/deepseek-v4.1-flash-free")


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
        artifact = workspace / "goal-design.json"
        return {
            "artifact": str(artifact) if artifact.is_file() else None,
            "evidence": [{
                "model": receipt.get("model"),
                "exit_code": receipt.get("exit_code"),
                "accepted": receipt.get("accepted"),
                "session_ids": receipt.get("session_ids"),
                "errors": receipt.get("errors"),
            }],
        }

    return executor
