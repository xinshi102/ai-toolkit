"""挂起零消耗：ask / later 记录到 ~/.ai-collab/asks.jsonl，进程正常退出。

目录可用 AI_COLLAB_DATA 覆盖。status=ask 时写挂起记录，之后进程直接退出、
不保留任何后台进程、不占 token；用户回答由 ask.py 在原会话里生成续做 spec。

asks.jsonl 只追加：answer 写成一条 type=answer 的记录（answer_of 指向挂起
记录），list_asks() 把还没有对应 answer 的 ask/later 当作挂起项返回。
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

_LOCK = threading.Lock()


def data_dir() -> Path:
    return Path(os.environ.get('AI_COLLAB_DATA') or (Path.home() / '.ai-collab'))


def asks_path() -> Path:
    return data_dir() / 'asks.jsonl'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def _append(record, path=None):
    path = Path(path) if path is not None else asks_path()
    with _LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + '\n')
            fh.flush()
    return record


def read_all(path=None) -> list:
    path = Path(path) if path is not None else asks_path()
    if not path.exists():
        return []
    out = []
    with path.open('r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict):
                out.append(obj)
    return out


def record_ask(block, package_dir, session_id, task_id='', path=None) -> dict:
    """status=ask 的挂起记录：ask_id、包目录、会话 id、问题、选项、时间。"""
    questions = block.get('ask') or []
    if not isinstance(questions, list):
        questions = []
    options = [q.get('options') for q in questions if isinstance(q, dict)]
    ask_id = 'ask-' + uuid.uuid4().hex[:12]
    return _append({
        'id': ask_id, 'ask_id': ask_id, 'type': 'ask', 'ts': _now(),
        'status': 'pending',
        'package_dir': str(package_dir), 'session_id': str(session_id or ''),
        'task_id': str(task_id or ''),
        'questions': questions, 'options': options,
        'evidence': block.get('evidence') or [], 'next': block.get('next') or '',
    }, path)


def record_later(block, package_dir, session_id, task_id='', path=None) -> dict:
    """later 预约复查：只记录，不实现定时器（定时归事件触发层，以后做）。"""
    later_id = 'later-' + uuid.uuid4().hex[:12]
    return _append({
        'id': later_id, 'ask_id': later_id, 'type': 'later', 'ts': _now(),
        'status': 'pending',
        'package_dir': str(package_dir), 'session_id': str(session_id or ''),
        'task_id': str(task_id or ''),
        'later': block.get('later') or {},
        'evidence': block.get('evidence') or [], 'next': block.get('next') or '',
    }, path)


def record_answer(ask_id, choice, spec_path='', path=None) -> dict:
    return _append({
        'id': 'answer-' + uuid.uuid4().hex[:12], 'type': 'answer', 'ts': _now(),
        'answer_of': str(ask_id), 'choice': str(choice), 'spec_path': str(spec_path),
    }, path)


def list_asks(path=None) -> list:
    """挂起列表：ask/later 记录里还没有对应 answer 的。"""
    records = read_all(path)
    answered = {r.get('answer_of') for r in records if r.get('type') == 'answer'}
    return [r for r in records
            if r.get('type') in ('ask', 'later') and r.get('id') not in answered]


def find(ask_id, path=None):
    for r in read_all(path):
        if r.get('id') == str(ask_id) and r.get('type') in ('ask', 'later'):
            return r
    return None
