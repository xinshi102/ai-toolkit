"""M4 (4): centralized parsers for third-party logs / processes.

Every source module declares ``FORMAT`` (the external format it reads) and
``VERSION`` (the schema/release it was written against). Parsers never silently
swallow errors: a failed parse returns an explicit unknown (``display='未知'``),
so the board shows 未知 instead of a stale 0 or a cached old value.

All sources are read-only. No credentials, ``*.vscdb``, ``Local State`` or
``token*`` files are read.
"""
from __future__ import annotations

from .base import DISPLAY, UNKNOWN, is_unknown, ok, read, unknown
from . import dsh_session, ndjson, planmap, sqlite_sources

SOURCES = (ndjson, dsh_session, sqlite_sources, planmap)


def declarations():
    """Format / version contract of every third-party source."""
    return [{'name': s.NAME, 'format': s.FORMAT, 'version': s.VERSION}
            for s in SOURCES]


def source_status():
    """Per-agent parseability of the third-party sources behind the board.

    Codex / GPT is omitted: it is aggregated from local session logs, not a
    third-party process, so it is never marked unknown by this layer.
    """
    checks = {
    'DSH runs': ndjson.health,
        'DSH': dsh_session.health,
    }
    return {name: bool(check().get('ok')) for name, check in checks.items()}


def mark_unknown(payload, status=None):
    """Flag agent rows whose third-party source failed to parse.

    Additive: known rows are untouched, so calm.html's existing features
    (grouping, recent actions, drawer, archive, theme) keep their behavior.
    """
    status = source_status() if status is None else status
    for row in (payload.get('agents') or []):
        if status.get(row.get('agent')) is False:
            row['unknown'] = True
            row['note'] = '来源解析失败：显示未知，不使用 0 或旧值'
    return payload
