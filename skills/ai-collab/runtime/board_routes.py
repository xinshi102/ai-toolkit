"""M4 (3): HTTP routing for the collab board (read-only, 127.0.0.1 only)."""
import json
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import board_api
import package_discovery
import quota.service as quota_service
import board_page
import session_scanner
import task_archive
import task_progress
from board_data import (ALLOWED_SUFFIXES, PROJECTS_ROOT, _rounds_cache,
                        _tasks_cache, agents_payload, parse_events, parse_round,
                        rounds_cached, usage_payload, workflows_payload)


def make_handler(roots):
    roots = [r.resolve() for r in roots]
    import inbox  # noqa: E402 - 可选接入，避免模块级循环 import
    inbox.set_roots(roots)
    open_roots = [*roots, task_progress.PLAN_ROOT, PROJECTS_ROOT]

    def inside(path: Path) -> bool:
        try:
            path = path.resolve()
        except Exception:
            return False
        for root in package_discovery.effective_roots(roots):
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

        def _asset(self, data, ctype, csp):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            if csp:
                self.send_header('Content-Security-Policy', csp)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            u = urlparse(self.path)
            if u.path == '/api/inbox/read_all':
                import inbox  # noqa: E402
                if not inbox.is_local(self.client_address):
                    self._json({'error': 'local only'}, 403)
                    return
                try:
                    length = min(int(self.headers.get('Content-Length') or 0), 1024)
                    payload = json.loads(self.rfile.read(length) or b'{}')
                except Exception:
                    payload = {}
                self._json(inbox.read_all(str((payload or {}).get('kind') or 'done')))
                return
            if u.path == '/api/inbox/act':
                import inbox  # noqa: E402 - 可选接入，避免模块级循环 import
                if not inbox.is_local(self.client_address):
                    self._json({'error': 'local only'}, 403)
                    return
                if 'application/json' not in (self.headers.get('Content-Type') or ''):
                    self._json({'error': 'json only'}, 415)
                    return
                try:
                    length = int(self.headers.get('Content-Length') or 0)
                except (TypeError, ValueError):
                    length = 0
                if length < 0 or length > inbox.MAX_BODY:
                    self._json({'error': 'body too large'}, 413)
                    return
                try:
                    payload = json.loads(self.rfile.read(length) or b'{}')
                except Exception:
                    payload = {}
                if not isinstance(payload, dict):
                    payload = {}
                text = payload.get('text')
                if text is not None and len(str(text)) > inbox.MAX_TEXT:
                    self._json({'error': 'text too long'}, 413)
                    return
                self._json(inbox.act(str(payload.get('id') or ''),
                                     payload.get('choice'), text))
                return
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
            if u.path == '/api/tree/assign':
                try:
                    length = int(self.headers.get('Content-Length') or 0)
                    payload = json.loads(self.rfile.read(length) or b'{}')
                except Exception:
                    payload = {}
                self._json(board_api.tree_assign(payload))
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
            page = board_page.render(u.path)
            if page is not None:
                self._asset(*page)
                return
            if u.path == '/api/inbox':
                import inbox  # noqa: E402 - 可选接入，避免模块级循环 import
                if not inbox.is_local(self.client_address):
                    self._json({'error': 'local only'}, 403)
                    return
            extra = board_api.handle_get(u.path, qs)
            if extra is not None:
                self._json(extra)
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
            if u.path == '/api/budget':
                self._json(board_api.budget_payload())
                return
            if u.path == '/api/quota':
                self._json(quota_service.snapshot())
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


