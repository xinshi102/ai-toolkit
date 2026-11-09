"""stdout.ndjson event streams written by stream-json CLI runs (DSH and similar).

FORMAT: JSONL — one JSON object per line (``stdout.ndjson``, ``stdout.c2.ndjson`` ...).
VERSION: Claude-style CLI assistant-stream v1
         (type: system|assistant|result) plus ACP ``method=session/update``
         updates (sessionUpdate: tool_call|agent_message_chunk|usage_update).
"""
from __future__ import annotations

import json
from pathlib import Path

from .base import ok, unknown

NAME = 'ndjson'
FORMAT = 'JSONL (stdout*.ndjson, one JSON object per line)'
VERSION = ('Claude-style assistant-stream v1 + '
           'ACP method=session/update (tool_call, agent_message_chunk, usage_update)')


def parse_line(line):
    """One NDJSON line. A bad line is an explicit unknown, never a silent skip."""
    try:
        obj = json.loads(line)
    except (ValueError, TypeError) as exc:
        return unknown('ndjson bad line: %s' % exc.__class__.__name__)
    if not isinstance(obj, dict):
        return unknown('ndjson line is not an object')
    return ok(obj)


def parse_stream(path, limit=None):
    """Parse a whole stream; count unparseable lines as explicit unknown."""
    try:
        lines = Path(path).read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError as exc:
        return unknown('ndjson unreadable: %s' % exc.__class__.__name__)
    if limit:
        lines = lines[-limit:]
    events, bad = [], 0
    for line in lines:
        res = parse_line(line)
        if res['ok']:
            events.append(res['value'])
        else:
            bad += 1
    return ok({'events': events, 'unknown': bad})


def health():
    """Can we parse at least one real stdout.ndjson from the known roots?"""
    root = Path(__file__).resolve().parents[2] / 'outputs'
    if not root.exists():
        return unknown('ndjson health: no run root')
    path = next((p for p in root.rglob('stdout*.ndjson') if 'node_modules' not in p.parts), None)
    if path is None:
        return unknown('ndjson health: no stdout.ndjson found')
    try:
        first = path.read_text(encoding='utf-8', errors='replace').splitlines()[0]
    except (OSError, IndexError):
        return unknown('ndjson health: empty/unreadable log')
    return parse_line(first)
