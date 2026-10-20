"""Deterministic event gate for the xinshi collaboration runtime.

Flow:
  executor/runner -> events.emit(...)
  gate.run_once()  -> local rules decide wake/ignore (zero model)
  wake             -> one controller call with a <=4KB state slice
  verdict          -> gates table + consumed event

The gate is a structural checkpoint, not a monitoring loop. It never reads the
full transcript and never polls the model.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import time
from pathlib import Path

from events import list_events, mark_consumed, utcnow
from state import load_state, save_state, snapshot

SCHEMA = """
CREATE TABLE IF NOT EXISTS gates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_id INTEGER NOT NULL,
  gate_type TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gates_task ON gates(task_id, id);
"""

# event type -> gate type. Anything not listed and not ignored is ignored.
RULES = {
    'gate1_requested': 'gate1',
    'plan_locked': 'gate1',
    'deviation': 'gate1',
    'gate2_requested': 'gate2',
    'task_succeeded': 'gate2',
    'task_failed': 'gate2',
    'budget_exceeded': 'escalation',
    'blocked': 'escalation',
    'needs_decision': 'escalation',
}
IGNORE = {
    'task_started', 'progress', 'heartbeat', 'tool_call', 'tool_result',
    'artifact', 'log', 'usage',
}

PROMPTS = {
    'gate1': (
        'You are a gate, not the executor. Review only this snapshot before execution.\n'
        'Check: (1) the plan slice still matches the locked intent, (2) constraints or\n'
        'scope were not dropped in compression, (3) a cheaper/safer path exists.\n'
        'Return exactly:\nVERDICT: PASS|FAIL\nREASON: one short sentence\n'
        'If FAIL, add "FIX: ..." with the concrete missing item. Do not restate the plan.\n'
    ),
    'gate2': (
        'You are a gate, not the executor. Compare acceptance criteria with artifacts\n'
        'in this snapshot only. Do not read the transcript. Return exactly:\n'
        'VERDICT: PASS|FAIL\nREASON: one short sentence\n'
        'If FAIL, add "FIX: ..." with the concrete missing item.\n'
    ),
    'escalation': (
        'You are the controller. This event needs a decision: plan-external branch,\n'
        'irreversible action, repeated failure, or budget exhaustion. Use only this\n'
        'snapshot. Return exactly:\nVERDICT: PASS|FAIL\nREASON: one short sentence\n'
        'If FAIL, add "FIX: ..." with the next concrete action.\n'
    ),
}


def connect(db_path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA journal_mode=WAL')
    con.executescript(SCHEMA)
    return con


def record_gate(db_path, task_id: str, event_id: int, gate_type: str,
                verdict: str, reason: str, snap: dict) -> int:
    con = connect(db_path)
    try:
        cur = con.execute(
            'INSERT INTO gates(task_id,event_id,gate_type,verdict,reason,snapshot,created_at) '
            'VALUES(?,?,?,?,?,?,?)',
            (str(task_id), int(event_id), gate_type, verdict, reason,
             json.dumps(snap, ensure_ascii=False), utcnow()))
        con.commit()
        return int(cur.lastrowid)
    finally:
        con.close()


def list_gates(db_path, task_id: str | None = None, limit: int = 50) -> list[dict]:
    con = connect(db_path)
    try:
        sql = 'SELECT * FROM gates'
        args: list = []
        if task_id:
            sql += ' WHERE task_id=?'
            args.append(task_id)
        sql += ' ORDER BY id DESC LIMIT ?'
        args.append(max(1, min(int(limit), 500)))
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def decide(event: dict, last_wake: dict, cooldown: float = 60.0) -> tuple[bool, str, str]:
    """Return (wake, gate_type, reason) using only deterministic rules."""
    event_type = str(event.get('type') or '')
    severity = str(event.get('severity') or 'info')
    task_id = str(event.get('task_id') or '')
    if event_type in IGNORE:
        return False, '', 'ignored_type'
    if severity in ('error', 'critical'):
        return True, RULES.get(event_type, 'escalation'), 'severity'
    if event_type in RULES:
        key = f'{task_id}|{event_type}'
        previous = last_wake.get(key)
        now = time.monotonic()
        if previous is not None and now - previous < cooldown:
            return False, RULES[event_type], 'cooldown'
        return True, RULES[event_type], 'rule'
    payload = event.get('payload') or {}
    if isinstance(payload, dict):
        text = ' '.join(str(v) for v in payload.values()).lower()
        if any(word in text for word in ('error', 'failed', 'blocked', 'timeout')):
            return True, 'escalation', 'payload_keyword'
    return False, '', 'unmatched'


def safe_name(task_id: str) -> str:
    return re.sub(r'[^A-Za-z0-9_.-]+', '_', task_id or 'task')[:120]


def state_path_for(state_dir: Path, state_file: Path | None, task_id: str) -> Path:
    if state_file:
        return state_file
    return state_dir / f'{safe_name(task_id)}.json'


def build_prompt(gate_type: str, snap: dict) -> str:
    header = PROMPTS.get(gate_type, PROMPTS['escalation'])
    body = json.dumps(snap, ensure_ascii=False, indent=2, sort_keys=True)
    return header + '\nSNAPSHOT:\n' + body + '\n'


def parse_verdict(text: str) -> tuple[str, str]:
    if not text:
        return 'UNKNOWN', ''
    match = re.search(r'VERDICT:\s*(PASS|FAIL)', text, re.I)
    verdict = match.group(1).upper() if match else ('FAIL' if re.search(r'\bFAIL\b', text, re.I) else 'UNKNOWN')
    reason_match = re.search(r'REASON:\s*(.+)', text)
    reason = reason_match.group(1).strip() if reason_match else ''
    return verdict, reason[:500]


def wake(prompt: str, command: str, timeout: int = 300) -> tuple[str, str, str]:
    """One paid call. command is operator-controlled and receives the prompt on stdin."""
    proc = subprocess.run(command, input=prompt, capture_output=True, text=True,
                          encoding='utf-8', errors='replace', timeout=timeout,
                          shell=True,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    output = (proc.stdout or '') + '\n' + (proc.stderr or '')
    verdict, reason = parse_verdict(output)
    if proc.returncode != 0:
        return verdict if verdict != 'UNKNOWN' else 'FAIL', reason or f'wake exit {proc.returncode}', output
    return verdict, reason, output


def run_once(db_path, state_dir: Path = Path('.work/agent-state'),
             state_file: Path | None = None, wake_cmd: str = '',
             dry_run: bool = True, cooldown: float = 60.0,
             timeout: int = 300, limit: int = 50) -> list[dict]:
    events = list_events(db_path, unconsumed=True, limit=limit)
    last_wake: dict = {}
    state_dir = Path(state_dir)
    results = []
    for event in events:
        task_id = str(event.get('task_id') or '')
        should_wake, gate_type, rule_reason = decide(event, last_wake, cooldown)
        if not should_wake:
            mark_consumed(db_path, [event['id']])
            results.append({'event_id': event['id'], 'task_id': task_id,
                            'gate_type': gate_type, 'wake': False,
                            'reason': rule_reason})
            continue
        path = state_path_for(state_dir, state_file, task_id)
        st = load_state(path, task_id)
        snap = snapshot(st, event)
        prompt = build_prompt(gate_type, snap)
        if dry_run:
            verdict, reason, output = 'DRY_RUN', rule_reason, prompt
        else:
            verdict, reason, output = wake(prompt, wake_cmd, timeout)
        record_gate(db_path, task_id, event['id'], gate_type, verdict, reason, snap)
        mark_consumed(db_path, [event['id']])
        last_wake[f'{task_id}|{event.get("type")}'] = time.monotonic()
        results.append({'event_id': event['id'], 'task_id': task_id,
                        'gate_type': gate_type, 'wake': True, 'verdict': verdict,
                        'reason': reason, 'snapshot': snap,
                        'output': output[:1000]})
    return results


def _cli():
    ap = argparse.ArgumentParser(description='xinshi event gate')
    ap.add_argument('--db', default='.work/collab-events/collab.db')
    ap.add_argument('--state-dir', default='.work/agent-state')
    ap.add_argument('--state', default='')
    ap.add_argument('--wake-cmd', default='',
                    help='controller command; prompt on stdin, e.g. codex exec ... -')
    ap.add_argument('--dry-run', action='store_true',
                    help='build prompts and record DRY_RUN without calling the model')
    ap.add_argument('--cooldown', type=float, default=60.0)
    ap.add_argument('--timeout', type=int, default=300)
    ap.add_argument('--limit', type=int, default=50)
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--loop', action='store_true')
    ap.add_argument('--interval', type=float, default=5.0)
    ap.add_argument('--list-gates', action='store_true')
    args = ap.parse_args()

    if args.list_gates:
        print(json.dumps(list_gates(args.db, limit=args.limit), ensure_ascii=False, indent=2))
        return 0

    state_file = Path(args.state) if args.state else None
    dry = args.dry_run or not args.wake_cmd
    if args.loop:
        while True:
            results = run_once(args.db, Path(args.state_dir), state_file,
                               args.wake_cmd, dry, args.cooldown, args.timeout, args.limit)
            if results:
                print(json.dumps(results, ensure_ascii=False, indent=2))
            time.sleep(max(1.0, args.interval))
    results = run_once(args.db, Path(args.state_dir), state_file,
                       args.wake_cmd, dry, args.cooldown, args.timeout, args.limit)
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(_cli())
