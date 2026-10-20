"""Local event bus for the xinshi collaboration runtime.

SQLite-backed, append-only, zero-model. The gate reads these events and decides
whether the controller (GPT/Codex) needs to be woken; only that wake call is
paid. Everything here is deterministic and local.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  severity TEXT NOT NULL DEFAULT 'info',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_unconsumed ON events(consumed_at, id);
"""

MAX_PAYLOAD = 8192


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def connect(db_path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.executescript(SCHEMA)
    return con


def emit(db_path, task_id: str, event_type: str, status: str = '',
         severity: str = 'info', payload=None) -> int:
    """Append one event. Payload is a JSON object, capped at MAX_PAYLOAD bytes."""
    body = json.dumps(payload or {}, ensure_ascii=False, sort_keys=True)
    if len(body.encode('utf-8')) > MAX_PAYLOAD:
        body = json.dumps({'_truncated': True, 'bytes': len(body.encode('utf-8'))},
                          ensure_ascii=False)
    con = connect(db_path)
    try:
        cur = con.execute(
            'INSERT INTO events(task_id,type,status,severity,payload,created_at) '
            'VALUES(?,?,?,?,?,?)',
            (str(task_id), str(event_type), str(status or ''), str(severity or 'info'),
             body, utcnow()))
        con.commit()
        return int(cur.lastrowid)
    finally:
        con.close()


def list_events(db_path, since_id: int = 0, task_id: str | None = None,
                limit: int = 100, unconsumed: bool = False) -> list[dict]:
    con = connect(db_path)
    try:
        sql = 'SELECT * FROM events WHERE id > ?'
        args: list = [int(since_id)]
        if task_id:
            sql += ' AND task_id = ?'
            args.append(task_id)
        if unconsumed:
            sql += ' AND consumed_at IS NULL'
        sql += ' ORDER BY id ASC LIMIT ?'
        args.append(max(1, min(int(limit), 1000)))
        rows = con.execute(sql, args).fetchall()
        out = []
        for row in rows:
            item = dict(row)
            try:
                item['payload'] = json.loads(item.get('payload') or '{}')
            except Exception:
                item['payload'] = {'_raw': item.get('payload')}
            out.append(item)
        return out
    finally:
        con.close()


def mark_consumed(db_path, ids) -> int:
    ids = [int(i) for i in ids]
    if not ids:
        return 0
    con = connect(db_path)
    try:
        marks = ','.join('?' for _ in ids)
        cur = con.execute(
            f'UPDATE events SET consumed_at = ? WHERE id IN ({marks}) AND consumed_at IS NULL',
            [utcnow(), *ids])
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def wait(db_path, since_id: int = 0, timeout: float = 30.0,
         interval: float = 1.0, task_id: str | None = None) -> list[dict]:
    """Block cheaply (SQLite poll) until at least one new event or timeout."""
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        events = list_events(db_path, since_id, task_id=task_id, limit=100)
        if events:
            return events
        if time.monotonic() >= deadline:
            return []
        time.sleep(max(0.2, interval))


def _cli():
    ap = argparse.ArgumentParser(description='xinshi local event bus')
    ap.add_argument('--db', default='.work/collab-events/collab.db')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p_emit = sub.add_parser('emit')
    p_emit.add_argument('--task', required=True)
    p_emit.add_argument('--type', required=True, dest='event_type')
    p_emit.add_argument('--status', default='')
    p_emit.add_argument('--severity', default='info')
    p_emit.add_argument('--payload', default='{}')

    p_list = sub.add_parser('list')
    p_list.add_argument('--since', type=int, default=0)
    p_list.add_argument('--task', default='')
    p_list.add_argument('--limit', type=int, default=100)
    p_list.add_argument('--unconsumed', action='store_true')

    p_wait = sub.add_parser('wait')
    p_wait.add_argument('--since', type=int, default=0)
    p_wait.add_argument('--timeout', type=float, default=30.0)
    p_wait.add_argument('--interval', type=float, default=1.0)
    p_wait.add_argument('--task', default='')

    p_mark = sub.add_parser('consume')
    p_mark.add_argument('ids', nargs='+', type=int)

    args = ap.parse_args()
    if args.cmd == 'emit':
        try:
            payload = json.loads(args.payload)
        except Exception:
            raise SystemExit('payload must be JSON object')
        if not isinstance(payload, dict):
            raise SystemExit('payload must be JSON object')
        print(emit(args.db, args.task, args.event_type, args.status, args.severity, payload))
    elif args.cmd == 'list':
        print(json.dumps(list_events(args.db, args.since, args.task or None,
                                     args.limit, args.unconsumed),
                         ensure_ascii=False, indent=2))
    elif args.cmd == 'wait':
        print(json.dumps(wait(args.db, args.since, args.timeout, args.interval,
                              args.task or None), ensure_ascii=False, indent=2))
    elif args.cmd == 'consume':
        print(mark_consumed(args.db, args.ids))
    return 0


if __name__ == '__main__':
    raise SystemExit(_cli())
