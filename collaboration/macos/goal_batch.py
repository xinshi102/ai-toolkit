"""Run a multi-milestone plan without asking the user between milestones.

A batch is the "secretary stays autonomous" path: each milestone is a normal
goal (checks / judge / budget). The batch stops only when a milestone ends
blocked (a whitelisted decision or an exhausted budget), then writes one
decision + one batch report. Completion produces one summary, not per-step
chatter.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import goal_loop
import goal_runner


def _aggregate(states):
    wall = sum((state.get("cost") or {}).get("wallSeconds") or 0 for state in states)
    tokens = sum(((state.get("cost") or {}).get("tokens") or {}).get("total") or 0 for state in states)
    attempts = sum(len(state.get("attempts") or []) for state in states)
    return {"milestones": len(states), "wallSeconds": round(wall, 3), "tokens": tokens, "attempts": attempts}


def _previous_context(states, limit=4000):
    chunks = []
    for state in states:
        artifacts = [item.get("artifact") for item in (state.get("attempts") or []) if item.get("artifact")]
        if artifacts:
            path = Path(artifacts[-1])
            try:
                chunks.append(path.name + ": " + path.read_text(encoding="utf-8", errors="replace")[:limit])
            except OSError:
                continue
    return "\n".join(chunks)


def run_batch(plan_path, *, home, notify=True):
    plan = json.loads(Path(plan_path).read_text(encoding="utf-8"))
    milestones = plan.get("milestones")
    if not isinstance(milestones, list) or not milestones:
        raise goal_loop.GoalError("batch requires a non-empty milestones list")
    batch_id = plan.get("planId", "batch") + "-" + uuid.uuid4().hex[:8]
    run_dir = Path(home) / "batches" / batch_id
    run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    states = []
    context = ""
    stopped = None
    for index, milestone in enumerate(milestones, start=1):
        goal = dict(milestone)
        goal.setdefault("goalId", f"m{index}")
        if context:
            goal["objective"] = goal["objective"] + "\n\nPrevious milestone artifacts:\n" + context
        goal_path = run_dir / f"milestone-{index}.json"
        goal_path.write_text(json.dumps(goal, ensure_ascii=False, indent=2), encoding="utf-8")
        state = goal_runner.run_goal_file(goal_path, home=home, notify=False)
        states.append(state)
        if state.get("status") != "done":
            stopped = state
            break
        context = _previous_context(states)
    aggregate = _aggregate(states)
    report = {
        "batchId": batch_id,
        "planId": plan.get("planId", ""),
        "status": "done" if stopped is None and len(states) == len(milestones) else "blocked",
        "milestones": [{"goalId": s.get("goalId"), "runId": s.get("runId"), "status": s.get("status"),
                        "wake": s.get("wake")} for s in states],
        "cost": aggregate,
        "decision": None if stopped is None else stopped.get("wake"),
        "finishedAt": datetime.now(timezone.utc).isoformat(),
    }
    (run_dir / "batch.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    lines = [
        f"# 长任务：{report['status']}（{plan.get('planId','batch')}）",
        f"- 里程碑：{len(states)}/{len(milestones)} 完成",
        f"- 成本：总 {aggregate['wallSeconds']}s · {aggregate['tokens']} tok · {aggregate['attempts']} 次尝试",
        f"- 结果：{', '.join((m['goalId'] + ' ' + m['status']) for m in report['milestones'])}",
    ]
    if report["decision"]:
        lines.append(f"- 需要你决定：{report['decision'].get('question') or report['decision'].get('detail') or report['decision'].get('reason')}")
    (run_dir / "batch-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    report["reportPath"] = str(run_dir / "batch-report.md")
    if notify:
        if stopped is None:
            goal_runner.notify_state({"status": "done", "objective": plan.get("planId", "长任务")})
        else:
            goal_runner.notify_state(stopped)
    return report
