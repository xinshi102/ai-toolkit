"""Durable, conservative accounting for limited controller/GPT calls.

This module is a local *policy* ledger.  It does not read a provider account,
does not convert tokens into money, and does not claim that its five-hour
rolling window is the provider's real quota.  The window is a local guard rail
over calls made by this runtime and is shared by every workflow that uses the
same SQLite ledger path.

Design rules
------------
* ``reserve`` is the admission gate.  It uses ``BEGIN IMMEDIATE`` so the
  read-check-insert sequence is serialized across processes and threads.
* A ``call_id`` is a durable idempotency key.  Once it exists, reserving it
  again returns ``already_reserved`` and the caller must not run the call
  again - even if the previous invocation crashed or has an ``unknown`` state.
* ``reserved`` and ``unknown`` invocations keep consuming the call cap and the
  conservative token reservation until a later ``finish`` explicitly resolves
  them.  Age alone never releases an uncertain invocation.
* Terminal calls (``completed``/``failed``) count calls inside the rolling
  window.  Usage that is missing or incomplete keeps the reservation amount
  instead of being treated as zero.
* Executor calls belong in the report but never in the controller budget.

Only the Python standard library is used.
"""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

# SQLite statements are executed individually so schema setup also works while
# another process is creating the same ledger.  ``executescript`` would issue an
# implicit commit and is therefore avoided inside explicit transactions.
_SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS controller_usage (
      call_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      event_key TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      usage_known INTEGER NOT NULL DEFAULT 0,
      reserve_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS controller_usage_role_created
      ON controller_usage(role, created_at)
    """,
    """
    CREATE INDEX IF NOT EXISTS controller_usage_provider
      ON controller_usage(provider)
    """,
)

SCHEMA_VERSION = 1

ACTIVE_STATUSES = ("reserved", "unknown")
TERMINAL_STATUSES = ("completed", "failed")
VALID_FINISH_STATUSES = ("completed", "failed", "unknown")
VALID_EXECUTION_STATUSES = ("completed", "failed", "unknown")
# The queue's terminal state names are accepted by record_execution so the
# supervisor can pass row['state'] directly.  Executor rows are reporting-only;
# they never affect controller admission.
_EXECUTION_STATUS_ALIASES = {
    "completed": "completed",
    "succeeded": "completed",
    "success": "completed",
    "failed": "failed",
    "error": "failed",
    "cancelled": "failed",
    "canceled": "failed",
    "blocked": "failed",
    "interrupted": "failed",
    "unknown": "unknown",
}

CONTROLLER = "controller"
EXECUTOR = "executor"

POLICY_NOTE = (
    "Local rolling policy window only; not a provider quota, subscription "
    "limit, bill, or cost conversion."
)


# ---------------------------------------------------------------------------
# connection / time helpers
# ---------------------------------------------------------------------------

def _is_busy(exc: BaseException) -> bool:
    text = str(exc).lower()
    return "locked" in text or "busy" in text


def _retry_ddl(con: sqlite3.Connection, statement: str, attempts: int = 40) -> None:
    for attempt in range(attempts):
        try:
            con.execute(statement)
            return
        except sqlite3.OperationalError as exc:
            if not _is_busy(exc) or attempt == attempts - 1:
                raise
            time.sleep(min(0.25, 0.01 * (attempt + 1)))


def migrate_schema(con: sqlite3.Connection) -> int:
    """Bring the ledger to ``SCHEMA_VERSION``; safe to repeat."""
    version = con.execute("PRAGMA user_version").fetchone()[0]
    if version < 1:
        _retry_ddl(con, "PRAGMA user_version=%d" % SCHEMA_VERSION)
        version = SCHEMA_VERSION
    return version


def _connect(db_path) -> sqlite3.Connection:
    """Open and initialize the ledger with a generous SQLite busy timeout."""
    path = Path(db_path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(
        str(path), timeout=30.0, isolation_level=None,
        check_same_thread=True,
    )
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=30000")
    # WAL improves reader/writer overlap.  Another initializer may already hold
    # the write lock, so tolerate a transient lock here; the database is
    # already durable either way.
    try:
        _retry_ddl(con, "PRAGMA journal_mode=WAL")
    except sqlite3.OperationalError as exc:
        if not _is_busy(exc):
            raise
    for statement in _SCHEMA_STATEMENTS:
        _retry_ddl(con, statement)
    migrate_schema(con)
    return con


def _begin_immediate(con: sqlite3.Connection, attempts: int = 40) -> None:
    for attempt in range(attempts):
        try:
            con.execute("BEGIN IMMEDIATE")
            return
        except sqlite3.OperationalError as exc:
            if not _is_busy(exc) or attempt == attempts - 1:
                raise
            time.sleep(min(0.25, 0.01 * (attempt + 1)))


def _rollback(con: sqlite3.Connection) -> None:
    if con.in_transaction:
        con.rollback()


def _epoch(now=None) -> int:
    if now is None:
        return int(time.time())
    if isinstance(now, datetime):
        value = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
        return int(value.timestamp())
    return int(now)


def _text(value, name: str) -> str:
    if value is None:
        raise ValueError(f"{name} is required")
    text = str(value).strip()
    if not text:
        raise ValueError(f"{name} must not be empty")
    return text


def _non_negative_int(value, name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if number < 0:
        raise ValueError(f"{name} must be >= 0")
    return number


def _row_dict(row) -> dict:
    return dict(row) if row is not None else {}


# ---------------------------------------------------------------------------
# usage normalization helpers
# ---------------------------------------------------------------------------

def _as_token(value):
    """Return a non-negative integer token count, or None when not known."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if value >= 0 else None
    if isinstance(value, float):
        if value.is_integer() and value >= 0:
            return int(value)
        return None
    if isinstance(value, str):
        text = value.strip()
        if text.isdigit():
            return int(text)
    return None


def _normalize_usage_args(usage):
    """Normalize a caller-supplied usage mapping.

    Returns ``(input_tokens, cached_input_tokens, output_tokens, known)``.
    A usage total is only considered known when both input and output are
    integers.  Cached input is optional.  Unknown values stay ``None``; they are
    never silently converted to zero.
    """
    if not isinstance(usage, dict):
        return None, None, None, False
    input_tokens = _as_token(usage.get("input_tokens"))
    cached = _as_token(usage.get("cached_input_tokens"))
    output_tokens = _as_token(usage.get("output_tokens"))
    known = input_tokens is not None and output_tokens is not None
    return input_tokens, cached, output_tokens, known


def _known_total(row) -> int:
    total = 0
    value = row.get("input_tokens")
    if value is not None:
        total += max(0, int(value))
    value = row.get("output_tokens")
    if value is not None:
        total += max(0, int(value))
    return total


def _unknown_charge(row) -> int:
    """Conservative charge for a call whose final usage is not known."""
    return max(int(row.get("reserve_tokens") or 0), _known_total(row))


def _token_charge(row) -> int:
    """Tokens charged against the controller policy for one row."""
    if row.get("status") in ACTIVE_STATUSES or not row.get("usage_known"):
        return _unknown_charge(row)
    return _known_total(row)


def _in_window(row, now: int, window_seconds: int) -> bool:
    return int(row["created_at"]) + int(window_seconds) > int(now)


def _call_in_scope(row, now: int, window_seconds: int) -> bool:
    """Whether a row consumes the call cap right now."""
    status = row.get("status")
    if status in ACTIVE_STATUSES:
        return True
    return status in TERMINAL_STATUSES and _in_window(row, now, window_seconds)


def _token_in_scope(row, now: int, window_seconds: int) -> bool:
    """Whether a row consumes the token budget right now.

    Terminal calls with unknown usage keep their reservation indefinitely:
    their uncertainty cannot be aged away.  Known terminal calls age out with
    the rolling window.
    """
    status = row.get("status")
    if status in ACTIVE_STATUSES:
        return True
    if status not in TERMINAL_STATUSES:
        return False
    if not row.get("usage_known"):
        return True
    return _in_window(row, now, window_seconds)


def _call_retry_at(rows, now: int, window_seconds: int, max_calls: int):
    """Earliest epoch when one more controller call could be admitted."""
    active = [r for r in rows if r.get("status") in ACTIVE_STATUSES]
    if len(active) + 1 > max_calls:
        return None
    terminal = [r for r in rows if r.get("status") in TERMINAL_STATUSES
                and _in_window(r, now, window_seconds)]
    allowed = max_calls - 1 - len(active)
    if len(terminal) <= allowed:
        return now + 1
    remaining = len(terminal)
    expiries = sorted(int(r["created_at"]) + int(window_seconds) for r in terminal)
    index = 0
    while index < len(expiries):
        when = expiries[index]
        while index < len(expiries) and expiries[index] == when:
            remaining -= 1
            index += 1
        if remaining <= allowed:
            return when
    return None


def _token_retry_at(rows, now: int, window_seconds: int,
                    token_limit: int, reserve_tokens: int):
    """Earliest epoch when the token budget could admit a reservation."""
    permanent = 0
    terminal_known = []
    for row in rows:
        if row.get("status") in ACTIVE_STATUSES:
            permanent += _unknown_charge(row)
        elif row.get("status") in TERMINAL_STATUSES:
            if not row.get("usage_known"):
                permanent += _unknown_charge(row)
            elif _in_window(row, now, window_seconds):
                terminal_known.append(row)
    if permanent + reserve_tokens > token_limit:
        return None
    remaining = sum(_known_total(r) for r in terminal_known)
    if permanent + remaining + reserve_tokens <= token_limit:
        return now + 1
    expiries = {}
    for row in terminal_known:
        when = int(row["created_at"]) + int(window_seconds)
        expiries[when] = expiries.get(when, 0) + _known_total(row)
    for when in sorted(expiries):
        remaining -= expiries[when]
        if permanent + remaining + reserve_tokens <= token_limit:
            return when
    return None


def _limit_retry_at(call_at, token_at):
    if call_at is None or token_at is None:
        return None
    return max(call_at, token_at)


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

def reserve(db_path, call_id, *, workflow_id, event_key, provider,
            max_calls=8, window_seconds=18000, token_limit=120000,
            reserve_tokens=16000, now=None):
    """Atomically reserve one controller call.

    Returns a dict with ``ok``, ``reason`` and ``retry_at``.  A duplicate
    ``call_id`` returns ``ok=False``/``already_reserved`` and must never be
    executed again.  Capacity rejections return ``call_limit`` or
    ``token_limit``; ``retry_at`` is the earliest local window expiry when a
    retry could become possible, or ``None`` when an uncertain/active
    reservation means waiting cannot help.
    """
    call_id_text = None
    try:
        call_id_text = _text(call_id, "call_id")
        workflow_id_text = _text(workflow_id, "workflow_id")
        provider_text = _text(provider, "provider")
        event_key_text = "" if event_key is None else str(event_key)
        max_calls_int = _non_negative_int(max_calls, "max_calls")
        window_int = _non_negative_int(window_seconds, "window_seconds")
        token_limit_int = _non_negative_int(token_limit, "token_limit")
        reserve_int = _non_negative_int(reserve_tokens, "reserve_tokens")
        now_int = _epoch(now)
    except (TypeError, ValueError, OverflowError) as exc:
        return {
            "ok": False,
            "reason": "invalid_argument",
            "error": str(exc),
            "call_id": call_id_text if call_id_text is not None else call_id,
            "retry_at": None,
        }

    con = _connect(db_path)
    try:
        _begin_immediate(con)
        existing = con.execute(
            "SELECT * FROM controller_usage WHERE call_id=?", (call_id_text,)
        ).fetchone()
        if existing is not None:
            _rollback(con)
            row = _row_dict(existing)
            return {
                "ok": False,
                "reason": "already_reserved",
                "call_id": call_id_text,
                "status": row.get("status"),
                "role": row.get("role"),
                "workflow_id": row.get("workflow_id"),
                "provider": row.get("provider"),
                "retry_at": None,
            }

        rows = [dict(r) for r in con.execute(
            "SELECT * FROM controller_usage WHERE role=?", (CONTROLLER,)
        ).fetchall()]

        call_count = sum(
            1 for row in rows if _call_in_scope(row, now_int, window_int)
        )
        token_used = sum(
            _token_charge(row) for row in rows
            if _token_in_scope(row, now_int, window_int)
        )

        call_blocked = call_count + 1 > max_calls_int
        token_blocked = token_used + reserve_int > token_limit_int
        if call_blocked or token_blocked:
            _rollback(con)
            call_at = _call_retry_at(rows, now_int, window_int, max_calls_int)
            token_at = _token_retry_at(
                rows, now_int, window_int, token_limit_int, reserve_int
            )
            reasons = []
            if call_blocked:
                reasons.append("call_limit")
            if token_blocked:
                reasons.append("token_limit")
            return {
                "ok": False,
                "reason": reasons[0],
                "reasons": reasons,
                "limit": "calls" if call_blocked and not token_blocked else (
                    "tokens" if token_blocked and not call_blocked else "both"
                ),
                "call_id": call_id_text,
                "workflow_id": workflow_id_text,
                "provider": provider_text,
                "retry_at": _limit_retry_at(call_at, token_at),
                "controller_calls": call_count,
                "max_calls": max_calls_int,
                "tokens_used": token_used,
                "token_limit": token_limit_int,
                "reserve_tokens": reserve_int,
                "window_seconds": window_int,
                "now": now_int,
            }

        con.execute(
            "INSERT INTO controller_usage("
            "call_id, role, workflow_id, event_key, provider, status, "
            "created_at, finished_at, input_tokens, cached_input_tokens, "
            "output_tokens, usage_known, reserve_tokens, updated_at"
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                call_id_text, CONTROLLER, workflow_id_text, event_key_text,
                provider_text, "reserved", now_int, None, None, None, None,
                0, reserve_int, now_int,
            ),
        )
        con.commit()
        return {
            "ok": True,
            "reason": "reserved",
            "call_id": call_id_text,
            "status": "reserved",
            "workflow_id": workflow_id_text,
            "provider": provider_text,
            "retry_at": None,
            "controller_calls": call_count + 1,
            "max_calls": max_calls_int,
            "tokens_used": token_used + reserve_int,
            "token_limit": token_limit_int,
            "reserve_tokens": reserve_int,
            "window_seconds": window_int,
            "now": now_int,
        }
    except BaseException:
        _rollback(con)
        raise
    finally:
        con.close()


def _result_from_row(row, *, changed: bool, reason: str) -> dict:
    row = dict(row)
    status = row.get("status")
    uncertain = status in ACTIVE_STATUSES or not row.get("usage_known")
    return {
        "ok": True,
        "reason": reason,
        "changed": bool(changed),
        "call_id": row.get("call_id"),
        "status": status,
        "workflow_id": row.get("workflow_id"),
        "provider": row.get("provider"),
        "input_tokens": row.get("input_tokens"),
        "cached_input_tokens": row.get("cached_input_tokens"),
        "output_tokens": row.get("output_tokens"),
        "usage_known": bool(row.get("usage_known")),
        "reserved_tokens": _unknown_charge(row) if uncertain else 0,
        "charged_tokens": _token_charge(row),
        "uncertain": bool(uncertain),
        "retry_blocked": status in ACTIVE_STATUSES,
        "retry_at": None,
    }


def finish(db_path, call_id, *, usage=None, status="completed", now=None):
    """Record the terminal state of an existing controller reservation.

    Idempotent: once a terminal call has known usage its accounting is frozen.
    A terminal call whose usage is still unknown may later be resolved by a
    finish call with complete usage; it is never re-charged.  Repeated finishes
    with no new information leave the reservation (and the uncertainty) alone.
    """
    try:
        call_id_text = _text(call_id, "call_id")
        status_text = _text(status, "status")
        if status_text not in VALID_FINISH_STATUSES:
            raise ValueError(
                "status must be one of " + ", ".join(VALID_FINISH_STATUSES)
            )
        now_int = _epoch(now)
        input_tokens, cached, output_tokens, usage_known = _normalize_usage_args(usage)
        if status_text == "unknown":
            # An unknown outcome cannot carry final usage.  Retain the full
            # reservation instead of trusting a possibly stale usage value.
            input_tokens = cached = output_tokens = None
            usage_known = False
    except (TypeError, ValueError, OverflowError) as exc:
        return {
            "ok": False,
            "reason": "invalid_argument",
            "error": str(exc),
            "call_id": call_id,
            "retry_at": None,
        }

    con = _connect(db_path)
    try:
        _begin_immediate(con)
        found = con.execute(
            "SELECT * FROM controller_usage WHERE call_id=?", (call_id_text,)
        ).fetchone()
        if found is None:
            _rollback(con)
            return {
                "ok": False,
                "reason": "not_found",
                "call_id": call_id_text,
                "retry_at": None,
            }
        row = dict(found)
        if row.get("role") != CONTROLLER:
            _rollback(con)
            return {
                "ok": False,
                "reason": "wrong_role",
                "call_id": call_id_text,
                "role": row.get("role"),
                "retry_at": None,
            }

        # Freeze a terminal call once its accounting is fully known.  A later
        # unknown/failed report must not downgrade or double-charge it.
        if row.get("status") in TERMINAL_STATUSES and row.get("usage_known"):
            _rollback(con)
            return _result_from_row(found, changed=False, reason="already_finished")

        # Repeated uncertainty is a no-op; do not move the timestamp or add a
        # second reservation.
        if (row.get("status") == "unknown"
                and status_text == "unknown" and not usage_known):
            _rollback(con)
            return _result_from_row(found, changed=False, reason="already_unknown")

        # A completed/failed call with unknown usage can be explicitly resolved
        # by a later finish that supplies complete usage.  Without usage, keep
        # the original terminal status rather than downgrading it.
        if (row.get("status") in TERMINAL_STATUSES
                and not row.get("usage_known") and not usage_known):
            _rollback(con)
            return _result_from_row(found, changed=False, reason="already_finished")

        store_usage = usage is not None or status_text == "unknown"
        new_input = input_tokens if store_usage else row.get("input_tokens")
        new_cached = cached if store_usage else row.get("cached_input_tokens")
        new_output = output_tokens if store_usage else row.get("output_tokens")
        new_known = 1 if usage_known else 0

        con.execute(
            "UPDATE controller_usage SET status=?, finished_at=?, "
            "input_tokens=?, cached_input_tokens=?, output_tokens=?, "
            "usage_known=?, updated_at=? WHERE call_id=?",
            (
                status_text, now_int, new_input, new_cached, new_output,
                new_known, now_int, call_id_text,
            ),
        )
        con.commit()
        updated = con.execute(
            "SELECT * FROM controller_usage WHERE call_id=?", (call_id_text,)
        ).fetchone()
        return _result_from_row(updated, changed=True, reason="updated")
    except BaseException:
        _rollback(con)
        raise
    finally:
        con.close()


def record_execution(db_path, call_id, *, workflow_id, provider, usage=None,
                     status="completed", now=None):
    """Idempotently record an executor call in the shared report.

    Executor rows never participate in controller admission or token caps.
    Caller-supplied usage is normalized; missing usage remains unknown.
    """
    try:
        call_id_text = _text(call_id, "call_id")
        workflow_id_text = _text(workflow_id, "workflow_id")
        provider_text = _text(provider, "provider")
        raw_status = _text(status, "status")
        status_text = _EXECUTION_STATUS_ALIASES.get(raw_status.lower())
        if status_text is None:
            raise ValueError(
                "unsupported execution status: " + raw_status
            )
        now_int = _epoch(now)
        input_tokens, cached, output_tokens, usage_known = _normalize_usage_args(usage)
        if status_text == "unknown":
            input_tokens = cached = output_tokens = None
            usage_known = False
    except (TypeError, ValueError, OverflowError) as exc:
        return {
            "ok": False,
            "reason": "invalid_argument",
            "error": str(exc),
            "call_id": call_id,
            "retry_at": None,
        }

    con = _connect(db_path)
    try:
        _begin_immediate(con)
        existing = con.execute(
            "SELECT * FROM controller_usage WHERE call_id=?", (call_id_text,)
        ).fetchone()
        if existing is not None:
            _rollback(con)
            row = dict(existing)
            if row.get("role") != EXECUTOR:
                return {
                    "ok": False,
                    "reason": "already_reserved",
                    "call_id": call_id_text,
                    "role": row.get("role"),
                    "status": row.get("status"),
                    "retry_at": None,
                }
            return _result_from_row(
                existing, changed=False, reason="already_recorded"
            )
        con.execute(
            "INSERT INTO controller_usage("
            "call_id, role, workflow_id, event_key, provider, status, "
            "created_at, finished_at, input_tokens, cached_input_tokens, "
            "output_tokens, usage_known, reserve_tokens, updated_at"
            ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                call_id_text, EXECUTOR, workflow_id_text, "", provider_text,
                status_text, now_int, now_int, input_tokens, cached,
                output_tokens, 1 if usage_known else 0, 0, now_int,
            ),
        )
        con.commit()
        row = con.execute(
            "SELECT * FROM controller_usage WHERE call_id=?", (call_id_text,)
        ).fetchone()
        return _result_from_row(row, changed=True, reason="recorded")
    except BaseException:
        _rollback(con)
        raise
    finally:
        con.close()


def _empty_counter() -> dict:
    return {
        "calls": 0,
        "input_tokens": 0,
        "cached_input_tokens": 0,
        "output_tokens": 0,
        "unknown_usage_calls": 0,
        "reserved_tokens": 0,
    }


def _accumulate(counter: dict, row: dict, *, controller: bool,
                now: int, window_seconds: int) -> None:
    in_call_scope = _call_in_scope(row, now, window_seconds)
    if in_call_scope:
        counter["calls"] += 1
        if row.get("usage_known"):
            for key in ("input_tokens", "cached_input_tokens", "output_tokens"):
                value = row.get(key)
                if value is not None:
                    counter[key] += max(0, int(value))
    if controller:
        # An uncertain terminal call retains its reservation beyond the rolling
        # window even though it no longer consumes the call cap.  Keep it
        # visible so report and admission use the same conservative numbers.
        if _token_in_scope(row, now, window_seconds) and (
                row.get("status") in ACTIVE_STATUSES or not row.get("usage_known")):
            counter["reserved_tokens"] += _unknown_charge(row)
        if (row.get("status") != "reserved"
                and not row.get("usage_known")):
            counter["unknown_usage_calls"] += 1
    elif in_call_scope and not row.get("usage_known"):
        counter["unknown_usage_calls"] += 1


def report(db_path, window_seconds=18000, now=None):
    """Summarize controller and executor usage for the local rolling window.

    Top-level token/call fields describe controller calls only.  Executor calls
    are visible in ``providers``/``roles`` but are excluded from the controller
    budget and from the top-level controller counters.
    """
    try:
        window_int = _non_negative_int(window_seconds, "window_seconds")
        now_int = _epoch(now)
    except (TypeError, ValueError, OverflowError):
        window_int = 18000
        now_int = _epoch(None)

    con = _connect(db_path)
    try:
        rows = [dict(r) for r in con.execute(
            "SELECT * FROM controller_usage"
        ).fetchall()]
    finally:
        con.close()

    providers: dict = {}
    roles = {CONTROLLER: _empty_counter(), EXECUTOR: _empty_counter()}
    for row in rows:
        role = row.get("role")
        if role not in roles:
            continue
        provider = str(row.get("provider") or "unknown")
        bucket = providers.setdefault(
            provider, {CONTROLLER: _empty_counter(), EXECUTOR: _empty_counter()}
        )
        is_controller = role == CONTROLLER
        _accumulate(bucket[role], row, controller=is_controller,
                    now=now_int, window_seconds=window_int)
        _accumulate(roles[role], row, controller=is_controller,
                    now=now_int, window_seconds=window_int)

    controller = roles[CONTROLLER]
    executor = roles[EXECUTOR]
    return {
        "policy_not_account_quota": True,
        "note": POLICY_NOTE,
        "window_seconds": window_int,
        "now": now_int,
        "controller_calls": controller["calls"],
        "input_tokens": controller["input_tokens"],
        "cached_input_tokens": controller["cached_input_tokens"],
        "output_tokens": controller["output_tokens"],
        "reported": {
            "input_tokens": controller["input_tokens"],
            "cached_input_tokens": controller["cached_input_tokens"],
            "output_tokens": controller["output_tokens"],
        },
        "unknown_usage_calls": controller["unknown_usage_calls"],
        "reserved_tokens": controller["reserved_tokens"],
        "controller": dict(controller),
        "executor": dict(executor),
        "roles": roles,
        "providers": providers,
        "by_provider": providers,
        "by_role": roles,
    }


# ---------------------------------------------------------------------------
# extraction from provider JSONL logs
# ---------------------------------------------------------------------------

def _load_event(line):
    if isinstance(line, dict):
        return line
    if isinstance(line, (bytes, bytearray)):
        try:
            line = bytes(line).decode("utf-8", "replace")
        except Exception:
            return None
    if not isinstance(line, str):
        return None
    text = line.strip()
    if not text:
        return None
    start = text.find("{")
    if start < 0:
        return None
    text = text[start:]
    try:
        value = json.loads(text)
    except (ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def _iter_events(lines):
    if isinstance(lines, (str, bytes, bytearray)):
        if isinstance(lines, (bytes, bytearray)):
            try:
                lines = bytes(lines).decode("utf-8", "replace")
            except Exception:
                return
        pieces = lines.splitlines() if "\n" in lines else [lines]
    elif isinstance(lines, dict):
        pieces = [lines]
    else:
        try:
            pieces = list(lines)
        except TypeError:
            return
    for piece in pieces:
        event = _load_event(piece)
        if event is not None:
            yield event


def _provider_key(provider) -> str:
    return str(provider or "").strip().lower().replace("_", "-")


def _unavailable(provider) -> dict:
    return {
        "input_tokens": None,
        "cached_input_tokens": None,
        "output_tokens": None,
        "source": "unavailable",
        "provider": provider,
        "known": False,
    }


def _extraction_result(input_tokens, cached, output_tokens, source, provider) -> dict:
    return {
        "input_tokens": input_tokens,
        "cached_input_tokens": cached,
        "output_tokens": output_tokens,
        "source": source,
        "provider": provider,
        "known": True,
    }


def _codex_usage(usage):
    if not isinstance(usage, dict):
        return None
    input_tokens = _as_token(usage.get("input_tokens"))
    output_tokens = _as_token(usage.get("output_tokens"))
    if input_tokens is None or output_tokens is None:
        return None
    cached = _as_token(usage.get("cached_input_tokens"))
    return input_tokens, cached, output_tokens


def _extract_codex(events, provider):
    # Codex emits one terminal turn.completed usage record.  If a malformed log
    # contains several, the last terminal record wins; they are never summed.
    found = None
    for event in events:
        if event.get("type") == "turn.completed":
            parsed = _codex_usage(event.get("usage"))
            if parsed is not None:
                found = parsed
    if found is None:
        return _unavailable(provider)
    return _extraction_result(
        found[0], found[1], found[2], "codex.turn.completed", provider
    )


def _anthropic_usage(usage):
    if not isinstance(usage, dict):
        return None
    raw_input = _as_token(usage.get("input_tokens"))
    output_tokens = _as_token(usage.get("output_tokens"))
    if raw_input is None or output_tokens is None:
        return None
    read = _as_token(usage.get("cache_read_input_tokens"))
    create = _as_token(usage.get("cache_creation_input_tokens"))
    if read is not None or create is not None:
        # Anthropic-style input_tokens excludes cache reads/creations.  The
        # normalized input is the total prompt input; cached stays a subset.
        cached = (read or 0) + (create or 0)
        return raw_input + cached, read, output_tokens
    normalized_cached = _as_token(usage.get("cached_input_tokens"))
    if normalized_cached is not None:
        # Already-normalized schema: input_tokens is expected to include cache.
        return raw_input, normalized_cached, output_tokens
    return raw_input, None, output_tokens





def _dsh_usage(usage):
    if not isinstance(usage, dict):
        return None
    input_tokens = _as_token(usage.get("inputTokens"))
    output_tokens = _as_token(usage.get("outputTokens"))
    if input_tokens is None or output_tokens is None:
        input_tokens = _as_token(usage.get("input_tokens"))
        output_tokens = _as_token(usage.get("output_tokens"))
    if input_tokens is None or output_tokens is None:
        return None
    cache_read = _as_token(usage.get("cacheReadTokens"))
    if cache_read is None:
        cache_read = _as_token(usage.get("cache_read_tokens"))
    cache_write = _as_token(usage.get("cacheWriteTokens"))
    if cache_write is None:
        cache_write = _as_token(usage.get("cache_write_tokens"))
    # DSH reports uncached input plus cache read/write components.  Normalize
    # them into a total input count so input + output is the consumed amount.
    total_input = input_tokens + (cache_read or 0) + (cache_write or 0)
    cached = None
    if cache_read is not None or cache_write is not None:
        cached = cache_read
    return total_input, cached, output_tokens


def _extract_dsh(events, provider):
    # DSH emits one status/step_end record per model step.  Deduplicate by
    # (turn, step) and sum distinct steps; a duplicate terminal/step record is
    # replaced rather than counted twice.
    steps = {}
    order = []
    for index, event in enumerate(events):
        if event.get("type") != "status" or event.get("phase") != "step_end":
            continue
        parsed = _dsh_usage(event.get("usage"))
        if parsed is None:
            continue
        key = (event.get("turn"), event.get("step"))
        if key == (None, None):
            key = ("line", index)
        if key not in steps:
            order.append(key)
        steps[key] = parsed
    if not steps:
        return _unavailable(provider)
    parsed_steps = [steps[key] for key in order]
    # This recognized schema is per-step. Increasing counts are not evidence
    # of cumulative usage; guessing that would silently undercount real calls.
    total_input = 0
    total_cached = 0
    total_output = 0
    cached_known = False
    for input_tokens, cached, output_tokens in parsed_steps:
        total_input += input_tokens
        total_output += output_tokens
        if cached is not None:
            total_cached += cached
            cached_known = True
    return _extraction_result(
        total_input, total_cached if cached_known else None,
        total_output, "dsh.status.step_end", provider,
    )


def extract_usage(lines, provider):
    """Extract one normalized usage record from provider JSONL log lines.

    The return value always has ``input_tokens``, ``cached_input_tokens`` and
    ``output_tokens`` keys.  Unrecognized or incomplete usage yields ``None``
    values and ``source='unavailable'``; absence is never reported as zero.
    No cost or subscription conversion is performed.
    """
    key = _provider_key(provider)
    events = list(_iter_events(lines))
    if key in ("codex", "openai", "gpt") or key.startswith("codex-"):
        return _extract_codex(events, provider)
    if key in ("dsh", "dsh-text", "dsh-workspace", "deepseek") or key.startswith("dsh-"):
        return _extract_dsh(events, provider)
    return _unavailable(provider)


__all__ = [
    "reserve",
    "finish",
    "report",
    "record_execution",
    "extract_usage",
]
