"""Task-level progress for the collab board: Plan Map plans + project STATE.md + journal notes.

Read-only. Plan Map data: E:/AI-Workspace/Data/Plan-Map/Codex/*.json (state.nodes/order).
Project state: <project>/.work/<task>/STATE.md with '## 当前任务 / ## 下一步 / ## 挂起项'.
Decision requests: lines starting with '【需要你决定】' in STATE.md or journal notes (xinshi 3.1.3 format).
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
import os as _os
_WS = _os.environ.get('XINSHI_WORKSPACE', 'E:/AI-Workspace').replace('\\', '/').rstrip('/')

PLAN_ROOT = Path(_WS + '/Data/Plan-Map/Codex')
PROJECTS = Path(_WS + '/Projects')
STATE_GLOBS = ['*/*/.work/*/STATE.md', '*/.work/*/STATE.md']
ACTIVE_DAYS = 7


def _section(text: str, name: str) -> list:
    m = re.search(r'^##\s*' + re.escape(name) + r'\s*$(.*?)(?=^##\s|\Z)', text, re.M | re.S)
    if not m:
        return []
    return [ln.strip().lstrip('-').strip() for ln in m.group(1).splitlines() if ln.strip()]


def _decisions(text: str, source: str) -> list:
    out = []
    for m in re.finditer(r'【需要你决定】([^\n]*)((?:\n(?!\s*\n)[^\n]*){0,8})', text):
        body = (m.group(1) + m.group(2)).strip()
        if re.search(r'已决定|已回复|resolved', body, re.I):
            continue
        out.append({'title': m.group(1).strip()[:120], 'body': body[:800], 'source': source})
    return out


def plans(days: int = ACTIVE_DAYS) -> list:
    out = []
    if not PLAN_ROOT.exists():
        return out
    cutoff = time.time() - days * 86400
    for p in PLAN_ROOT.glob('*.json'):
        try:
            if p.stat().st_mtime < cutoff:
                continue
            data = json.loads(p.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        st = data.get('state') or {}
        nodes = st.get('nodes') or {}
        order = st.get('order') or list(nodes)
        children = {}
        for nid in order:
            n = nodes.get(nid)
            if n:
                children.setdefault(n.get('parent') or '', []).append(n)
        roots = children.get('', [])
        if len(roots) == 1 and children.get(roots[0]['id']):
            stages = children[roots[0]['id']]
        else:
            stages = roots
        leaves = [n for n in nodes.values() if n['id'] not in children]
        done = sum(1 for n in leaves if n.get('status') == 'done')
        stage_rows = []
        for s in stages:
            sub = [n for n in nodes.values() if n.get('parent') == s['id']]
            stage_rows.append({'title': s.get('title', ''), 'status': s.get('status', 'pending'),
                               'note': (s.get('note') or '')[:160],
                               'done': sum(1 for n in sub if n.get('status') == 'done'), 'total': len(sub)})
        active = [n for n in nodes.values() if n.get('status') == 'active' and n['id'] not in children]
        blocked = [n for n in nodes.values() if n.get('status') == 'blocked']
        out.append({'id': data.get('planId') or p.stem, 'title': data.get('title') or p.stem,
                    'updated': time.strftime('%Y-%m-%d %H:%M', time.localtime(p.stat().st_mtime)),
                    'mtime': p.stat().st_mtime, 'done': done, 'total': len(leaves),
                    'stages': stage_rows,
                    'current': [{'title': n.get('title', ''), 'note': (n.get('note') or '')[:200]} for n in active[:3]],
                    'blocked': [{'title': n.get('title', ''), 'note': (n.get('note') or '')[:200]} for n in blocked[:3]]})
    out.sort(key=lambda x: x['mtime'], reverse=True)
    return out


def states(days: int = ACTIVE_DAYS) -> list:
    out = []
    cutoff = time.time() - days * 86400
    seen = set()
    for pattern in STATE_GLOBS:
        for p in PROJECTS.glob(pattern):
            if p in seen or 'archive' in p.parts or 'Shared' in p.parts:
                continue
            seen.add(p)
            try:
                if p.stat().st_mtime < cutoff:
                    continue
                text = p.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            task_dir = p.parent
            journal = task_dir / 'journal'
            notes = []
            decisions = _decisions(text, str(p))
            if journal.exists():
                for j in sorted(journal.glob('*.md'), key=lambda x: x.stat().st_mtime, reverse=True):
                    notes.append({'name': j.stem, 'path': str(j),
                                  'time': time.strftime('%m-%d %H:%M', time.localtime(j.stat().st_mtime))})
                    if len(decisions) < 5:
                        decisions += _decisions(j.read_text(encoding='utf-8', errors='replace'), str(j))
            title = (text.splitlines() or [''])[0].lstrip('#').strip()
            out.append({'path': str(p), 'project': task_dir.parent.parent.name, 'task': task_dir.name,
                        'title': title[:80], 'mtime': p.stat().st_mtime,
                        'updated': time.strftime('%Y-%m-%d %H:%M', time.localtime(p.stat().st_mtime)),
                        'current': _section(text, '当前任务')[:3], 'next': _section(text, '下一步')[:3],
                        'pending': _section(text, '挂起项')[:3], 'journal': notes[:12], 'decisions': decisions})
    out.sort(key=lambda x: x['mtime'], reverse=True)
    return out


def scan() -> dict:
    return {'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'plans': plans(), 'states': states()}
