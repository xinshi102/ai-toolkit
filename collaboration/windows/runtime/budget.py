"""Per-task token / time / poll budget with a hard circuit breaker.

The controller's paid calls and the executor's status polls both charge here.
When a limit is crossed the task is marked blocked and one budget_exceeded
event is emitted; the gate then escalates once.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from events import emit, utcnow

SCHEMA = """
CREATE TABLE IF NOT EXISTS budgets (
  task_id TEXT PRIMARY KEY,
  token_limit INTEGER NOT NULL,
  time_limit INTEGER NOT NULL,
  poll_limit INTEGER NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  polls INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  updated_at TEXT NOT NULL
);
"""

DEFAULTS = {'token_limit': 200000, 'time_limit': 1800, 'poll_limit': 120}


def connect(db_path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.executescript(SCHEMA)
    return con


def _row_to_dict(row) -> dict:
    return dict(row) if row else {}


def start(db_path, task_id: str, token_limit: int = DEFAULTS['token_limit'],
          time_limit: int = DEFAULTS['time_limit'],
          poll_limit: int = DEFAULTS['poll_limit']) -> dict:
    con = connect(db_path)
    try:
        con.execute(
            'INSERT INTO budgets(task_id,token_limit,time_limit,poll_limit,tokens_used,'
            'polls,started_at,status,updated_at) VALUES(?,?,?,?,0,0,?,?,?) '
            'ON CONFLICT(task_id) DO UPDATE SET token_limit=excluded.token_limit, '
            'time_limit=excluded.time_limit, poll_limit=excluded.poll_limit, '
            'tokens_used=0, polls=0, started_at=excluded.started_at, '
            'status=excluded.status, updated_at=excluded.updated_at',
            (str(task_id), int(token_limit), int(time_limit), int(poll_limit),
             utcnow(), 'running', utcnow()))
        con.commit()
        return status(db_path, task_id)
    finally:
        con.close()


def _ensure(db_path, task_id: str) -> None:
    con = connect(db_path)
    try:
        row = con.execute('SELECT 1 FROM budgets WHERE task_id=?', (str(task_id),)).fetchone()
        if not row:
            con.execute(
                'INSERT INTO budgets(task_id,token_limit,time_limit,poll_limit,tokens_used,'
                'polls,started_at,status,updated_at) VALUES(?,?,?,?,0,0,?,?,?)',
                (str(task_id), DEFAULTS['token_limit'], DEFAULTS['time_limit'],
                 DEFAULTS['poll_limit'], utcnow(), 'running', utcnow()))
            con.commit()
    finally:
        con.close()


def _elapsed(started_at: str) -> int:
    try:
        started = datetime.fromisoformat(started_at.replace('Z', '+00:00'))
        return max(0, int((datetime.now(timezone.utc) - started).total_seconds()))
    except Exception:
        return 0


def check(db_path, task_id: str) -> dict:
    con = connect(db_path)
    try:
        row = con.execute('SELECT * FROM budgets WHERE task_id=?', (str(task_id),)).fetchone()
    finally:
        con.close()
    if not row:
        return {'task_id': task_id, 'exists': False, 'ok': True, 'exceeded': [], 'status': 'missing'}
    item = _row_to_dict(row)
    elapsed = _elapsed(item['started_at'])
    exceeded = []
    if item['tokens_used'] > item['token_limit']:
        exceeded.append('tokens')
    if elapsed > item['time_limit']:
        exceeded.append('time')
    if item['polls'] > item['poll_limit']:
        exceeded.append('polls')
    ok = not exceeded
    status = item['status']
    if not ok and status != 'blocked':
        con = connect(db_path)
        try:
            con.execute('UPDATE budgets SET status=?, updated_at=? WHERE task_id=?',
                        ('blocked', utcnow(), str(task_id)))
            con.commit()
        finally:
            con.close()
        emit(db_path, task_id, 'budget_exceeded', status='blocked', severity='critical',
             payload={'exceeded': exceeded, 'tokens_used': item['tokens_used'],
                      'token_limit': item['token_limit'], 'polls': item['polls'],
                      'poll_limit': item['poll_limit'], 'elapsed': elapsed,
                      'time_limit': item['time_limit']})
        status = 'blocked'
    return {
        'task_id': task_id, 'exists': True, 'ok': ok, 'exceeded': exceeded,
        'status': status, 'tokens_used': item['tokens_used'],
        'token_limit': item['token_limit'], 'polls': item['polls'],
        'poll_limit': item['poll_limit'], 'elapsed': elapsed,
        'time_limit': item['time_limit'],
    }


def charge(db_path, task_id: str, tokens: int = 0) -> dict:
    _ensure(db_path, task_id)
    con = connect(db_path)
    try:
        con.execute('UPDATE budgets SET tokens_used = tokens_used + ?, updated_at=? '
                    'WHERE task_id=?', (max(0, int(tokens)), utcnow(), str(task_id)))
        con.commit()
    finally:
        con.close()
    return check(db_path, task_id)


def poll(db_path, task_id: str) -> dict:
    _ensure(db_path, task_id)
    con = connect(db_path)
    try:
        con.execute('UPDATE budgets SET polls = polls + 1, updated_at=? WHERE task_id=?',
                    (utcnow(), str(task_id)))
        con.commit()
    finally:
        con.close()
    return check(db_path, task_id)


def status(db_path, task_id: str) -> dict:
    return check(db_path, task_id)


def _cli():
    ap = argparse.ArgumentParser(description='xinshi per-task budget')
    ap.add_argument('--db', default='.work/collab-events/collab.db')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p_start = sub.add_parser('start')
    p_start.add_argument('--task', required=True)
    p_start.add_argument('--tokens', type=int, default=DEFAULTS['token_limit'])
    p_start.add_argument('--seconds', type=int, default=DEFAULTS['time_limit'])
    p_start.add_argument('--polls', type=int, default=DEFAULTS['poll_limit'])

    p_charge = sub.add_parser('charge')
    p_charge.add_argument('--task', required=True)
    p_charge.add_argument('--tokens', type=int, required=True)

    p_poll = sub.add_parser('poll')
    p_poll.add_argument('--task', required=True)

    p_status = sub.add_parser('status')
    p_status.add_argument('--task', required=True)

    args = ap.parse_args()
    if args.cmd == 'start':
        out = start(args.db, args.task, args.tokens, args.seconds, args.polls)
    elif args.cmd == 'charge':
        out = charge(args.db, args.task, args.tokens)
    elif args.cmd == 'poll':
        out = poll(args.db, args.task)
    else:
        out = status(args.db, args.task)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0 if out.get('ok', True) else 3


if __name__ == '__main__':
    raise SystemExit(_cli())
