"""DSH executor for the v4 goal loop (DeepSeek Flash)."""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import dsh_adapter


def executor_for(goal, *, timeout=300, shared=True):
    def executor(context):
        workspace = Path(context["workspace"])
        attempt = context["attempt"]
        defects = context.get("defects") or []
        required = list(goal.get("required_keys") or ["nonce", "result"])
        if attempt > 1:
            required += [key for key in goal.get("robust_keys", []) if key not in required]
        task = goal["objective"]
        if attempt > 1 and goal.get("retry_note"):
            task += " " + goal["retry_note"]
        if defects:
            task += " Previous attempt was rejected for: " + "; ".join(defects) + "."
        brief = {"nonce": uuid.uuid4().hex, "required_keys": required, "task": task}
        (workspace / "goal-brief.json").write_text(json.dumps(brief, ensure_ascii=False), encoding="utf-8")
        receipt = dsh_adapter.run(workspace, "goal-brief.json", "goal-design.json", timeout=timeout, shared=shared)
        produced = workspace / "goal-design.json"
        artifact_name = goal.get("artifact") or "goal-design.json"
        if artifact_name != "goal-design.json" and produced.is_file():
            (workspace / artifact_name).write_text(produced.read_text(encoding="utf-8"), encoding="utf-8")
        artifact = workspace / artifact_name
        return {
            "artifact": str(artifact) if artifact.is_file() else None,
            "evidence": [{"model": receipt.get("model"), "exit_code": receipt.get("exit_code"),
                          "accepted": receipt.get("accepted"), "session_id": receipt.get("session_id")}],
            "usage": None,
        }

    return executor
