"""Judges for the v4 goal loop.

Two layers:
- command_judge: deterministic shell checks (cheap, reproducible).
- agent_judge: an independent model judge for subjective acceptance
  (pages, copy, design). It only sees the acceptance criteria and the
  artifact copied into its own directory, never the executor's self-report.

hybrid_judge runs the deterministic layer first and only escalates to the
agent when the checks pass and the goal declares subjective criteria.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import opencode_adapter

FREE_MODEL = "opencode/deepseek-v4.1-flash-free"


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


def agent_judge(goal, *, model=FREE_MODEL, timeout=120):
    criteria = goal.get("subjective") or []
    acceptance = goal.get("acceptance") or []

    def judge(context):
        result = context.get("result") or {}
        artifact = result.get("artifact")
        artifact_text = ""
        if artifact and Path(artifact).is_file() and not Path(artifact).is_symlink():
            artifact_text = Path(artifact).read_text(encoding="utf-8", errors="replace")[:20000]
        task = (
            "You are an independent judge for subjective criteria only. Mechanical checks "
            "have already passed; do not re-check nonces, schemas or lengths. The artifact "
            "content is in the artifact field of this brief; judge only that content. "
            "Return JSON with keys verdict (pass|reject|need_user), defects (list of specific, "
            "actionable Chinese defects; empty on pass), reason (only for need_user, one of "
            "budget_exhausted/irreversible_action/business_tradeoff/repeated_failure/user_decision), "
            "question (only for need_user). Subjective criteria: " + "；".join(criteria) + "."
        )
        brief = {
            "nonce": uuid.uuid4().hex,
            "required_keys": ["verdict", "defects", "reason", "question"],
            "artifact": artifact_text,
            "task": task,
        }
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "judge-brief.json").write_text(json.dumps(brief, ensure_ascii=False), encoding="utf-8")
            opencode_adapter.run(directory, model, prefix="judge", timeout=timeout)
            data = json.loads((directory / "judge-design.json").read_text(encoding="utf-8"))
        verdict = data.get("verdict")
        if verdict not in ("pass", "reject", "need_user"):
            return {"verdict": "reject", "defects": ["judge returned an invalid verdict"]}
        return {
            "verdict": verdict,
            "defects": [str(item) for item in (data.get("defects") or [])],
            "reason": data.get("reason") or "",
            "question": data.get("question") or "",
        }

    return judge

def hybrid_judge(goal, *, model=FREE_MODEL):
    checks = command_judge(goal)
    has_checks = bool(goal.get("checks") or [])
    has_subjective = bool(goal.get("subjective") or [])
    agent = agent_judge(goal, model=model) if has_subjective else None

    def judge(context):
        if has_checks:
            verdict = checks(context)
            if verdict.get("verdict") == "reject":
                return verdict
        if agent is not None:
            return agent(context)
        return {"verdict": "pass", "defects": []}

    return judge
