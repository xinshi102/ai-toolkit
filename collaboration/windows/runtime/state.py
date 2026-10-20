"""Authoritative task state for gate snapshots.

The plan lives here, not in the controller's chat history. The executor updates
this file at phase boundaries; the gate injects only the slice relevant to the
current event.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_STATE = {
    'task_id': '',
    'phase': 'planning',
    'plan_version': 1,
    'plan_hash': '',
    'plan': '',
    'decisions': [],
    'progress': [],
    'deviations': [],
    'artifacts': [],
    'acceptance': {},
    'budget': {},
}


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def plan_hash(text: str) -> str:
    return hashlib.sha256((text or '').encode('utf-8')).hexdigest()


def new_state(task_id: str, plan: str = '', acceptance=None) -> dict:
    state = dict(DEFAULT_STATE)
    state.update({
        'task_id': str(task_id),
        'plan': plan or '',
        'plan_hash': plan_hash(plan or ''),
        'acceptance': acceptance or {},
    })
    return state


def load_state(path, task_id: str = '') -> dict:
    p = Path(path)
    if not p.exists():
        return new_state(task_id or p.stem)
    try:
        state = json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return new_state(task_id or p.stem)
    if not isinstance(state, dict):
        return new_state(task_id or p.stem)
    merged = dict(DEFAULT_STATE)
    merged.update(state)
    if task_id:
        merged['task_id'] = str(task_id)
    if not merged.get('plan_hash') and merged.get('plan'):
        merged['plan_hash'] = plan_hash(merged['plan'])
    return merged


def save_state(path, state: dict) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    state = dict(state or {})
    state.setdefault('task_id', p.stem)
    if state.get('plan') and not state.get('plan_hash'):
        state['plan_hash'] = plan_hash(state['plan'])
    payload = json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True)
    fd, tmp = tempfile.mkstemp(prefix=p.name + '.', suffix='.tmp', dir=str(p.parent))
    try:
        with open(fd, 'w', encoding='utf-8') as fh:
            fh.write(payload)
            fh.flush()
        Path(tmp).replace(p)
    finally:
        try:
            Path(tmp).unlink(missing_ok=True)
        except Exception:
            pass


def _trim(value, limit=160):
    text = str(value or '')
    return text if len(text) <= limit else text[:limit - 1] + '…'


def snapshot(state: dict, event: dict, max_chars: int = 4096) -> dict:
    """Minimal sufficient slice for one gate decision. Never the full transcript."""
    event = dict(event or {})
    payload = event.get('payload') or {}
    if isinstance(payload, dict):
        payload = {k: _trim(v, 300) for k, v in payload.items()
                   if k not in ('stdout', 'stderr', 'transcript', 'content')}
    else:
        payload = {'_value': _trim(payload, 300)}
    snap = {
        'task_id': state.get('task_id') or event.get('task_id') or '',
        'phase': state.get('phase', ''),
        'plan_version': state.get('plan_version', 1),
        'plan_hash': state.get('plan_hash', ''),
        'plan_excerpt': _trim(state.get('plan', ''), 600),
        'decisions': [_trim(x, 160) for x in (state.get('decisions') or [])[-5:]],
        'progress': [_trim(x, 120) for x in (state.get('progress') or [])[-5:]],
        'deviations': [_trim(x, 160) for x in (state.get('deviations') or [])[-5:]],
        'artifacts': [_trim(x, 160) for x in (state.get('artifacts') or [])[-5:]],
        'acceptance': state.get('acceptance') or {},
        'budget': state.get('budget') or {},
        'event': {
            'id': event.get('id'),
            'type': event.get('type', ''),
            'status': event.get('status', ''),
            'severity': event.get('severity', ''),
            'payload': payload,
        },
    }
    text = json.dumps(snap, ensure_ascii=False, sort_keys=True)
    if len(text) <= max_chars:
        return snap
    # Progressive trim, keeping the event and the plan identity intact.
    snap['plan_excerpt'] = _trim(snap['plan_excerpt'], 240)
    snap['decisions'] = snap['decisions'][-3:]
    snap['progress'] = snap['progress'][-3:]
    snap['deviations'] = snap['deviations'][-3:]
    snap['artifacts'] = snap['artifacts'][-3:]
    snap['event']['payload'] = {k: _trim(v, 120) for k, v in snap['event']['payload'].items()}
    text = json.dumps(snap, ensure_ascii=False, sort_keys=True)
    if len(text) <= max_chars:
        return snap
    snap['plan_excerpt'] = _trim(snap['plan_excerpt'], 120)
    snap['acceptance'] = {k: _trim(v, 120) for k, v in (snap['acceptance'] or {}).items()}
    return snap
