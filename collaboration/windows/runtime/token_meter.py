"""Local, read-only Codex token meter.

Codex session logs (`~/.codex/sessions/**/rollout-*.jsonl`) contain, for every
model response, `last_token_usage` and the rate-limit percentages at that
moment. This module turns them into per-call / per-hour / per-session totals so
consumption is visible without reading the provider account.

It does not estimate money, does not access credentials, and does not claim the
plan's absolute limit. Percentages are copied from the log; token counts are
the local record.
"""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

LOCAL = timezone(timedelta(hours=8))
DEFAULT_ROOT = Path.home() / '.codex' / 'sessions'


def _ts(value):
    try:
        return datetime.fromisoformat(str(value).replace('Z', '+00:00')).astimezone(LOCAL)
    except Exception:
        return None


def _local_now(now=None):
    if now is None:
        return datetime.now(LOCAL)
    if isinstance(now, datetime):
        return now.astimezone(LOCAL) if now.tzinfo else now.replace(tzinfo=LOCAL)
    return _ts(now) or datetime.now(LOCAL)


def parse_session(path: Path) -> dict:
    """Return {id, path, cwd, model, calls:[...]} from one rollout file."""
    calls = []
    prev_total = 0
    seen = set()
    meta = {'id': path.stem, 'path': str(path), 'cwd': '', 'model': ''}
    try:
        fh = path.open('r', encoding='utf-8', errors='replace')
    except OSError:
        return {**meta, 'calls': calls}
    with fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            ts = _ts(ev.get('timestamp'))
            if not ts:
                continue
            typ = ev.get('type')
            payload = ev.get('payload') or {}
            if typ == 'session_meta':
                meta['id'] = payload.get('id') or meta['id']
                meta['cwd'] = payload.get('cwd') or meta['cwd']
            elif typ == 'turn_context':
                meta['cwd'] = payload.get('cwd') or meta['cwd']
                meta['model'] = payload.get('model') or meta['model']
            elif typ == 'event_msg' and payload.get('type') == 'token_count':
                info = payload.get('info') or {}
                last = info.get('last_token_usage') or {}
                total = (info.get('total_token_usage') or {}).get('total_tokens')
                if not isinstance(total, int):
                    total = None
                key = (ts.isoformat(), total)
                if key in seen:
                    continue
                seen.add(key)
                inp = last.get('input_tokens')
                cached = last.get('cached_input_tokens')
                out = last.get('output_tokens')
                reason = last.get('reasoning_output_tokens')
                if not isinstance(inp, int):
                    inp = max(0, (total or 0) - prev_total)
                if not isinstance(cached, int):
                    cached = 0
                if not isinstance(out, int):
                    out = 0
                if not isinstance(reason, int):
                    reason = 0
                if total is not None:
                    prev_total = total
                rate = payload.get('rate_limits') or {}
                primary = rate.get('primary') or {}
                secondary = rate.get('secondary') or {}
                calls.append({
                    'ts': ts.isoformat(),
                    'input': max(0, inp),
                    'cached': max(0, min(cached, inp)),
                    'uncached': max(0, inp - max(0, min(cached, inp))),
                    'output': max(0, out),
                    'reasoning': max(0, reason),
                    'primary_used': primary.get('used_percent'),
                    'primary_resets': primary.get('resets_at'),
                    'primary_window': primary.get('window_minutes'),
                    'secondary_used': secondary.get('used_percent'),
                    'secondary_resets': secondary.get('resets_at'),
                    'secondary_window': secondary.get('window_minutes'),
                })
    return {**meta, 'calls': calls}


def scan(root=None, since=None) -> list[dict]:
    root = Path(root or DEFAULT_ROOT)
    if not root.exists():
        return []
    sessions = []
    for path in root.rglob('rollout-*.jsonl'):
        if since:
            try:
                if datetime.fromtimestamp(path.stat().st_mtime, LOCAL) < since:
                    continue
            except OSError:
                continue
        data = parse_session(path)
        if data['calls']:
            sessions.append(data)
    return sessions


def _sum(calls):
    return {
        'calls': len(calls),
        'input': sum(c['input'] for c in calls),
        'cached': sum(c['cached'] for c in calls),
        'uncached': sum(c['uncached'] for c in calls),
        'output': sum(c['output'] for c in calls),
        'reasoning': sum(c['reasoning'] for c in calls),
    }


def summarize(sessions, now=None, days=7, recent=20) -> dict:
    now = _local_now(now)
    calls = []
    for s in sessions:
        for c in s['calls']:
            c = dict(c)
            c['session'] = s['id']
            c['cwd'] = s['cwd']
            c['model'] = s['model']
            calls.append(c)
    calls.sort(key=lambda c: c['ts'])
    periods = {
        'last_5h': now - timedelta(hours=5),
        'today': now.replace(hour=0, minute=0, second=0, microsecond=0),
        'last_7d': now - timedelta(days=days),
    }
    out = {'generated_at': now.isoformat(timespec='seconds'), 'periods': {},
           'recent': calls[-recent:][::-1], 'sessions': []}
    for name, cutoff in periods.items():
        selected = [c for c in calls if _ts(c['ts']) and _ts(c['ts']) >= cutoff]
        out['periods'][name] = _sum(selected)
    latest = calls[-1] if calls else None
    out['quota'] = {
        'primary_used': latest.get('primary_used') if latest else None,
        'primary_resets': latest.get('primary_resets') if latest else None,
        'primary_window': latest.get('primary_window') if latest else None,
        'secondary_used': latest.get('secondary_used') if latest else None,
        'secondary_resets': latest.get('secondary_resets') if latest else None,
        'secondary_window': latest.get('secondary_window') if latest else None,
        'source': 'last token_count in local session log',
    }
    by_session = {}
    for c in calls:
        item = by_session.setdefault(c['session'], {
            'session': c['session'], 'cwd': c['cwd'], 'model': c['model'],
            'calls': 0, 'input': 0, 'cached': 0, 'output': 0, 'first': c['ts'], 'last': c['ts'],
        })
        item['calls'] += 1
        item['input'] += c['input']
        item['cached'] += c['cached']
        item['output'] += c['output']
        item['last'] = c['ts']
    out['sessions'] = sorted(by_session.values(), key=lambda x: x['last'], reverse=True)
    hourly = {}
    for c in calls:
        ts = _ts(c['ts'])
        if not ts or ts < now - timedelta(hours=24):
            continue
        key = ts.strftime('%m-%d %H:00')
        item = hourly.setdefault(key, {'hour': key, 'calls': 0, 'input': 0, 'cached': 0, 'output': 0})
        item['calls'] += 1
        item['input'] += c['input']
        item['cached'] += c['cached']
        item['output'] += c['output']
    out['hourly'] = [hourly[k] for k in sorted(hourly)]
    return out


def fmt(n) -> str:
    n = int(n or 0)
    if n >= 1_000_000:
        return f'{n / 1_000_000:.2f}M'
    if n >= 1_000:
        return f'{n / 1_000:.1f}k'
    return str(n)


def _reset_text(epoch):
    if not epoch:
        return '?'
    try:
        return datetime.fromtimestamp(int(epoch), LOCAL).strftime('%m-%d %H:%M')
    except Exception:
        return '?'


def text_report(data: dict) -> str:
    q = data.get('quota') or {}
    lines = [f"Codex token usage  ({data['generated_at']})",
             f"Quota: 5h {q.get('primary_used')}%  weekly {q.get('secondary_used')}%  "
             f"(5h resets {_reset_text(q.get('primary_resets'))}, "
             f"weekly resets {_reset_text(q.get('secondary_resets'))})",
             '',
             f"{'period':<10} {'calls':>5} {'input':>9} {'cached':>9} {'uncached':>9} {'output':>8} {'reason':>7}"]
    for name, label in (('last_5h', 'last 5h'), ('today', 'today'), ('last_7d', 'last 7d')):
        s = data['periods'].get(name, {})
        lines.append(f"{label:<10} {s.get('calls',0):>5} {fmt(s.get('input')):>9} "
                     f"{fmt(s.get('cached')):>9} {fmt(s.get('uncached')):>9} "
                     f"{fmt(s.get('output')):>8} {fmt(s.get('reasoning')):>7}")
    lines.append('')
    lines.append('recent calls (newest first):')
    for c in data.get('recent', [])[:10]:
        lines.append(f"  {c['ts'][11:19]}  in {fmt(c['input']):>7}  cache {fmt(c['cached']):>7}  "
                     f"out {fmt(c['output']):>5}  quota5h {c.get('primary_used')}%  {c.get('cwd','')}")
    lines.append('')
    lines.append('by session (newest first):')
    for s in data.get('sessions', [])[:8]:
        lines.append(f"  {s['last'][5:16]}  calls {s['calls']:>3}  in {fmt(s['input']):>8}  "
                     f"cache {fmt(s['cached']):>8}  out {fmt(s['output']):>6}  {s.get('cwd','')}")
    if data.get('hourly'):
        lines.append('')
        lines.append('hourly (last 24h):')
        for h in data['hourly']:
            lines.append(f"  {h['hour']}  calls {h['calls']:>3}  in {fmt(h['input']):>8}  "
                         f"cache {fmt(h['cached']):>8}  out {fmt(h['output']):>6}")
    return '\n'.join(lines)


def main():
    ap = argparse.ArgumentParser(description='local Codex token meter')
    ap.add_argument('--root', default=str(DEFAULT_ROOT))
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--recent', type=int, default=20)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--watch', type=float, default=0, help='refresh every N seconds')
    args = ap.parse_args()
    while True:
        sessions = scan(args.root, since=_local_now() - timedelta(days=args.days + 1))
        data = summarize(sessions, days=args.days, recent=args.recent)
        print(json.dumps(data, ensure_ascii=False, indent=2) if args.json else text_report(data))
        if not args.watch:
            return 0
        time.sleep(max(5.0, args.watch))


if __name__ == '__main__':
    raise SystemExit(main())
