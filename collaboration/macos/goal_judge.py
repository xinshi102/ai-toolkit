"""Deterministic judge for the v4 goal loop.

Checks are shell commands run inside the attempt workspace. They are the
"code" half of the hybrid judge: cheap, reproducible, and independent of the
executor's self-report. A subjective/agent judge can be added on top later.
"""
from __future__ import annotations

import subprocess
from pathlib import Path


def command_judge(goal):
    checks = goal.get("checks") or []

    def judge(context):
        workspace = Path(context["workspace"])
        defects = []
        for index, check in enumerate(checks, start=1):
            command = check.get("command")
            if not isinstance(command, str) or not command.strip():
                defects.append(f"check {index}: empty command")
                continue
            label = check.get("desc") or f"check {index}"
            try:
                proc = subprocess.run(
                    command, shell=True, cwd=workspace, capture_output=True,
                    text=True, timeout=check.get("timeout", 30),
                )
            except subprocess.TimeoutExpired:
                defects.append(f"{label}: timed out")
                continue
            if proc.returncode != 0:
                tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-3:]
                defects.append(f"{label}: exit {proc.returncode} :: {' | '.join(tail)}")
        return {"verdict": "pass", "defects": []} if not defects else {"verdict": "reject", "defects": defects}

    return judge
