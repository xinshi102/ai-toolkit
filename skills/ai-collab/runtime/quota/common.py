"""Shared shape + helpers for quota rows. Standard library only.

A row is the fetch() contract:
  {agent, status, reason, unit, used, limit, remaining, pct_used, period,
   reset_at, extra, fetched_at}
plus a few harmless display fields (key, role, label, note, stale,
last_ok_at, stale_reason) added by the service / extra rows.
"""
from __future__ import annotations

import json
import time
import urllib.request


def now():
    return time.time()


def num(value):
    """Coerce a JSON number/numeric string to int or float, else None."""
    try:
        if value is None or isinstance(value, bool):
            return None
        f = float(value)
        return int(f) if f == int(f) else round(f, 2)
    except (TypeError, ValueError):
        return None


def pct(used, limit):
    if used is None or not limit:
        return None
    return round(used / limit * 100, 1)


def row(agent, **kwargs):
    out = {
        'agent': agent, 'status': 'ok', 'reason': None, 'unit': None,
        'used': None, 'limit': None, 'remaining': None, 'pct_used': None,
        'period': None, 'reset_at': None, 'extra': [], 'fetched_at': None,
        'label': None, 'key': None, 'role': None, 'note': None,
        'stale': False, 'last_ok_at': None, 'stale_reason': None,
    }
    out.update(kwargs)
    return out


def unknown(agent, reason, **kwargs):
    return row(agent, status='unknown', reason=reason, fetched_at=now(), **kwargs)


def http_json(url, headers=None, body=None, timeout=15):
    """One HTTP call via urllib only. Raises on any HTTP/network error."""
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        url, data=data, headers=headers or {},
        method='POST' if data is not None else 'GET')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))
