"""GPT / Codex: 5h + weekly percentages from the local Codex session logs.

Reuses token_meter (which already parses rate_limits from rollout jsonl).
No provider account and no credentials are touched.
"""
from __future__ import annotations

from . import common

AGENT = 'GPT'


def parse(quota, now=None):
    """quota = token_meter.summarize(...)['quota']."""
    q = quota or {}
    primary = common.num(q.get('primary_used'))
    secondary = common.num(q.get('secondary_used'))
    if primary is None and secondary is None:
        return common.unknown(AGENT, 'Codex 会话日志里没有额度记录')
    main = common.row(AGENT, unit='percent', pct_used=primary, period='5h',
                      reset_at=q.get('primary_resets'), fetched_at=now or common.now())
    if secondary is not None:
        main['extra'] = [common.row('周', label='周', unit='percent',
                                    pct_used=secondary, period='week',
                                    reset_at=q.get('secondary_resets'))]
    return main


def fetch():
    try:
        import token_meter
        data = token_meter.summarize(token_meter.scan(), recent=1)
        return parse(data.get('quota') or {})
    except Exception:
        return common.unknown(AGENT, 'Codex 会话日志读取失败')
