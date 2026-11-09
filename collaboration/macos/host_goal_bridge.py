"""Mirror the host conversation goal into the collaboration panel.

The panel reads <home>/goals/*/goal.json. A conversation goal (created with the
host's own goal tool) is not a goal_runner run, so it would otherwise be
invisible. This module registers a lightweight, honest mirror: objective,
status and why it exists. It never invents attempts, cost or artifacts.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home() / "Library/Application Support/xinshi-collaboration"


def register(goal_id, objective, status, *, home=None, detail=""):
    home = Path(home) if home else HOME
    run_id = "host-" + goal_id.replace("goal-", "")
    run_dir = home / "goals" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    state = {
        "runId": run_id,
        "goalId": goal_id,
        "objective": objective,
        "acceptance": [],
        "status": status,
        "attempts": [],
        "wake": None,
        "cost": None,
        "source": "conversation",
        "detail": detail,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    (run_dir / "goal.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    return state
