"""Scan workflow.json state written by the new supervision scheduler.

The old dashboard only understood run directories (stdout.ndjson + receipt).
The workflow runner keeps its state in `<project>/.work/<flow>/workflow.json`
and its gate ledger in `collab.sqlite`; those runs were invisible. This reader
turns each recent workflow.json into a compact card model.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
import os as _os
_WS = _os.environ.get('XINSHI_WORKSPACE', 'E:/AI-Workspace').replace('\\', '/').rstrip('/')

import task_groups
import remote_target
import dispatch_guard
import task_taxonomy

ROOTS = [
    Path(_WS + '/Projects/Shared/Agent-Conventions/outputs'),
    Path(_WS + '/Projects/Shared/Agent-Conventions/.work'),
]


def _first_line(text, limit=80):
    for line in str(text or '').splitlines():
        value = line.strip().lstrip('#').strip()
        if value:
            return value[:limit]
    return ''


def _node(node, limit=120):
    return {
        'id': node.get('id', ''),
        'owner': node.get('owner', ''),
        'provider': node.get('provider', ''),
        'status': node.get('status', ''),
        'task_id': node.get('task_id', ''),
        'reason': _first_line(node.get('reason'), 160),
        'intent': _first_line(node.get('prompt'), limit),
    }


def parse(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get('nodes'), list):
        return None
    nodes = [_node(n) for n in data['nodes']]
    sup = data.get('supervision') or {}
    runtime = data.get('_supervision') or {}
    gates = []
    for key, gate in (runtime.get('gates') or {}).items():
        if not isinstance(gate, dict):
            continue
        gates.append({
            'kind': gate.get('kind', ''),
            'status': gate.get('status', ''),
            'reason': _first_line(gate.get('reason'), 200),
        })
    accepted = sum(1 for n in nodes if n['status'] == 'accepted')
    failed = sum(1 for n in nodes if n['status'] == 'failed')
    running = sum(1 for n in nodes if n['status'] in ('running', 'queued', 'pending'))
    title = ''
    for node in nodes:
        title = node['intent']
        if title:
            break
    title = title or _first_line(sup.get('goal')) or data.get('id', path.parent.name)
    agents = []
    for node in nodes:
        name = node['owner'] or node['provider']
        if name and name not in agents:
            agents.append(name)
    return {
        'id': data.get('id', path.parent.name),
        'group': str(data.get('task_group') or '') or task_groups.group_for(data.get('id', path.parent.name)),
        'package': str(data.get('package') or '') or task_taxonomy.package_for(data.get('id', ''), data.get('task_group', '')),
        'package_title': task_taxonomy.title_for(str(data.get('package') or '') or task_taxonomy.package_for(data.get('id', ''), data.get('task_group', ''))),
        'subtask': str(data.get('subtask') or '') or str(data.get('id', '')),
        'remote': remote_target.extract(json.dumps(data, ensure_ascii=False)),
        'assigned': str(data.get('assigned_agent') or dispatch_guard.contract_for(data.get('id', '')).get('executor') or ''),
        'path': str(path),
        'dir': str(path.parent),
        'time': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(path.stat().st_mtime)),
        'mtime': path.stat().st_mtime,
        'revision': data.get('revision'),
        'status': data.get('status', ''),
        'title': title,
        'goal': _first_line(sup.get('goal'), 300),
        'agents': agents,
        'nodes': nodes,
        'accepted': accepted,
        'failed': failed,
        'running': running,
        'gates': gates,
        'gate_fail': sum(1 for g in gates if g['status'] == 'fail'),
        'calls': runtime.get('calls', 0),
        'final_ok': all(f.get('ok') for f in ((runtime.get('final_checks') or {}).get('findings') or []))
                    if (runtime.get('final_checks') or {}).get('findings') else None,
    }


def scan(roots=None, days=3) -> list[dict]:
    cutoff = time.time() - max(1, days) * 86400
    seen = set()
    out = []
    for root in (roots or ROOTS):
        root = Path(root)
        if not root.exists():
            continue
        for path in root.rglob('workflow.json'):
            try:
                if path.stat().st_mtime < cutoff:
                    continue
                key = str(path.resolve())
            except OSError:
                continue
            if key in seen:
                continue
            seen.add(key)
            item = parse(path)
            if item:
                out.append(item)
    out.sort(key=lambda x: x['mtime'], reverse=True)
    return out


if __name__ == '__main__':
    print(json.dumps(scan(), ensure_ascii=False, indent=2))
