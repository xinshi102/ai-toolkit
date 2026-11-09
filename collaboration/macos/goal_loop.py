"""Minimal v4 goal loop: dispatch -> independent judge -> continue or wake.

The secretary never certifies "done" and never wakes the user on its own.
Only the judge may request a wake, and only with a whitelisted reason; the
loop records every attempt, defect, duration and token usage in one goal file
plus an append-only event log.

Cost accounting is part of the contract: wall time, executor time (model
communication + understanding + work), judge time, attempts, and best-effort
token usage are recorded so the user can judge cost-effectiveness.
"""
from __future__ import annotations

import hashlib
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

WAKE_REASONS = frozenset({
    "budget_exhausted",
    "irreversible_action",
    "business_tradeoff",
    "repeated_failure",
    "user_decision",
})
MAX_ATTEMPTS = 20
MAX_SECONDS = 86_400


class GoalError(ValueError):
    """The goal or a role contract was violated."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_goal(goal: dict) -> dict:
    if not isinstance(goal, dict):
        raise GoalError("goal must be an object")
    for key in ("goalId", "objective"):
        if not isinstance(goal.get(key), str) or not goal[key].strip():
            raise GoalError(f"goal requires a non-empty {key}")
    acceptance = goal.get("acceptance")
    if not isinstance(acceptance, list) or not acceptance or not all(isinstance(item, str) and item.strip() for item in acceptance):
        raise GoalError("goal requires a non-empty acceptance list")
    budget = goal.get("budget") or {}
    if not isinstance(budget, dict):
        raise GoalError("budget must be an object")
    attempts = budget.get("attempts", 3)
    seconds = budget.get("maxSeconds", 1800)
    tokens = budget.get("tokens")
    if type(attempts) is not int or not 1 <= attempts <= MAX_ATTEMPTS:
        raise GoalError(f"budget.attempts must be an integer 1..{MAX_ATTEMPTS}")
    if type(seconds) is not int or not 1 <= seconds <= MAX_SECONDS:
        raise GoalError(f"budget.maxSeconds must be an integer 1..{MAX_SECONDS}")
    if tokens is not None and (type(tokens) is not int or not 1 <= tokens <= 10_000_000):
        raise GoalError("budget.tokens must be an integer 1..10000000")
    normalized = {"attempts": attempts, "maxSeconds": seconds}
    if tokens is not None:
        normalized["tokens"] = tokens
    return {**goal, "budget": normalized}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _wake_reason(verdict: dict) -> str:
    reason = verdict.get("reason") or "user_decision"
    if reason not in WAKE_REASONS:
        raise GoalError(f"judge requested a non-whitelisted wake reason: {reason!r}")
    return reason


def _cost_summary(state: dict, wall_seconds: float) -> dict:
    attempts = state.get("attempts") or []
    tokens = {"total": 0, "cost": 0.0, "steps": 0}
    for item in attempts:
        usage = item.get("usage") or {}
        for key in tokens:
            tokens[key] += usage.get(key) or 0
    return {
        "wallSeconds": round(wall_seconds, 3),
        "executorSeconds": round(sum(item.get("executorSeconds") or 0 for item in attempts), 3),
        "judgeSeconds": round(sum(item.get("judgeSeconds") or 0 for item in attempts), 3),
        "attempts": len(attempts),
        "tokens": tokens if tokens["total"] else None,
    }


def run_goal(goal: dict, *, executor, judge, home, clock=time.monotonic) -> dict:
    """Run one goal until done, blocked, or a whitelisted wake is needed."""
    goal = validate_goal(goal)
    run_id = goal["goalId"] + "-" + uuid.uuid4().hex[:8]
    run_dir = Path(home) / "goals" / run_id
    attempts_dir = run_dir / "attempts"
    attempts_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    state = {
        "runId": run_id,
        "goalId": goal["goalId"],
        "objective": goal["objective"],
        "acceptance": goal["acceptance"],
        "status": "running",
        "attempts": [],
        "wake": None,
        "cost": None,
        "startedAt": now_iso(),
        "updatedAt": now_iso(),
    }

    def record(kind: str, **fields) -> None:
        event = {"at": now_iso(), "kind": kind, **fields}
        with (run_dir / "events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event, ensure_ascii=False) + "\n")

    def save() -> None:
        state["updatedAt"] = now_iso()
        (run_dir / "goal.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def finish(**updates) -> dict:
        state.update(updates)
        state["cost"] = _cost_summary(state, clock() - started)
        save()
        return state

    started = clock()
    deadline = started + goal["budget"]["maxSeconds"]
    defects: list[str] = []
    record("goal", objective=goal["objective"], acceptance=goal["acceptance"], budget=goal["budget"])
    save()

    for attempt in range(1, goal["budget"]["attempts"] + 1):
        if clock() > deadline:
            record("wake", reason="budget_exhausted", detail="time budget exhausted")
            return finish(status="blocked", wake={"reason": "budget_exhausted", "detail": "time budget exhausted"})
        token_cap = goal["budget"].get("tokens")
        if token_cap:
            used = sum((item.get("usage") or {}).get("total") or 0 for item in state["attempts"])
            if used >= token_cap:
                record("wake", reason="budget_exhausted", detail="token budget exhausted")
                return finish(status="blocked", wake={"reason": "budget_exhausted", "detail": "token budget exhausted"})

        workspace = attempts_dir / str(attempt)
        workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
        record("dispatch", attempt=attempt, defects=defects)
        state["progress"] = {"attempt": attempt, "phase": "dispatch"}
        save()
        dispatch_started = clock()
        try:
            result = executor({"goal": goal, "attempt": attempt, "defects": list(defects), "workspace": str(workspace)})
            if not isinstance(result, dict):
                raise GoalError("executor must return a mapping")
        except Exception as error:  # a broken executor is evidence, not a pass
            result = {"error": type(error).__name__}
        result_at = clock()

        artifact = result.get("artifact")
        artifact_path = None
        artifact_sha = None
        if isinstance(artifact, (str, Path)):
            candidate = Path(artifact)
            if candidate.is_file() and not candidate.is_symlink():
                artifact_path = str(candidate)
                artifact_sha = _sha256(candidate)
        attempt_record = {
            "attempt": attempt,
            "workspace": str(workspace),
            "artifact": artifact_path,
            "artifactSha256": artifact_sha,
            "error": result.get("error"),
            "evidence": result.get("evidence") or [],
            "usage": result.get("usage"),
            "executorSeconds": round(result_at - dispatch_started, 3),
        }
        state["attempts"].append(attempt_record)
        state["progress"] = {"attempt": attempt, "phase": "judge"}
        record("result", **{key: value for key, value in attempt_record.items() if key != "usage"})
        save()

        verdict = judge({"goal": goal, "attempt": attempt, "result": result, "workspace": str(workspace)})
        judge_at = clock()
        if not isinstance(verdict, dict) or verdict.get("verdict") not in ("pass", "reject", "need_user"):
            raise GoalError("judge must return pass, reject or need_user")
        state["attempts"][-1]["judgeSeconds"] = round(judge_at - result_at, 3)
        record("judge", verdict=verdict.get("verdict"), defects=verdict.get("defects") or [],
               reason=verdict.get("reason"), question=verdict.get("question"))
        state["attempts"][-1]["verdict"] = verdict["verdict"]
        save()

        if verdict["verdict"] == "pass":
            record("done", attempt=attempt)
            return finish(status="done", wake=None)
        if verdict["verdict"] == "need_user":
            reason = _wake_reason(verdict)
            record("wake", reason=reason, question=verdict.get("question") or "")
            return finish(status="blocked", wake={"reason": reason, "question": verdict.get("question") or "",
                                                  "options": verdict.get("options") or []})
        defects = [str(item) for item in (verdict.get("defects") or [])]
        if not defects:
            defects = ["judge rejected without specific defects"]

    record("wake", reason="budget_exhausted", detail="attempt budget exhausted")
    return finish(status="blocked", wake={"reason": "budget_exhausted", "detail": "attempt budget exhausted"})


def demo(home: Path) -> dict:
    """Run the loop with a scripted executor/judge; no model or network."""
    def executor(context):
        workspace = Path(context["workspace"])
        artifact = workspace / "artifact.json"
        ok = context["attempt"] >= 2
        artifact.write_text(json.dumps({"ok": ok, "attempt": context["attempt"]}), encoding="utf-8")
        return {"artifact": str(artifact), "evidence": ["scripted executor"], "usage": {"total": 0, "steps": 0, "cost": 0.0}}

    def judge(context):
        artifact = Path(context["result"]["artifact"])
        data = json.loads(artifact.read_text(encoding="utf-8"))
        if data.get("ok"):
            return {"verdict": "pass", "defects": []}
        return {"verdict": "reject", "defects": ["artifact.ok is false; set it to true"]}

    goal = {
        "goalId": "demo-goal",
        "objective": "produce an artifact whose ok field is true",
        "acceptance": ["artifact.ok == true"],
        "budget": {"attempts": 3, "maxSeconds": 60},
    }
    return run_goal(goal, executor=executor, judge=judge, home=home)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Minimal goal loop (offline demo)")
    parser.add_argument("--home", type=Path, default=Path.home() / ".local/share/xinshi-goals")
    args = parser.parse_args()
    state = demo(args.home)
    print(json.dumps({key: state[key] for key in ("runId", "status", "wake", "cost")}, ensure_ascii=False, indent=2))
