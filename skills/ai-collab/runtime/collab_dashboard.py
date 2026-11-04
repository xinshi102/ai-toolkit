# Collab dashboard: a local read-only web board for multi-AI work packages.
# Each "round" is a directory containing request.json / stdout.ndjson / receipt.json / reply.md.
# Rounds are grouped by task (explicit task id in request.json, or a XINSHI-* token in the prompt,
# or the dated output folder that contains the run).
#
# Usage:
#   python -B runtime/collab_dashboard.py --port 18765
#   python -B runtime/collab_dashboard.py --port 18765 --root E:/.../outputs
#
# Read-only: it never writes into the run directories. Binds 127.0.0.1 only.
import argparse
import json
import re
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import session_scanner
import token_meter
import workflow_scanner
import agent_usage
import task_groups
import remote_target
import dispatch_guard
import task_taxonomy
import task_archive
import task_progress
import board_api

DEFAULT_ROOT = Path(__file__).resolve().parent.parent / 'outputs'
DEFAULT_ROOTS = [Path(__file__).resolve().parent.parent / 'outputs', Path(__file__).resolve().parent.parent / '.work', *[Path(x) for x in os.environ.get('AI_COLLAB_ROOTS', '').split(',') if x.strip()]]
PROJECTS_ROOT = Path(os.environ.get('AI_COLLAB_PROJECTS') or Path.home())
ALLOWED_SUFFIXES = {'.json', '.md', '.ndjson', '.log', '.txt', '.png'}


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8', errors='replace'))
    except Exception:
        return {}


def read_text(path: Path, limit: int = 0) -> str:
    if not path.exists():
        return ''
    text = path.read_text(encoding='utf-8', errors='replace')
    return text[:limit] if limit else text


def collect(root: Path, limit: int = 300):
    dirs = set()
    for p in root.rglob('stdout*.ndjson'):
        if 'node_modules' in p.parts:
            continue
        d = p.parent
        if (d / 'request.json').exists() or (d / 'reply.md').exists() or (d / 'spec.json').exists():
            dirs.add(d)
    runs = sorted(dirs, key=lambda d: d.stat().st_mtime, reverse=True)
    return runs[:limit]


def collect_all(roots, limit: int = 300):
    items = []
    for root in roots:
        if not root.exists():
            continue
        for d in collect(root, limit):
            items.append((d, root))
    items.sort(key=lambda pair: pair[0].stat().st_mtime, reverse=True)
    return items[:limit]


def derive_task(d: Path, root: Path, req: dict, prompt: str):
    """Return (task_key, source). Prefer a short explicit id, then a XINSHI-* token, then the dated folder."""
    for key in ('task_id', 'taskId', 'planId', 'plan'):
        value = req.get(key) if isinstance(req, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip(), 'field'
    # Some older runners put the whole task text in "task"; only use it as a label when it is short.
    value = req.get('task') if isinstance(req, dict) else None
    if isinstance(value, str):
        text = ' '.join(value.split())
        if 0 < len(text) <= 60 and '\n' not in value:
            return text, 'field'
    match = re.search(r'\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,})\b', prompt or '')
    if match:
        token = match.group(1)
        base = re.sub(r'-[A-Z]$', '', token)
        if base.count('-') >= 2:
            return base, 'id'
        return token, 'id'
    try:
        rel = d.resolve().relative_to(root.resolve())
        parts = list(rel.parts[:-1])
    except Exception:
        parts = [d.name]
    for part in reversed(parts):
        if re.match(r'^\d{4}-\d{2}-\d{2}', part):
            return part, 'folder'
    return (parts[0] if parts else d.name), 'folder'


def infer_agent(req, d: Path) -> str:
    if isinstance(req, dict):
        for key in ('assigned_agent', 'agent', 'owner', 'provider', 'executor'):
            value = req.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    argv = ' '.join(str(x) for x in ((req or {}).get('argv') or []))
    hay = f'{argv} {d.name} {d.parent.name}'.lower()
    if 'codex' in hay or d.name.lower().startswith('gpt'):
        return 'Codex'
    if 'dsh' in hay or 'deepseek' in hay:
        return 'DSH'
    return '未知'


def first_line(text, limit=70) -> str:
    for line in str(text or '').splitlines():
        value = line.strip().lstrip('#').strip()
        if value:
            return value[:limit]
    return ''


def _attempt_files(d: Path, stem: str, ext: str):
    """stdout.ndjson, stdout.c2.ndjson, ... in attempt order (run_package.py continuation)."""
    files = list(d.glob('%s*%s' % (stem, ext)))
    def order(p):
        mid = p.name[len(stem):-len(ext)]
        return int(mid[2:]) if mid.startswith('.c') and mid[2:].isdigit() else (1 if mid == '' else 10 ** 6)
    return sorted([p for p in files if order(p) < 10 ** 6], key=order)


def parse_round(d: Path, root: Path):
    req = load_json(d / 'request.json') or load_json(d / 'spec.json') or {}
    receipts = _attempt_files(d, 'receipt', '.json')
    rec = load_json(receipts[-1]) if receipts else {}
    replies = _attempt_files(d, 'reply', '.md')
    reply = read_text(replies[-1]).strip() if replies else ''
    if not reply:
        reply = str((rec.get('parsed') or {}).get('final_text', '') or rec.get('reply', '') or '').strip()
    prompt = str(req.get('prompt', '') or '')
    argv = req.get('argv', []) or []
    tools = ''
    if '--tools' in argv:
        i = argv.index('--tools')
        if i + 1 < len(argv):
            tools = str(argv[i + 1])
    acp_tools = []
    seen_messages = set()
    tokens_in = tokens_out = 0
    session = model = first = last = ''
    turns = 0
    result_errors = []
    result_subtype = ''
    attempts = len(receipts) or 1
    for log in _attempt_files(d, 'stdout', '.ndjson'):
        for line in log.read_text(encoding='utf-8', errors='replace').splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get('type') == 'system' and ev.get('subtype') == 'init':
                session = ev.get('session_id', '') or session
                model = ev.get('model', '') or model
            if ev.get('type') == 'assistant':
                turns += 1
                usage = (ev.get('message') or {}).get('usage') or {}
                if isinstance(usage, dict):
                    tokens_in += int(usage.get('input_tokens') or 0)
                    tokens_out += int(usage.get('output_tokens') or 0)
            if ev.get('type') == 'result':
                result_subtype = str(ev.get('subtype') or '')
                result_errors = [str(x) for x in (ev.get('errors') or []) if str(x).strip()]
            if ev.get('method') == 'session/update':
                params = ev.get('params') or {}
                update = params.get('update') or {}
                session = params.get('sessionId') or session
                kind = update.get('sessionUpdate')
                if kind == 'agent_message_chunk':
                    mid = update.get('messageId')
                    if mid not in seen_messages:
                        seen_messages.add(mid)
                        turns += 1
                elif kind == 'tool_call':
                    meta = update.get('_meta') or {}
                    name = str(update.get('title') or '').split(' ')[0]
                    if name:
                        acp_tools.append(str(name))
            ts = ev.get('__timestamp') or ''
            if ts:
                first = first or ts
                last = ts
    if not tools and acp_tools:
        tools = ', '.join(dict.fromkeys(acp_tools))
    duration = None
    if first and last:
        try:
            a = datetime.fromisoformat(first.replace('Z', '+00:00'))
            b = datetime.fromisoformat(last.replace('Z', '+00:00'))
            duration = int((b - a).total_seconds())
        except Exception:
            pass
    exit_code = rec.get('exit_code')
    if rec.get('task_state') == 'unknown':
        status = 'UNKNOWN'
    elif rec.get('workflow_status') == 'accepted':
        status = 'ACCEPTED'
    elif rec.get('stall'):
        status = 'FAIL'
    elif (rec.get('parsed') or {}).get('transport_policy_passed') is False and exit_code == 0 and reply \
            and set((rec.get('parsed') or {}).get('failures') or []) <= {'tool_error'}:
        status = 'WARN'
    elif rec.get('workflow_status') == 'failed' or (rec.get('parsed') or {}).get('transport_policy_passed') is False:
        status = 'FAIL'
    elif rec.get('task_state') == 'succeeded':
        status = 'UNREVIEWED'
    elif exit_code == 0 and reply:
        status = 'OK'
    elif exit_code == 0:
        status = 'NO_REPLY'
    elif exit_code is None:
        logs = _attempt_files(d, 'stdout', '.ndjson')
        log_path = logs[-1] if logs else d / 'stdout.ndjson'
        try:
            recent = log_path.exists() and time.time() - log_path.stat().st_mtime < 300
        except Exception:
            recent = False
        status = 'RUNNING' if recent else 'NO_RECEIPT'
    else:
        status = 'FAIL'
    task, task_source = derive_task(d, root, req, prompt)
    reason = ''
    if status == 'WARN':
        reason = '已完成并有最终回复；过程中有工具报错（如测试失败后修复）'
    elif status == 'FAIL' and rec.get('stall'):
        reason = '卡住检测：' + str((rec.get('stall') or {}).get('reason') or '')
    elif status == 'FAIL':
        reason = '; '.join(result_errors)
        if not reason:
            reason = '; '.join(str(x) for x in ((rec.get('parsed') or {}).get('failures') or []))
        if not reason:
            reason = '运行失败（无更多错误信息）'
    elif status in ('NO_RECEIPT', 'NO_REPLY', 'UNKNOWN'):
        reason = '没有回执/最终回复，可能已中断或未继续'
    group = str((req.get('task_group') if isinstance(req, dict) else '') or '') or task_groups.group_for(task)
    agent = infer_agent(req, d)
    title = first_line(prompt) or d.name
    remote = remote_target.extract(prompt + '\n' + json.dumps(req, ensure_ascii=False))
    assigned = dispatch_guard.normalize_agent(req.get('assigned_agent')) if isinstance(req, dict) and req.get('assigned_agent') else ''
    if not assigned:
        assigned = dispatch_guard.normalize_agent(dispatch_guard.contract_for(task).get('executor'))
    package = str((req.get('package') if isinstance(req, dict) else '') or task_taxonomy.package_for(task, group))
    subtask = str((req.get('subtask') if isinstance(req, dict) else '') or task_taxonomy.subtask_for(d.name, task))
    package_title = task_taxonomy.title_for(package)
    nonce = ''
    m = re.search(r'nonce[ \t]*[:：]?[ \t]*([0-9a-fA-F]{6,})', prompt + ' ' + reply)
    if m:
        nonce = m.group(1)
    try:
        folder = str(d.resolve().relative_to(root.resolve()).parent)
    except Exception:
        folder = ''
    return {
        'dir': str(d),
        'name': d.name,
        'folder': folder,
        'task': task,
        'task_source': task_source,
        'group': group,
        'package': package,
        'package_title': package_title,
        'subtask': subtask,
        'agent': agent,
        'title': title,
        'remote': remote,
        'assigned': assigned,
        'task_id': str(req.get('task_id') or '') if isinstance(req, dict) else '',
        'continuation_of': str(req.get('continuation_of') or '') if isinstance(req, dict) else '',
        'attempts': attempts,
        'time': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(d.stat().st_mtime)),
        'mtime': d.stat().st_mtime,
        'status': status,
        'reason': reason,
        'result_subtype': result_subtype,
        'exit': exit_code,
        'tree': rec.get('tree_stopped'),
        'tools': tools,
        'turns': turns,
        'tokens_in': tokens_in,
        'tokens_out': tokens_out,
        'duration': duration,
        'session': session,
        'model': model or (str(req.get('model') or '') if isinstance(req, dict) else ''),
        'prompt': prompt,
        'reply': reply,
        'nonce': nonce,
        'artifacts': {
            'request.json': (d / 'request.json').exists(),
            'stdout.ndjson': (d / 'stdout.ndjson').exists(),
            'receipt.json': (d / 'receipt.json').exists(),
            'reply.md': (d / 'reply.md').exists(),
        },
    }


def mark_superseded(rounds):
    """A failed/unfinished package that a later package continues is history, not an open problem."""
    continued = {}
    for r in rounds:
        parent = r.get('continuation_of')
        if parent:
            continued[parent] = max(continued.get(parent, 0), r.get('mtime') or 0)
    for r in rounds:
        key = r.get('task_id') or r.get('name')
        if r['status'] in ('FAIL', 'NO_RECEIPT', 'NO_REPLY', 'WARN') and key in continued and continued[key] >= (r.get('mtime') or 0):
            r['status_raw'] = r['status']
            r['status'] = 'SUPERSEDED'
            r['reason'] = '已由后续续包接替（原状态 %s）' % r['status_raw']
    return rounds


def parse_events(dir_path: Path, limit: int = 40):
    logs = _attempt_files(dir_path, 'stdout', '.ndjson')
    log = logs[-1] if logs else dir_path / 'stdout.ndjson'
    events = []
    if not log.exists():
        return events
    lines = log.read_text(encoding='utf-8', errors='replace').splitlines()
    for line in lines[-limit:]:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get('type', '')
        out = {'type': t, 'subtype': ev.get('subtype', ''), 'ts': ev.get('__timestamp', '')}
        if ev.get('method') == 'session/update':
            params = ev.get('params') or {}
            update = params.get('update') or {}
            kind = str(update.get('sessionUpdate', ''))
            out['type'] = 'acp'
            out['subtype'] = kind
            if kind == 'tool_call':
                out['text'] = f"[tool {update.get('title','')}] {json.dumps(update.get('rawInput', {}), ensure_ascii=False)[:300]}"
            elif kind == 'agent_message_chunk':
                content = update.get('content') or {}
                out['text'] = str(content.get('text', ''))[:800]
            else:
                out['text'] = f"{kind} {json.dumps(update, ensure_ascii=False)[:300]}"
        elif t == 'system' and ev.get('subtype') == 'init':
            out['text'] = f"session={str(ev.get('session_id',''))[:8]} model={ev.get('model','')} tools={','.join(ev.get('tools', []))}"
        elif t == 'assistant':
            parts = []
            for c in (ev.get('message') or {}).get('content', []) or []:
                if c.get('type') == 'text':
                    parts.append(c.get('text', ''))
                elif c.get('type') == 'tool_use':
                    parts.append(f"[tool_use {c.get('name','')}] " + json.dumps(c.get('input', {}), ensure_ascii=False)[:200])
            out['text'] = '\n'.join(parts)[:1500]
        elif t == 'result':
            out['text'] = str(ev.get('result', ''))[:800]
        else:
            out['text'] = json.dumps(ev, ensure_ascii=False)[:300]
        events.append(out)
    return events


PAGE = ''  # legacy inline page removed; board_ui/calm.html is the page


_usage_cache = {'at': 0.0, 'data': None}
_rounds_cache = {'at': 0.0, 'key': None, 'data': None}
_wf_cache = {'at': 0.0, 'data': None}
_agents_cache = {}
_tasks_cache = {'at': 0.0, 'data': None}


def agents_payload(days=1):
    now = time.time()
    days = 7 if days == 7 else 1
    entry = _agents_cache.setdefault(days, {'at': 0.0, 'data': None})
    if entry['data'] is None or now - entry['at'] > 10:
        entry['data'] = agent_usage.scan(days=days)
        entry['at'] = now
    return entry['data']


def workflows_payload():
    now = time.time()
    if _wf_cache['data'] is None or now - _wf_cache['at'] > 15:
        _wf_cache['data'] = workflow_scanner.scan(days=3)
        _wf_cache['at'] = now
    return {'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'workflows': _wf_cache['data']}


def usage_payload():
    now = time.time()
    if _usage_cache['data'] is None or now - _usage_cache['at'] > 10:
        sessions = token_meter.scan()
        _usage_cache['data'] = token_meter.summarize(sessions, days=2, recent=8)
        _usage_cache['at'] = now
    return _usage_cache['data']


def rounds_cached(roots):
    now = time.time()
    key = tuple(str(r) for r in roots)
    if (_rounds_cache['data'] is None or now - _rounds_cache['at'] > 8 or _rounds_cache['key'] != key):
        _rounds_cache['data'] = mark_superseded([parse_round(d, r) for d, r in collect_all(roots)])
        _rounds_cache['at'] = now
        _rounds_cache['key'] = key
    return _rounds_cache['data']


def make_handler(roots):
    roots = [r.resolve() for r in roots]
    open_roots = [*roots, task_progress.PLAN_ROOT, PROJECTS_ROOT]

    def inside(path: Path) -> bool:
        try:
            path = path.resolve()
        except Exception:
            return False
        for root in roots:
            try:
                path.relative_to(root)
                return True
            except Exception:
                continue
        return False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _json(self, payload, code=200):
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _html(self, html: str):
            body = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _static(self, path: Path, ctype: str):
            data = path.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            if ctype.startswith('text/html'):
                self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'")
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            u = urlparse(self.path)
            if u.path == '/api/open':
                if 'application/json' not in (self.headers.get('Content-Type') or ''):
                    self._json({'error': 'json only'}, 415)
                    return
                try:
                    length = int(self.headers.get('Content-Length') or 0)
                    payload = json.loads(self.rfile.read(length) or b'{}')
                except Exception:
                    payload = {}
                self._json({'ok': board_api.open_folder(str(payload.get('path') or ''), open_roots)})
                return
            if u.path != '/api/archive':
                self.send_response(404)
                self.end_headers()
                return
            try:
                length = int(self.headers.get('Content-Length') or 0)
                payload = json.loads(self.rfile.read(length) or b'{}')
            except Exception:
                payload = {}
            action = str(payload.get('action') or '')
            keys = [str(k) for k in (payload.get('keys') or []) if str(k).strip()]
            if action == 'archive':
                task_archive.archive(keys, str(payload.get('reason') or 'manual'))
            elif action == 'unarchive':
                task_archive.unarchive(keys or None)
            elif action != 'list':
                self._json({'error': 'unknown action'}, 400)
                return
            self._json({'ok': True, 'archived': task_archive.load()})

        def do_GET(self):
            u = urlparse(self.path)
            qs = parse_qs(u.query)
            if u.path in board_api.PAGES:
                self._static(board_api.UI_DIR / board_api.PAGES[u.path], 'text/html; charset=utf-8')
                return
            if u.path.startswith('/ui/'):
                name = u.path[4:]
                p = board_api.UI_DIR / name
                if '/' in name or '\\' in name or not p.is_file() or p.suffix not in ('.css', '.js'):
                    self.send_response(404)
                    self.end_headers()
                    return
                self._static(p, 'text/css; charset=utf-8' if p.suffix == '.css' else 'text/javascript; charset=utf-8')
                return
            if u.path == '/api/feed':
                rounds = rounds_cached(roots)
                if _tasks_cache['data'] is None or time.time() - _tasks_cache['at'] > 10:
                    _tasks_cache['data'] = task_progress.scan()
                    _tasks_cache['at'] = time.time()
                items = board_api.feed(rounds)
                board_api.assign_tasks(items, rounds, (_tasks_cache['data'] or {}).get('states', []))
                self._json({'items': items})
                return
            if u.path == '/api/detail':
                dir_path = Path(qs.get('dir', [''])[0])
                if not inside(dir_path):
                    self._json({'error': 'outside roots'}, 403)
                    return
                key = str(dir_path)
                cached = _rounds_cache.get('data') or []
                hit = next((r for r in cached if r['dir'] == key), None)
                if hit is None:
                    root = next(r for r in roots if str(dir_path.resolve()).startswith(str(r)))
                    hit = parse_round(dir_path, root)
                self._json(board_api.detail(hit))
                return
            if u.path == '/api/meta':
                srcs = [{'label': '执行记录 · ' + r.name, 'path': str(r)} for r in roots]
                srcs.append({'label': 'Plan Map 计划数据', 'path': str(task_progress.PLAN_ROOT)})
                for s in (_tasks_cache.get('data') or task_progress.scan()).get('states', [])[:6]:
                    srcs.append({'label': '项目状态 · %s/%s' % (s['project'], s['task']), 'path': str(Path(s['path']).parent)})
                self._json({'sources': srcs})
                return
            if u.path == '/api/rounds':
                rounds = rounds_cached(roots)
                self._json({'root': ' | '.join(str(r) for r in roots), 'count': len(rounds),
                            'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'rounds': rounds})
                return
            if u.path == '/api/sessions':
                self._json(session_scanner.scan_all())
                return
            if u.path == '/api/usage':
                self._json(usage_payload())
                return
            if u.path == '/api/workflows':
                self._json(workflows_payload())
                return
            if u.path == '/api/agents':
                try:
                    days = int(qs.get('days', ['1'])[0])
                except ValueError:
                    days = 1
                self._json(agents_payload(days))
                return
            if u.path == '/api/tasks':
                now = time.time()
                if _tasks_cache['data'] is None or now - _tasks_cache['at'] > 10:
                    _tasks_cache['data'] = task_progress.scan()
                    _tasks_cache['at'] = now
                self._json(_tasks_cache['data'])
                return
            if u.path == '/note':
                try:
                    p = Path(qs.get('path', [''])[0]).resolve()
                    p.relative_to(PROJECTS_ROOT.resolve())
                    ok = p.is_file() and p.suffix.lower() == '.md' and (p.name == 'STATE.md' or p.parent.name == 'journal')
                except Exception:
                    ok = False
                if not ok:
                    self._json({'error': 'not allowed'}, 403)
                    return
                data = p.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if u.path == '/api/archive':
                self._json({'archived': task_archive.load()})
                return
            if u.path == '/api/events':
                dir_path = Path(qs.get('dir', [''])[0])
                if not inside(dir_path):
                    self._json({'error': 'outside roots'}, 403)
                    return
                try:
                    limit = int(qs.get('limit', ['40'])[0])
                except Exception:
                    limit = 40
                self._json(parse_events(dir_path, max(1, min(limit, 200))))
                return
            if u.path == '/file':
                raw = qs.get('path', [''])[0]
                p = Path(raw)
                try:
                    p = p.resolve()
                except Exception:
                    p = None
                if p is None or not inside(p):
                    self._json({'error': 'outside roots'}, 403)
                    return
                if not p.is_file() or p.suffix.lower() not in ALLOWED_SUFFIXES:
                    self._json({'error': 'not allowed'}, 404)
                    return
                data = p.read_bytes()
                ctype = 'application/json; charset=utf-8' if p.suffix.lower() == '.json' else (
                    'text/plain; charset=utf-8' if p.suffix.lower() in {'.md', '.ndjson', '.log', '.txt'} else 'image/png')
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(404)
            self.end_headers()

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--roots', default=','.join(str(p) for p in DEFAULT_ROOTS),
                    help='comma-separated run roots (default: <ai-collab>/outputs, .work, AI_COLLAB_ROOTS)')
    ap.add_argument('--root', default='', help='single root override')
    ap.add_argument('--port', type=int, default=18765)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    if args.root:
        roots = [Path(args.root)]
    else:
        roots = [Path(part.strip()) for part in args.roots.split(',') if part.strip()]
    roots = [r for r in roots if r.exists()]
    if not roots:
        print('no existing roots: ' + args.roots)
        return 2
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(roots))
    threading.Thread(target=session_scanner.scan_all, daemon=True).start()
    threading.Thread(target=token_meter.scan, daemon=True).start()
    threading.Thread(target=lambda: collect_all(roots), daemon=True).start()
    print(f'collab dashboard: http://{args.host}:{args.port}/  (roots: {", ".join(str(r) for r in roots)})')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
