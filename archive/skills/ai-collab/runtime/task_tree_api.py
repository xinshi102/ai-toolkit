"""GET /api/tree payload + POST /api/tree/assign handler (console-contract §1).

All the real work lives here, in ``task_tree`` and in ``task_tree_legacy``;
board_api / board_routes only add one thin dispatch line each.  Cross-module
imports are done lazily inside functions to avoid import cycles with board_api.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import task_tree
import task_tree_legacy

_CACHE = {'at': 0.0, 'data': None}

# board_data.parse_round status -> console package status (run|ok|bad|warn)
_ROUND_STATUS = {
    'OK': 'ok', 'UNREVIEWED': 'ok', 'ACCEPTED': 'ok', 'SUPERSEDED': 'ok',
    'WARN': 'warn', 'NO_RECEIPT': 'warn', 'NO_REPLY': 'warn',
    'FAIL': 'bad', 'UNKNOWN': 'bad', 'RUNNING': 'run',
}
_STAGE_STATUS = {
    'done': 'done', 'ok': 'done', 'active': 'run', 'in_progress': 'run',
    'run': 'run', 'blocked': 'bad', 'bad': 'bad', 'warn': 'att',
    'pending': 'idle',
}


# --------------------------------------------------------------------------
# package collection (read-only)
# --------------------------------------------------------------------------
def _last_action(dir_path) -> str:
    """Reuse the board's existing recent-action reader (board_api.activity)."""
    try:
        import board_api
        acts = board_api.activity(dir_path, 1)
        return acts[0]['what'] if acts else ''
    except Exception:
        return ''


def _spec_of(dir_path) -> dict:
    for name in ('spec.json', 'request.json'):
        p = Path(dir_path) / name
        if p.exists():
            try:
                return json.loads(p.read_text(encoding='utf-8-sig'))
            except (ValueError, OSError):
                return {}
    return {}


def _round_status(status) -> str:
    return _ROUND_STATUS.get(str(status or '').upper(), 'run')


def collect_packages(roots=None) -> list:
    """One row per package from run roots + the append-only registry."""
    import board_data
    try:
        import package_registry
    except Exception:
        package_registry = None
    pairs = {}
    if roots is None:
        roots = [p for p in board_data.DEFAULT_ROOTS if Path(p).exists()]
    for d, root in board_data.collect_all(roots):
        pairs[str(d)] = (d, root)
    if package_registry is not None:
        for raw in package_registry.read_registered():
            d = Path(raw)
            if d.exists() and str(d) not in pairs:
                pairs[str(d)] = (d, d.parent)
    out = []
    for _key, (d, root) in pairs.items():
        try:
            r = board_data.parse_round(d, root)
        except Exception:
            continue
        pid = r.get('task_id') or r.get('name') or d.name
        spec = _spec_of(d)
        task_val = spec.get('task')
        task = task_val if isinstance(task_val, str) and task_val.strip() else None
        try:
            import board_api
            project = board_api._owner(r['dir'])[0]
        except Exception:
            project = ''
        out.append({
            'id': pid, 'dir': r['dir'],
            'status': _round_status(r.get('status')),
            'title': r.get('title') or pid,
            'updated_at': int(r.get('mtime') or 0),
            'mtime': float(r.get('mtime') or 0),
            'last_action': _last_action(r['dir']),
            'task': task, 'project': project,
            'agent': r.get('agent') or '',
        })
    return out


# --------------------------------------------------------------------------
# pure payload builder (testable with injected data)
# --------------------------------------------------------------------------
def _pkg_row(p) -> dict:
    return {'id': p['id'], 'status': p.get('status', 'run'),
            'title': p.get('title') or p['id'],
            'updated_at': int(p.get('updated_at') or 0),
            'last_action': p.get('last_action') or ''}


def _unassigned_row(p) -> dict:
    return {'id': p['id'], 'title': p.get('title') or p['id'],
            'updated_at': int(p.get('updated_at') or 0)}


def _executor(pkgs) -> str:
    counts = {}
    for p in pkgs:
        a = p.get('agent') or ''
        if a and a != '未知':
            counts[a] = counts.get(a, 0) + 1
    return max(counts, key=counts.get) if counts else ''


def _stage_status(s) -> str:
    return _STAGE_STATUS.get(str(s or '').lower(), 'idle')


def _stages(n, pkgs) -> list:
    ids = [p['id'] for p in sorted(pkgs, key=lambda x: x.get('updated_at') or 0)]
    raw = n.get('stages')
    if isinstance(raw, list) and raw:
        stages = [{'title': (s.get('title', '') if isinstance(s, dict) else str(s)),
                   'status': _stage_status(s.get('status') if isinstance(s, dict) else ''),
                   'packages': []} for s in raw]
        if ids:
            for i, pid in enumerate(ids):
                idx = min(len(stages) - 1, (i * len(stages)) // len(ids))
                stages[idx]['packages'].append(pid)
        return stages
    # No Plan Map: one stage holding the packages in time order.
    return [{'title': '执行',
             'status': task_tree.aggregate([p.get('status') for p in pkgs]) if pkgs else 'idle',
             'packages': ids}]


def _synthesize(nodes, key):
    """Make sure a referenced task key (and its ancestors) exists in-memory."""
    parts = task_tree.key_parts(key)
    for i in range(1, len(parts) + 1):
        k = '.'.join(parts[:i])
        if k not in nodes:
            nodes[k] = {'key': k, 'title': parts[i - 1],
                        'parent': '.'.join(parts[:i - 1]) or None,
                        'controller': '', 'modules': [], 'plan_map': '',
                        'state_md': '', 'created_at': 0, 'stages': None}


def build_tree(nodes, packages, package_task) -> dict:
    """nodes: {key: node}; packages: list; package_task: {id: key|None}.

    Pure: returns {'nodes': [...], 'unassigned': [...]} with status aggregated
    over child nodes + packages, progress [done, total], stages, last_action.
    """
    by_key = {k: dict(v) for k, v in nodes.items() if k}
    direct = {k: [] for k in by_key}
    unassigned = []
    for p in packages:
        key = package_task.get(p['id'])
        if key and key in by_key:
            direct[key].append(p)
        else:
            unassigned.append(_unassigned_row(p))
    children = {}
    for k, n in by_key.items():
        par = n.get('parent')
        if par and par in by_key and par != k:
            children.setdefault(par, []).append(k)
    memo, visiting = {}, set()

    def evaluate(k):
        if k in memo:
            return memo[k]
        if k in visiting:  # malformed stored parent cycle -> stop recursion
            memo[k] = {'status': 'idle', 'progress': [0, 0],
                       'updated_at': 0, 'subtree_pkgs': []}
            return memo[k]
        visiting.add(k)
        sub = list(direct[k])
        child_statuses = []
        for c in children.get(k, []):
            m = evaluate(c)
            child_statuses.append(m['status'])
            sub.extend(m['subtree_pkgs'])
        own_statuses = [p.get('status') for p in direct[k]]
        status = task_tree.aggregate(child_statuses + own_statuses)
        ok = sum(1 for p in sub if task_tree.category(p.get('status')) == 'done')
        updated = max([int(p.get('updated_at') or 0) for p in sub] or
                      [int(by_key[k].get('created_at') or 0), 0])
        memo[k] = {'status': status, 'progress': [ok, len(sub)],
                   'updated_at': updated, 'subtree_pkgs': sub}
        visiting.discard(k)
        return memo[k]

    for k in by_key:
        evaluate(k)
    out_nodes = []
    for k in sorted(by_key):
        n, m = by_key[k], memo[k]
        out_nodes.append({
            'key': k, 'title': n.get('title') or k, 'parent': n.get('parent'),
            'status': m['status'],
            'controller': n.get('controller') or '',
            'executor': _executor(direct[k]),
            'progress': m['progress'], 'updated_at': m['updated_at'],
            'modules': list(n.get('modules') or []),
            'stages': _stages(n, direct[k]),
            'packages': [_pkg_row(p) for p in sorted(direct[k],
                         key=lambda x: x.get('updated_at') or 0)],
        })
    return {'nodes': out_nodes,
            'unassigned': sorted(unassigned,
                                 key=lambda x: x.get('updated_at') or 0,
                                 reverse=True)}


# --------------------------------------------------------------------------
# wiring helpers used by board_api / board_routes
# --------------------------------------------------------------------------
def _merge_nodes(scanned, stored) -> dict:
    merged = {n['key']: dict(n) for n in scanned if n.get('key')}
    for n in stored or []:
        k = n.get('key')
        if not k:
            continue
        if k in merged:
            merged[k].update(n)  # explicit stored fields win
        else:
            merged[k] = dict(n)
    return merged


def _build(plan_root, projects_root, roots, packages) -> dict:
    plan_nodes = task_tree_legacy.parse_plan_maps(plan_root)
    state_nodes = task_tree_legacy.parse_states(projects_root, plan_nodes)
    scanned = plan_nodes + state_nodes
    nodes = _merge_nodes(scanned, task_tree.load_all())
    if packages is None:
        packages = collect_packages(roots)
    explicit = task_tree.assign_load()
    legacy_assign, _ = task_tree_legacy.match_packages(packages, scanned)
    package_task = {}
    for p in packages:
        pid = p['id']
        if explicit.get(pid):
            package_task[pid] = explicit[pid]
        elif p.get('task'):
            package_task[pid] = p['task']
        elif pid in legacy_assign:
            package_task[pid] = legacy_assign[pid]
        else:
            package_task[pid] = None
    for key in set(v for v in package_task.values() if v):
        _synthesize(nodes, key)
    return build_tree(nodes, packages, package_task)


def tree_payload(plan_root=None, projects_root=None, roots=None, packages=None) -> dict:
    """GET /api/tree.  Live calls (no injected data) use a short cache."""
    live = (packages is None and plan_root is None and
            projects_root is None and roots is None)
    if live:
        now = time.time()
        if _CACHE['data'] is not None and now - _CACHE['at'] < 10:
            return _CACHE['data']
        data = _build(None, None, None, None)
        _CACHE['data'], _CACHE['at'] = data, now
        return data
    return _build(plan_root, projects_root, roots, packages)


def assign(payload) -> dict:
    """POST /api/tree/assign -> {'ok': True}; writes task_assign.json."""
    package = str((payload or {}).get('package') or '').strip()
    task = str((payload or {}).get('task') or '').strip()
    if not package or not task:
        return {'ok': False, 'error': 'package and task are required'}
    task_tree.assign_set(package, task)
    return {'ok': True}
