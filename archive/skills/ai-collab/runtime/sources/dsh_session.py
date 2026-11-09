"""DSH ``session.v4.jsonl.zstd`` session logs.

FORMAT: zstd-compressed JSONL; each line carries a ``data`` object.
VERSION: DSH session v4 — ``data.usage`` (inputTokens / outputTokens /
         cacheReadTokens / totalTokens), ``data.header.config.maxTokens`` and
         ``data.contextWindow``. Decoding is delegated to
         ``session_scanner.decode_zstd`` (lazily imported to avoid cycles).
"""
from __future__ import annotations

import json
from pathlib import Path

from .base import ok, unknown

NAME = 'dsh_session'
FORMAT = 'zstd-compressed JSONL (session.v4.jsonl.zstd)'
VERSION = ('DSH session v4: data.usage{inputTokens,outputTokens,'
           'cacheReadTokens,totalTokens}, data.header.config.maxTokens, data.contextWindow')
DSH_ROOT = Path.home() / '.dsh' / 'sessions'


def decode(path):
    """Decompress a session log; failure is an explicit unknown."""
    try:
        import session_scanner
        text = session_scanner.decode_zstd(Path(path))
    except Exception as exc:
        return unknown('dsh decode failed: %s' % exc.__class__.__name__)
    if text is None:
        return unknown('dsh zstd codec unavailable')
    return ok(text)


def parse_line(line):
    try:
        obj = json.loads(line)
    except (ValueError, TypeError) as exc:
        return unknown('dsh bad line: %s' % exc.__class__.__name__)
    if not isinstance(obj, dict):
        return unknown('dsh line is not an object')
    return ok(obj)


def health():
    if not DSH_ROOT.exists():
        return unknown('dsh health: no session dir')
    path = next(DSH_ROOT.rglob('session.v4.jsonl.zstd'), None)
    if path is None:
        return unknown('dsh health: no session.v4 log')
    decoded = decode(path)
    if not decoded['ok']:
        return decoded
    lines = decoded['value'].splitlines()
    if not lines:
        return unknown('dsh health: empty session log')
    return parse_line(lines[0])
