# Scan local AI session logs for the collab dashboard.
# Sources: Codex rollouts (~/.codex/sessions), DSH sessions (~/.dsh/sessions, zstd), Cursor transcripts (~/.cursor/projects).
# Read-only; results are cached by (path, mtime, size) so a 2s refresh stays cheap.
import ctypes
import json
import os
import re
import time
from ctypes import POINTER, Structure, c_size_t, c_uint, c_void_p
from pathlib import Path

import psutil

HOME = Path(os.path.expanduser('~'))
CODEX_ROOT = HOME / '.codex' / 'sessions'
DSH_ROOT = HOME / '.dsh' / 'sessions'
CURSOR_ROOT = HOME / '.cursor' / 'projects'
CB_ROOT = HOME / '.execa' / 'projects'
CB_SESSIONS = HOME / '.execa' / 'sessions'
DAYS = 3
LIMIT = 25

_CACHE = {}
_ZSTD = None


# ---------- zstd (ctypes, Git for Windows ships libzstd) ----------
class _In(Structure):
    _fields_ = [('src', c_void_p), ('size', c_size_t), ('pos', c_size_t)]


class _Out(Structure):
    _fields_ = [('dst', c_void_p), ('size', c_size_t), ('pos', c_size_t)]


def _zstd():
    global _ZSTD
    if _ZSTD is not None:
        return _ZSTD or None
    candidates = [
        r'C:\Program Files\Git\mingw64\bin\libzstd.dll',
        r'C:\Program Files\Git\usr\bin\msys-zstd-1.dll',
        'libzstd.dll',
    ]
    for path in candidates:
        try:
            lib = ctypes.CDLL(path)
        except OSError:
            continue
        lib.ZSTD_createDStream.restype = c_void_p
        lib.ZSTD_initDStream.argtypes = [c_void_p]
        lib.ZSTD_decompressStream.argtypes = [c_void_p, POINTER(_Out), POINTER(_In)]
        lib.ZSTD_decompressStream.restype = c_size_t
        lib.ZSTD_isError.argtypes = [c_size_t]
        lib.ZSTD_isError.restype = c_uint
        _ZSTD = lib
        return lib
    _ZSTD = False
    return None


def decode_zstd(path: Path):
    lib = _zstd()
    if lib is None:
        return None
    try:
        data = path.read_bytes()
        src = (ctypes.c_char * len(data)).from_buffer_copy(data)
        inb = _In(ctypes.cast(src, c_void_p), len(data), 0)
        ds = lib.ZSTD_createDStream()
        lib.ZSTD_initDStream(ds)
        outbuf = ctypes.create_string_buffer(1 << 20)
        out = _Out(ctypes.cast(outbuf, c_void_p), len(outbuf), 0)
        chunks = []
        while inb.pos < inb.size:
            out.pos = 0
            ret = lib.ZSTD_decompressStream(ds, ctypes.byref(out), ctypes.byref(inb))
            if lib.ZSTD_isError(ret):
                return None
            if out.pos:
                chunks.append(outbuf.raw[:out.pos])
            if ret == 0 and inb.pos >= inb.size:
                break
        return b''.join(chunks).decode('utf-8', 'replace')
    except Exception:
        return None


# ---------- helpers ----------
def clean(text: str, limit: int = 160) -> str:
    if not text:
        return ''
    t = ' '.join(str(text).split())
    return t[:limit]


def is_noise(text: str) -> bool:
    t = (text or '').lstrip()
    if t.startswith('<system-reminder') or t.startswith('Current runtime context') \
            or t.startswith('The following workspace instructions') or t.startswith('<INSTRUCTIONS>') \
            or t.startswith('# AGENTS.md instructions') or t.startswith('# AGENTS.md') \
            or t.startswith('<environment_context>'):
        return True
    # Tool/app envelopes such as <external_codex_apps_open_page>{...}
    if re.match(r'^<[A-Za-z_][A-Za-z0-9_-]*(\s|>)', t):
        return True
    return False


def msg_text(content) -> str:
    if isinstance(content, str):
        return content
    parts = []
    for c in content or []:
        if isinstance(c, dict) and c.get('type') in ('text', 'input_text', 'output_text'):
            parts.append(str(c.get('text', '')))
    return '\n'.join(parts)


def cache_get(path: Path):
    try:
        st = path.stat()
    except OSError:
        return None
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key in _CACHE:
        return _CACHE[key]
    return None


def cache_put(path: Path, value):
    try:
        st = path.stat()
    except OSError:
        return value
    _CACHE[(str(path), st.st_mtime_ns, st.st_size)] = value
    if len(_CACHE) > 400:
        for k in list(_CACHE.keys())[:200]:
            _CACHE.pop(k, None)
    return value


def recent_files(root: Path, pattern: str, days: int = DAYS, limit: int = LIMIT):
    if not root.exists():
        return []
    cutoff = time.time() - days * 86400
    items = []
    for p in root.rglob(pattern):
        try:
            st = p.stat()
        except OSError:
            continue
        if st.st_mtime >= cutoff:
            items.append((st.st_mtime, p))
    items.sort(reverse=True)
    return [p for _, p in items[:limit]]


# ---------- Codex ----------
def scan_codex():
    out = []
    for p in recent_files(CODEX_ROOT, 'rollout-*.jsonl'):
        cached = cache_get(p)
        if cached is not None and 'recent' in cached:
            out.append(cached)
            continue
        sid = title = cwd = model = last = ''
        created = ''
        msgs = 0
        recent = []
        try:
            with p.open('r', encoding='utf-8', errors='replace') as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    t = ev.get('type')
                    payload = ev.get('payload') or {}
                    if t == 'session_meta':
                        sid = payload.get('id') or payload.get('session_id') or sid
                        cwd = payload.get('cwd') or cwd
                        created = payload.get('timestamp') or created
                    elif t == 'turn_context':
                        model = payload.get('model') or model
                    elif t == 'response_item' and payload.get('type') == 'message':
                        role = payload.get('role')
                        text = msg_text(payload.get('content'))
                        if role == 'user':
                            msgs += 1
                            if not title and text and not is_noise(text):
                                title = clean(text)
                            if text and not is_noise(text):
                                recent.append({'role': 'user', 'text': clean(text, 400),
                                               'ts': ev.get('timestamp', '')})
                        elif role == 'assistant':
                            msgs += 1
                            if text:
                                last = clean(text, 200)
                                recent.append({'role': 'assistant', 'text': clean(text, 400),
                                               'ts': ev.get('timestamp', '')})
                        if len(recent) > 24:
                            recent = recent[-24:]
        except Exception:
            continue
        summary = {
            'source': 'Codex', 'id': sid or p.stem, 'path': str(p),
            'time': time.strftime('%Y-%m-%d %H:%M', time.localtime(p.stat().st_mtime)),
            'mtime': p.stat().st_mtime, 'title': title or '(无用户消息)',
            'cwd': cwd, 'model': model, 'msgs': msgs, 'last': last,
            'recent': recent[-12:],
        }
        cache_put(p, summary)
        out.append(summary)
    return out


# ---------- DSH ----------
def scan_dsh():
    out = []
    for p in recent_files(DSH_ROOT, 'session.v4.jsonl.zstd'):
        cached = cache_get(p)
        if cached is not None:
            out.append(cached)
            continue
        raw = decode_zstd(p)
        if raw is None:
            continue
        sid = title = cwd = model = last = ''
        msgs = 0
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            t = ev.get('type')
            data = ev.get('data') or {}
            if t == 'session':
                sid = data.get('id') or sid
                cwd = data.get('cwd') or cwd
            elif t == 'session/title':
                title = clean(data.get('title', '')) or title
            elif t == 'request/context':
                model = data.get('model') or model
            elif t == 'user/message':
                text = msg_text(data.get('content'))
                if text and not is_noise(text):
                    msgs += 1
                    if not title:
                        title = clean(text)
            elif t == 'assistant/message':
                text = msg_text(data.get('content'))
                if text:
                    msgs += 1
                    last = clean(text, 200)
        summary = {
            'source': 'DSH', 'id': sid or p.parent.name, 'path': str(p),
            'time': time.strftime('%Y-%m-%d %H:%M', time.localtime(p.stat().st_mtime)),
            'mtime': p.stat().st_mtime, 'title': title or '(无用户消息)',
            'cwd': cwd, 'model': model, 'msgs': msgs, 'last': last,
        }
        cache_put(p, summary)
        out.append(summary)
    return out


# ---------- Cursor ----------
def scan_cursor():
    files = []
    if CURSOR_ROOT.exists():
        for pattern in ('agent-transcripts/*.jsonl', '**/agent-transcripts/*.jsonl',
                        '**/agent-transcripts/**/*.jsonl'):
            files.extend(CURSOR_ROOT.glob(pattern))
    if not files:
        return [{
            'source': 'Cursor', 'id': 'cursor', 'path': str(CURSOR_ROOT),
            'time': '', 'mtime': 0, 'title': '已安装，未发现 agent 会话记录（尚未使用）',
            'cwd': '', 'model': '', 'msgs': 0, 'tools': 0, 'last': '',
        }]
    out = []
    for p in files[:LIMIT]:
        cached = cache_get(p)
        if cached is not None:
            out.append(cached)
            continue
        title = last = ''
        msgs = 0
        tools = 0
        try:
            with p.open('r', encoding='utf-8', errors='replace') as fh:
                for line in fh:
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    role = ev.get('role') or ev.get('type')
                    raw = ev.get('message') or ev.get('content') or ''
                    if isinstance(raw, dict):
                        raw_content = raw.get('content') or []
                    else:
                        raw_content = raw
                    text = msg_text(raw_content)
                    if role in ('user', 'human') and text:
                        msgs += 1
                        title = title or clean(text)
                    elif role in ('assistant', 'ai') and text:
                        msgs += 1
                        last = clean(text, 200)
                    content = raw_content if raw_content else (ev.get('content') or [])
                    if isinstance(content, dict):
                        content = content.get('content') or []
                    if isinstance(content, list):
                        tools += sum(1 for item in content
                                     if isinstance(item, dict) and item.get('type') == 'tool_use')
        except Exception:
            continue
        summary = {
            'source': 'Cursor', 'id': p.stem, 'path': str(p),
            'time': time.strftime('%Y-%m-%d %H:%M', time.localtime(p.stat().st_mtime)),
            'mtime': p.stat().st_mtime, 'title': title or '(无用户消息)',
            'cwd': '', 'model': '', 'msgs': msgs, 'tools': tools, 'last': last,
        }
        cache_put(p, summary)
        out.append(summary)
    return out


# ---------- ExecA CLI (local transcripts) ----------
def scan_execa():
    out = []
    for p in recent_files(CB_ROOT, '*.jsonl'):
        if 'tool-results' in p.parts:
            continue
        cached = cache_get(p)
        if cached is not None:
            out.append(cached)
            continue
        title = last = cwd = sid = ''
        msgs = 0
        try:
            with p.open('r', encoding='utf-8', errors='replace') as fh:
                for line in fh:
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    sid = ev.get('sessionId') or sid
                    cwd = ev.get('cwd') or cwd
                    if ev.get('type') != 'message':
                        continue
                    role = ev.get('role')
                    text = msg_text(ev.get('content'))
                    if role == 'user' and text and not is_noise(text):
                        msgs += 1
                        if not title:
                            title = clean(text)
                    elif role == 'assistant' and text:
                        msgs += 1
                        last = clean(text, 200)
        except Exception:
            continue
        summary = {
            'source': 'ExecA', 'id': sid or p.stem, 'path': str(p),
            'time': time.strftime('%Y-%m-%d %H:%M', time.localtime(p.stat().st_mtime)),
            'mtime': p.stat().st_mtime, 'title': title or '(无用户消息)',
            'cwd': cwd, 'model': '', 'msgs': msgs, 'last': last,
        }
        cache_put(p, summary)
        out.append(summary)
    return out


def scan_execa_active():
    """Running ExecA CLI processes register a session JSON (pid/sessionId/cwd/url)."""
    out = []
    if not CB_SESSIONS.exists():
        return out
    for p in CB_SESSIONS.glob('*.json'):
        try:
            data = json.loads(p.read_text(encoding='utf-8', errors='replace'))
        except Exception:
            continue
        pid = data.get('pid')
        try:
            if not pid or not psutil.pid_exists(pid):
                continue
        except Exception:
            continue
        sid = str(data.get('sessionId') or p.stem)
        cwd = str(data.get('cwd') or '')
        out.append({
            'source': 'ExecA', 'id': sid, 'path': str(p),
            'time': time.strftime('%Y-%m-%d %H:%M', time.localtime(p.stat().st_mtime)),
            'mtime': p.stat().st_mtime,
            'title': f'运行中 CLI 会话（{Path(cwd).name or cwd}）',
            'cwd': cwd, 'model': '', 'msgs': 0,
            'last': f"session {sid[:8]} · {data.get('url','')} · pid {pid}",
        })
    return out


def scan_all():
    sessions = []
    sources = [
        ('Codex', CODEX_ROOT, scan_codex),
        ('DSH', DSH_ROOT, scan_dsh),
        ('ExecA', CB_ROOT, scan_execa),
        ('Cursor', CURSOR_ROOT, scan_cursor),
    ]
    counts = {}
    for name, root, fn in sources:
        try:
            items = fn()
        except Exception:
            items = []
        counts[name] = len(items)
        sessions.extend(items)
    try:
        active = scan_execa_active()
        counts['ExecA'] = counts.get('ExecA', 0) + len(active)
        sessions.extend(active)
    except Exception:
        pass
    sessions.sort(key=lambda s: s.get('mtime') or 0, reverse=True)
    return {
        'sessions': sessions,
        'sources': [{'name': n, 'root': str(r), 'count': counts[n], 'exists': r.exists()} for n, r, _ in sources],
        'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
    }


if __name__ == '__main__':
    print(json.dumps(scan_all(), ensure_ascii=False, indent=2))
