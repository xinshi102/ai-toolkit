"""Codex CLI executor for the v4 goal loop."""
from __future__ import annotations

import json
import subprocess
import uuid
from pathlib import Path

CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"


def executor_for(goal, *, timeout=180):
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
        artifact_name = goal.get("artifact") or "goal-design.json"
        prompt = (
            "Read ONLY goal-brief.json in the current directory. Follow its task and write ONLY "
            + artifact_name +
            " as a JSON object containing all required_keys and preserving nonce exactly. "
            "Do not read other files, do not use the network, do not run destructive commands."
        )
        command = [CODEX, "exec", "--cd", str(workspace), "--sandbox", "workspace-write",
                   "--skip-git-repo-check", "-c", 'approval_policy="never"',
                   "-o", str(workspace / "goal-last.txt"), prompt]
        try:
            proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
            evidence = {"exit_code": proc.returncode, "stdout_tail": (proc.stdout or "")[-2000:],
                        "stderr_tail": (proc.stderr or "")[-1000:]}
        except subprocess.TimeoutExpired:
            evidence = {"exit_code": 124, "stdout_tail": "", "stderr_tail": "timed out"}
        artifact = workspace / artifact_name
        return {"artifact": str(artifact) if artifact.is_file() else None,
                "evidence": [evidence], "usage": None}

    return executor
