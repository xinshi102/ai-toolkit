"""Extra per-agent usage sources for the collab board (read-only, local).

HostC:       %APPDATA%/HostC/engine/sessions.db - activity only; HostC stores no token counts locally.
ExecB: ~/.execb/execb.db table session_usage - context used/size and credits per request.
Cursor:    token counts are present in state.vscdb but always 0 locally; report activity + model only.

All databases are opened with mode=ro. No credentials are read.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

HOSTC_DB = Path(os.environ.get('APPDATA', '')) / 'HostC' / 'engine' / 'sessions.db'
EXECB_DB = Path.home() / '.execb' / 'execb.db'
CURSOR_TRACK_DB = Path.home() / '.cursor' / 'ai-tracking' / 'ai-code-tracking.db'


def _ro(path: Path):
    return sqlite3.connect('file:%s?mode=ro' % path.as_posix(), uri=True, timeout=2)


def hostc(days: int = 1) -> dict:
    out = {'agent': 'HostC', 'sessions': 0, 'calls': 0, 'tools': 0, 'last_title': '', 'last_active': '',
           'input': 0, 'cached': 0, 'uncached': 0, 'output': 0, 'context_used': 0, 'context_size': 0,
           'token_known': False, 'note': 'HostC 本地不记录 token；显示会话活动'}
    if not HOSTC_DB.exists():
        out['note'] = '未发现 HostC 会话库'
        return out
    cutoff = datetime.fromtimestamp(time.time() - max(1, days) * 86400, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    try:
        con = _ro(HOSTC_DB)
        try:
            row = con.execute("select count(*), count(distinct session_id), "
                              "sum(case when tool_calls is not null and tool_calls not in ('', '[]', 'null') then 1 else 0 end) "
                              "from messages where timestamp >= ? and role = 'assistant'", (cutoff,)).fetchone()
            out['calls'], out['sessions'], out['tools'] = int(row[0] or 0), int(row[1] or 0), int(row[2] or 0)
            last = con.execute('select title, updated_at from sessions order by updated_at desc limit 1').fetchone()
            if last:
                out['last_title'], out['last_active'] = str(last[0] or '')[:60], str(last[1] or '')
            tok = con.execute('select sum(token_total) from sessions where updated_at >= ?', (cutoff,)).fetchone()
            if tok and tok[0]:
                out['input'] = int(tok[0])
                out['token_known'] = True
        finally:
            con.close()
    except sqlite3.Error as exc:
        out['note'] = 'HostC 会话库读取失败：%s' % exc.__class__.__name__
    return out


def execb(days: int = 1) -> dict:
    out = {'sessions': 0, 'context_used': 0, 'context_size': 0, 'credits': 0.0, 'requests': 0, 'ok': False}
    if not EXECB_DB.exists():
        return out
    cutoff_ms = int((time.time() - max(1, days) * 86400) * 1000)
    try:
        con = _ro(EXECB_DB)
        try:
            rows = con.execute('select used, size, credit_json from session_usage where updated_at >= ?', (cutoff_ms,)).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return out
    out['ok'] = True
    for used, size, credit in rows:
        out['sessions'] += 1
        out['context_used'] = max(out['context_used'], int(used or 0))
        out['context_size'] = max(out['context_size'], int(size or 0))
        try:
            data = json.loads(credit) if credit else {}
        except ValueError:
            data = {}
        if isinstance(data, dict):
            for value in data.values():
                try:
                    out['credits'] += float(value)
                    out['requests'] += 1
                except (TypeError, ValueError):
                    pass
    out['credits'] = round(out['credits'], 2)
    return out


def cursor_models(days: int = 7) -> list:
    if not CURSOR_TRACK_DB.exists():
        return []
    cutoff_ms = int((time.time() - max(1, days) * 86400) * 1000)
    try:
        con = _ro(CURSOR_TRACK_DB)
        try:
            rows = con.execute('select model, count(*) from ai_code_hashes where timestamp >= ? and model is not null '
                               'group by model order by 2 desc limit 3', (cutoff_ms,)).fetchall()
        finally:
            con.close()
    except sqlite3.Error:
        return []
    return [str(r[0]) for r in rows if r[0]]
