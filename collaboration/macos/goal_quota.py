"""Local quota guard: stop starting new work when the account snapshot is hot.

The snapshot is written by the collaboration console (console-quota.json).
This is a guardrail, not a live quota API: a stale snapshot can only make the
guard more conservative, never less.
"""
from __future__ import annotations

import json
from pathlib import Path

DEFAULT_HOME = Path.home() / "Library/Application Support/xinshi-collaboration"


def rows(home=None):
    home = Path(home) if home else DEFAULT_HOME
    try:
        data = json.loads((home / "console-quota.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return data.get("rows") or []


def check(home=None, max_pct=95):
    current = rows(home)
    hot = [row for row in current
           if isinstance(row.get("pct_used"), (int, float)) and row["pct_used"] >= max_pct]
    return {"ok": not hot, "rows": current, "hot": hot}
