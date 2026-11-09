"""Shared result helpers for third-party source parsers (M4).

A parse either succeeds (``ok``) or fails explicitly (``unknown``). No parser
returns a bare 0 / ``None`` / stale value on failure: the board renders
``display='未知'`` instead of a misleading number.
"""
from __future__ import annotations

UNKNOWN = object()          # sentinel: no reliable value exists
DISPLAY = '未知'            # what the board shows instead of 0 / an old value


def ok(value):
    return {'ok': True, 'value': value, 'display': None, 'reason': ''}


def unknown(reason=''):
    return {'ok': False, 'value': UNKNOWN, 'display': DISPLAY, 'reason': str(reason)}


def is_unknown(result):
    return isinstance(result, dict) and result.get('ok') is False


def read(source_name, parse_fn, *args, **kwargs):
    """Run a parser; any exception becomes an explicit unknown result."""
    try:
        result = parse_fn(*args, **kwargs)
        if isinstance(result, dict) and 'ok' in result:
            return result
        return ok(result)
    except Exception as exc:  # third-party data is untrusted
        return unknown('%s: %s' % (source_name, exc.__class__.__name__))
