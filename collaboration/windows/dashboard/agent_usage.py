"""Per-agent usage for the local board.

Codex: exact token counts + plan percentages from session logs.
ExecA: per-request usage from its `stdout.ndjson` stream.
ExecB: ACP context usage (`used/size`), not billing tokens.
DSH: token usage from session.v4 logs; context is the last totalTokens.
Cursor: local transcripts/sessions; token usage is not exposed.

No credentials, no provider account, no money conversion.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os as _os
_WS = _os.environ.get('XINSHI_WORKSPACE', 'E:/AI-Workspace').replace('\\', '/').rstrip('/')

import token_meter
import session_scanner
import usage_sources

LOCAL = timezone(timedelta(hours=8))
ROOTS = [
    Path(_WS + '/Projects/Shared/Agent-Conventions/outputs'),
    Path(_WS + '/Projects/Shared/Agent-Conventions/.work'),
]
CACHE = Path.home() / '.codex' / 'agent_usage_cache.json'
DSH_ROOT = Path.home() / '.dsh' / 'sessions'


def _load_cache():
    try:
        data = json.loads(CACHE.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_cache(cache):
    try:
        tmp = CACHE.with_suffix('.tmp')
        tmp.write_text(json.dumps(cache, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        tmp.replace(CACHE)
    except Exception:
        pass


def _parse(path: Path) -> dict:
    result = {'agent': '', 'path': str(path), 'calls': 0,
              'input': 0, 'cached': 0, 'uncached': 0, 'output': 0,
              'context_used': 0, 'context_size': 0, 'sessions': 0, 'tools': 0,
              'cost': 0.0}
    model = ''
    try:
        fh = path.open('r', encoding='utf-8', errors='replace')
    except OSError:
        return result
    lname = str(path).lower()
    with fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            typ = ev.get('type')
            if typ == 'system' and ev.get('subtype') == 'init':
                model = ev.get('model') or model
                result['sessions'] += 1
            elif typ == 'execb.init':
                result['agent'] = 'ExecB'
                result['sessions'] += 1
            elif typ == 'assistant':
                usage = (ev.get('message') or {}).get('usage') or {}
                if isinstance(usage, dict):
                    inp = int(usage.get('input_tokens') or 0)
                    create = int(usage.get('cache_creation_input_tokens') or 0)
                    read = int(usage.get('cache_read_input_tokens') or 0)
                    out = int(usage.get('output_tokens') or 0)
                    if any((inp, create, read, out)):
                        result['calls'] += 1
                        result['cached'] += read
                        result['uncached'] += inp + create
                        result['input'] += inp + create + read
                        result['output'] += out
            if ev.get('method') == 'session/update':
                update = (ev.get('params') or {}).get('update') or {}
                if update.get('sessionUpdate') == 'usage_update':
                    used = int(update.get('used') or 0)
                    size = int(update.get('size') or 0)
                    result['calls'] += 1
                    result['context_used'] = max(result['context_used'], used)
                    result['context_size'] = max(result['context_size'], size)
                    cost = update.get('cost')
                    if isinstance(cost, dict):
                        try:
                            result['cost'] += float(cost.get('amount') or 0)
                        except (TypeError, ValueError):
                            pass
                if update.get('sessionUpdate') == 'tool_call':
                    result['tools'] += 1
            if typ in ('tool_call', 'tool_result'):
                result['tools'] += 1
            if typ == 'final' and not result['agent']:
                result['agent'] = 'DSH'
    if not result['agent']:
        if 'execb' in lname:
            result['agent'] = 'ExecB'
        elif 'execa' in lname or model.startswith('claude'):
            result['agent'] = 'ExecA'
        elif 'dsh' in lname or 'quota-flow' in lname:
            result['agent'] = 'DSH'
    if result['agent'] == 'ExecA' and result['calls'] == 0 and model.startswith('claude'):
        result['agent'] = 'ExecA'
    return result


def _sum(items, keys):
    return {k: sum(int(x.get(k) or 0) for x in items) for k in keys}


def _parse_dsh_queue(path: Path) -> dict:
    result = {'agent': 'DSH', 'path': str(path), 'calls': 0,
              'input': 0, 'cached': 0, 'uncached': 0, 'output': 0,
              'context_used': 0, 'context_size': 0, 'sessions': 1, 'tools': 0}
    try:
        fh = path.open('r', encoding='utf-8', errors='replace')
    except OSError:
        return result
    with fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get('type') in ('tool_call', 'tool_result'):
                result['tools'] += 1
    return result


def _parse_dsh_session(path: Path) -> dict:
    result = {'agent': 'DSH', 'path': str(path), 'calls': 0,
              'input': 0, 'cached': 0, 'uncached': 0, 'output': 0,
              'context_used': 0, 'context_size': 0, 'sessions': 1, 'tools': 0}
    try:
        text = session_scanner.decode_zstd(path)
    except Exception:
        return result
    for line in text.splitlines():
        try:
            ev = json.loads(line)
        except Exception:
            continue
        data = ev.get('data')
        if not isinstance(data, dict):
            continue
        header = data.get('header') if isinstance(data.get('header'), dict) else {}
        cfg = header.get('config') if isinstance(header.get('config'), dict) else {}
        if cfg.get('maxTokens'):
            result['context_size'] = max(result['context_size'], int(cfg['maxTokens']))
        if data.get('contextWindow'):
            result['context_size'] = max(result['context_size'], int(data['contextWindow']))
        usage = data.get('usage')
        if not isinstance(usage, dict):
            stream = data.get('stream')
            chunk = stream.get('chunk') if isinstance(stream, dict) else {}
            usage = chunk.get('usage') if isinstance(chunk, dict) else None
        if isinstance(usage, dict):
            inp = int(usage.get('inputTokens') or 0)
            cached = int(usage.get('cacheReadTokens') or 0)
            out = int(usage.get('outputTokens') or 0)
            total = int(usage.get('totalTokens') or 0)
            if any((inp, cached, out, total)):
                result['calls'] += 1
                result['input'] += inp
                result['cached'] += cached
                result['uncached'] += max(0, inp - cached)
                result['output'] += out
                result['context_used'] = max(result['context_used'], total or (inp + out))
        msg = data.get('message')
        if isinstance(msg, dict):
            content = msg.get('content')
            if isinstance(content, list):
                result['tools'] += sum(1 for item in content
                                       if isinstance(item, dict) and item.get('type') == 'tool-call')
        if ev.get('type') in ('tool/call', 'tool_call'):
            result['tools'] += 1
    return result


def scan(days=1, now=None) -> dict:
    now = now or datetime.now(LOCAL)
    cutoff = time.time() - max(1, days) * 86400
    cache = _load_cache()
    changed = False
    runs = []
    for root in ROOTS:
        if not root.exists():
            continue
        for path in root.rglob('stdout*.ndjson'):
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_mtime < cutoff:
                continue
            key = str(path.resolve())
            entry = cache.get(key) or {}
            if entry.get('mtime') == stat.st_mtime and entry.get('size') == stat.st_size and isinstance(entry.get('data'), dict):
                data = entry['data']
            else:
                data = _parse(path)
                cache[key] = {'mtime': stat.st_mtime, 'size': stat.st_size, 'data': data}
                changed = True
            if data.get('agent'):
                runs.append(data)
        for path in root.rglob('*.jsonl'):
            lname = str(path).lower()
            if 'queue' not in lname or ('dsh' not in lname and 'quota-flow' not in lname):
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_mtime < cutoff:
                continue
            key = str(path.resolve())
            entry = cache.get(key) or {}
            if entry.get('mtime') == stat.st_mtime and entry.get('size') == stat.st_size and isinstance(entry.get('data'), dict):
                data = entry['data']
            else:
                data = _parse_dsh_queue(path)
                cache[key] = {'mtime': stat.st_mtime, 'size': stat.st_size, 'data': data}
                changed = True
            runs.append(data)
    if DSH_ROOT.exists():
        recent = []
        for path in DSH_ROOT.rglob('session.v4.jsonl.zstd'):
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_mtime >= cutoff:
                recent.append((stat.st_mtime, path, stat))
        for _, path, stat in sorted(recent, reverse=True)[:12]:
            key = str(path.resolve())
            entry = cache.get(key) or {}
            if entry.get('mtime') == stat.st_mtime and entry.get('size') == stat.st_size and isinstance(entry.get('data'), dict):
                data = entry['data']
            else:
                data = _parse_dsh_session(path)
                cache[key] = {'mtime': stat.st_mtime, 'size': stat.st_size, 'data': data}
                changed = True
            if data.get('calls') or data.get('sessions'):
                runs.append(data)
    if changed:
        _save_cache(cache)

    codex = token_meter.summarize(token_meter.scan(), days=days, recent=1)
    period = codex['periods']['last_5h']
    quota = codex['quota']
    agents = [{
        'agent': 'Codex / GPT', 'window': '近 5 小时',
        'calls': period['calls'], 'input': period['input'],
        'cached': period['cached'], 'uncached': period['uncached'],
        'output': period['output'],
        'quota': {'primary': quota.get('primary_used'), 'secondary': quota.get('secondary_used'),
                  'resets': quota.get('primary_resets')},
        'sessions': len(codex.get('sessions') or []),
        'tools': 0, 'context_used': 0, 'context_size': 0,
        'note': '会话日志口径；cached 是 input 的子集',
    }]

    label = '今日' if days <= 1 else '近 %d 天' % days
    for name in ('ExecA', 'ExecB', 'DSH'):
        items = [r for r in runs if r['agent'] == name]
        base = _sum(items, ('input', 'cached', 'uncached', 'output'))
        context = max([r['context_used'] for r in items] or [0])
        size = max([r['context_size'] for r in items] or [0])
        if name == 'ExecA':
            note = 'ExecA CLI 每次请求的 usage 汇总（含续跑）'
        elif name == 'ExecB':
            note = 'ExecB 本地 session_usage：积分 + 上下文占用'
        else:
            note = 'DSH 会话日志 usage 汇总'
        window = label
        agents.append({
            'agent': name, 'window': window,
            'calls': sum(r['calls'] for r in items),
            'input': base['input'], 'cached': base['cached'],
            'uncached': base['uncached'], 'output': base['output'],
            'quota': None, 'sessions': sum(r['sessions'] for r in items),
            'tools': sum(r['tools'] for r in items),
            'context_used': context, 'context_size': size, 'note': note,
            'cost': round(sum(float(r.get('cost') or 0) for r in items), 2),
        })
        if name == 'ExecB':
            wb = usage_sources.execb(days)
            if wb['ok']:
                agents[-1].update({'credits': wb['credits'], 'requests': wb['requests'],
                                   'sessions': max(agents[-1]['sessions'], wb['sessions']),
                                   'context_used': max(context, wb['context_used']),
                                   'context_size': max(size, wb['context_size'])})
    cursor_sessions = [s for s in session_scanner.scan_cursor() if s.get('msgs') or s.get('tools')]
    agents.append({
        'agent': 'Cursor', 'window': '本地会话', 'models': usage_sources.cursor_models(max(days, 7)),
        'calls': sum(int(s.get('msgs') or 0) for s in cursor_sessions),
        'input': 0, 'cached': 0, 'uncached': 0, 'output': 0,
        'quota': None, 'sessions': len(cursor_sessions),
        'tools': sum(int(s.get('tools') or 0) for s in cursor_sessions),
        'context_used': 0, 'context_size': 0,
        'note': 'Cursor 本地不记录 token（字段恒为 0）；显示会话活动与模型',
    })
    bx = usage_sources.hostc(days)
    bx['window'] = label
    agents.append(bx)
    return {'generated_at': now.isoformat(timespec='seconds'), 'days': days, 'agents': agents}
