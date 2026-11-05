"""Budget usage read from the existing usage statistics.

No credentials, no provider account and no new token source are opened here.
Numbers come from ``agent_usage.scan()`` (the board's per-agent statistics) and
``controller_usage.report()`` (the controller call ledger), both already used
elsewhere in this runtime.  Executor usage is surfaced (recorded) but is never
used to block a dispatch.

For tests, ``read_usage`` accepts an injectable ``provider`` so no filesystem
or ledger access is needed.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

# The four controller options that actually cost money and are budget-bound.
CONTROLLERS = ("GPT", "deepseek-v4.1")

_CONTROLLER_KEYS = {
    "gpt": "GPT", "codex": "GPT", "codex / gpt": "GPT", "gpt-codex": "GPT",
    "deepseek-v4.1": "deepseek-v4.1", "dsh": "deepseek-v4.1",
    "dsh-deepseek": "deepseek-v4.1",
}

RECORD_FILE = "budget_usage.jsonl"


def canonical(agent) -> str:
    name = str(agent or "").strip()
    return _CONTROLLER_KEYS.get(name.lower(), name)


def classify(agent) -> str:
    """'controller' (budget-bound) or 'executor' (record-only)."""
    return "controller" if canonical(agent) in CONTROLLERS else "executor"


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def _num(value) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _agent_from_row(name: str):
    n = str(name or "").lower()
    if "codex" in n or n.startswith("gpt"):
        return "GPT"
    if "dsh" in n:
        return "deepseek-v4.1"
    return None


def _row_used(row: dict) -> float:
    """Pick the first meaningful scalar the existing stats already expose."""
    tokens = _num(row.get("input")) + _num(row.get("output"))
    if tokens:
        return tokens
    for key in ("cost", "credits", "calls"):
        value = _num(row.get(key))
        if value:
            return value
    return 0.0


def _default_ledger() -> Path:
    return Path(__file__).resolve().parent.parent.parent / ".work" / "controller-usage.sqlite"


def default_provider(days: int = 1, ledger_path=None) -> dict:
    """Translate existing per-agent/controller statistics into budget records."""
    records = []
    day = today()
    try:
        import agent_usage  # late import: heavy module, only on real reads
        data = agent_usage.scan(days=days)
        for row in (data.get("agents") or []):
            if not isinstance(row, dict):
                continue
            ai = _agent_from_row(row.get("agent"))
            if ai:
                records.append({"agent": ai, "package": "*", "day": day,
                                "used": _row_used(row)})
    except Exception:
        pass

    note = {}
    try:
        ledger = Path(ledger_path) if ledger_path else _default_ledger()
        if ledger.exists():
            import controller_usage  # late import
            rep = controller_usage.report(ledger)
            note = {
                "controller_calls": rep.get("controller_calls", 0),
                "input_tokens": rep.get("input_tokens", 0),
                "output_tokens": rep.get("output_tokens", 0),
            }
    except Exception:
        pass
    return {"records": records, "note": note}


def _record_path(base=None) -> Path:
    from rules import store  # late import to avoid package import cycles
    return (Path(base) if base else store.data_dir()) / RECORD_FILE


def record_usage(agent, package: str, used, day: str = "", base=None) -> dict:
    """Record an executor's usage (record-only; never blocks)."""
    record = {"agent": canonical(agent), "package": str(package or "*"),
              "day": str(day or today()), "used": _num(used)}
    path = _record_path(base)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    return record


def _recorded(base=None) -> list:
    path = _record_path(base)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def read_usage(base=None, days: int = 1, *, provider=None, ledger_path=None,
               include_recorded: bool = True) -> dict:
    """Return ``{'records': [...], 'note': {...}, 'generated_at': ...}``."""
    if provider is None:
        provider = lambda: default_provider(days=days, ledger_path=ledger_path)
    try:
        data = provider()
    except Exception:
        data = {"records": [], "note": {}}
    if not isinstance(data, dict):
        data = {"records": [], "note": {}}
    records = [r for r in (data.get("records") or []) if isinstance(r, dict)]
    if include_recorded:
        records = records + _recorded(base)
    return {
        "records": records,
        "note": data.get("note") or {},
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
