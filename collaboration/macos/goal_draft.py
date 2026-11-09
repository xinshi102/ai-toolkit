"""Turn a one-sentence request into a goal file (model-assisted draft).

The draft is shown to the user as three lines; nothing runs until the user
confirms. If the model fails, a skeleton is returned with a clear TODO so the
request is never silently lost.
"""
from __future__ import annotations

import json
import re
import tempfile
import uuid
from pathlib import Path

import opencode_adapter

FREE_MODEL = "opencode/deepseek-v4.1-flash-free"

TASK = """Convert the user's request into ONE goal JSON object with exactly these keys:
goalId (kebab-case), objective (one sentence), acceptance (3-7 verifiable Chinese strings),
checks (list of {"desc": Chinese label, "command": a shell command run inside the attempt
workspace that exits 0 only when the acceptance item holds; use python3 -c reading artifact files}),
subjective (optional list of Chinese criteria that need a judge model, e.g. 视觉是否清晰；empty if all checks are mechanical),
budget ({"attempts": 1-5, "maxSeconds": 120-1800}),
artifact (a plain filename the executor must produce, e.g. hello.json; checks read this file),
required_keys (list of artifact JSON keys the executor must write, for example ["nonce","ok"];
never repeat the goal schema keys),
retry_note (one sentence of extra instruction for the next attempt).
Return ONLY the JSON object. Checks run inside the attempt workspace and may read only files the
executor creates there plus goal-brief.json; never hardcode a nonce — compare the artifact nonce
against goal-brief.json instead. Checks must not read credentials, the network, or files outside
the workspace."""


def _slug(request):
    value = re.sub(r"[^a-zA-Z0-9-]+", "-", request.strip().lower()).strip("-")
    return (value[:40] or "goal") + "-" + uuid.uuid4().hex[:6]


def skeleton(request):
    return {
        "goalId": _slug(request),
        "objective": request.strip(),
        "acceptance": ["（待补）明确 3-7 条可验证的验收项"],
        "checks": [],
        "subjective": [],
        "artifact": "goal-design.json",
        "budget": {"attempts": 3, "maxSeconds": 900},
        "required_keys": ["nonce", "result"],
        "retry_note": "",
    }


def normalize(data, request):
    if not isinstance(data, dict):
        raise ValueError("draft is not an object")
    acceptance = [str(item) for item in (data.get("acceptance") or []) if str(item).strip()][:7]
    checks = [check for check in (data.get("checks") or [])
              if isinstance(check, dict) and isinstance(check.get("command"), str) and check["command"].strip()]
    budget = data.get("budget") or {}
    attempts = budget.get("attempts", 3)
    seconds = budget.get("maxSeconds", 900)
    if type(attempts) is not int or not 1 <= attempts <= 5:
        attempts = 3
    if type(seconds) is not int or not 120 <= seconds <= 1800:
        seconds = 900
    return {
        "goalId": str(data.get("goalId") or _slug(request)),
        "objective": str(data.get("objective") or request.strip()),
        "acceptance": acceptance or [request.strip()],
        "checks": checks,
        "subjective": [str(item) for item in (data.get("subjective") or []) if str(item).strip()],
        "budget": {"attempts": attempts, "maxSeconds": seconds},
        "artifact": str(data.get("artifact") or "goal-design.json"),
        "required_keys": [str(key) for key in (data.get("required_keys") or ["nonce", "result"])],
        "retry_note": str(data.get("retry_note") or ""),
    }


def draft(request, *, model=FREE_MODEL, timeout=120):
    with tempfile.TemporaryDirectory() as root:
        directory = Path(root)
        brief = {
            "nonce": uuid.uuid4().hex,
            "required_keys": ["goalId", "objective", "acceptance", "checks", "subjective", "budget", "artifact"],
            "task": TASK + "\n用户请求：" + request.strip(),
        }
        (directory / "draft-brief.json").write_text(json.dumps(brief, ensure_ascii=False), encoding="utf-8")
        try:
            opencode_adapter.run(directory, model, prefix="draft", timeout=timeout)
            artifact = directory / "draft-design.json"
            data = json.loads(artifact.read_text(encoding="utf-8"))
            goal = normalize(data, request)
            if goal["checks"]:
                return goal
        except (OSError, ValueError, FileNotFoundError):
            pass
    return skeleton(request)
