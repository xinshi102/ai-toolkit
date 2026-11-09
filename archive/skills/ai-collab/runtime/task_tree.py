"""Task identity nodes for the board tree (standard library only).

A node is one JSON file in ``~/.ai-collab/tasks/<key>.json`` (override the
root with ``AI_COLLAB_DATA``).  Keys use dot notation (``xinshi.planmap``);
``parent`` is the dotted prefix, or ``None`` for a top-level node.

This module owns only the node store, key hierarchy, status aggregation and
the package->task assignment file.  Building the API payload and scanning old
data live in ``task_tree_api`` / ``task_tree_legacy``.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path

FIELDS = ('key', 'title', 'parent', 'controller', 'modules',
          'plan_map', 'state_md', 'created_at')

# node/package status -> aggregation category.  Only "bad > att > run > done"
# matters; everything else is idle (see aggregate()).
_CATEGORY = {
    'bad': 'bad', 'att': 'att', 'run': 'run', 'done': 'done', 'idle': 'idle',
    'ok': 'done', 'warn': 'att', 'fail': 'bad', 'error': 'bad',
    'blocked': 'bad', 'active': 'run', 'pending': 'idle',
}


def data_dir() -> Path:
    return Path(os.environ.get('AI_COLLAB_DATA') or (Path.home() / '.ai-collab'))


def tasks_dir(base=None) -> Path:
    return (Path(base) if base else data_dir()) / 'tasks'


def assign_path(base=None) -> Path:
    return (Path(base) if base else data_dir()) / 'task_assign.json'


# --------------------------------------------------------------------------
# key hierarchy
# --------------------------------------------------------------------------
def key_parts(key) -> list:
    """'a.b.c' -> ['a','b','c']; empty/blank keys give []."""
    return [p for p in str(key or '').split('.') if p]


def parent_key(key):
    """Immediate dotted parent, or None for a top-level / empty key."""
    parts = key_parts(key)
    return '.'.join(parts[:-1]) if len(parts) > 1 else None


def child_key(parent, leaf) -> str:
    return '.'.join([p for p in (str(parent or ''), str(leaf or '')) if p])


def is_top(key) -> bool:
    return parent_key(key) is None


# --------------------------------------------------------------------------
# status aggregation (console-contract.md §1)
# --------------------------------------------------------------------------
def category(status) -> str:
    return _CATEGORY.get(str(status or '').strip().lower(), 'idle')


def aggregate(statuses) -> str:
    """bad > att > run > all-done > idle, over child nodes and packages."""
    cats = [category(s) for s in (statuses or [])]
    if not cats:
        return 'idle'
    if 'bad' in cats:
        return 'bad'
    if 'att' in cats:
        return 'att'
    if 'run' in cats:
        return 'run'
    if all(c == 'done' for c in cats):
        return 'done'
    return 'idle'


# --------------------------------------------------------------------------
# node files
# --------------------------------------------------------------------------
def node_path(key, base=None) -> Path:
    return tasks_dir(base) / (str(key) + '.json')


def _save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp',
                               dir=str(path.parent))
    with open(fd, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
    Path(tmp).replace(path)


def load(key, base=None):
    p = node_path(key, base)
    if not p.exists():
        return None
    try:
        obj = json.loads(p.read_text(encoding='utf-8'))
        return obj if isinstance(obj, dict) else None
    except (ValueError, OSError):
        return None


def save(node, base=None):
    _save_json(node_path(node['key'], base), node)
    return node


def load_all(base=None) -> list:
    d = tasks_dir(base)
    out = []
    if not d.exists():
        return out
    for p in sorted(d.glob('*.json')):
        try:
            obj = json.loads(p.read_text(encoding='utf-8'))
        except (ValueError, OSError):
            continue
        if isinstance(obj, dict) and obj.get('key'):
            out.append(obj)
    return out


def ensure(key, title=None, base=None, **fields):
    """Return the node for ``key``, creating it if missing.

    A child may be created only when its immediate parent node already exists;
    otherwise ValueError.  Top-level keys (no dot) have no parent requirement.
    Extra keyword fields are stored on newly created nodes.
    """
    key = str(key or '').strip()
    if not key:
        raise ValueError('task key is empty')
    existing = load(key, base)
    if existing is not None:
        return existing
    pk = parent_key(key)
    if pk is not None and load(pk, base) is None:
        raise ValueError('parent task node %r does not exist' % pk)
    node = {
        'key': key,
        'title': title or (key_parts(key)[-1] if key_parts(key) else key),
        'parent': pk,
        'controller': fields.get('controller') or '',
        'modules': list(fields.get('modules') or []),
        'plan_map': fields.get('plan_map') or '',
        'state_md': fields.get('state_md') or '',
        'created_at': int(fields.get('created_at') or time.time()),
    }
    for k, v in fields.items():
        if k not in node:
            node[k] = v
    return save(node, base)


# --------------------------------------------------------------------------
# package -> task assignment (POST /api/tree/assign)
# --------------------------------------------------------------------------
def assign_load(path=None, base=None) -> dict:
    p = Path(path) if path else assign_path(base)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (ValueError, OSError):
        return {}


def assign_set(package_id, task_key, path=None, base=None) -> dict:
    """Claim a package under a task key; returns the full mapping."""
    data = assign_load(path=path, base=base)
    data[str(package_id)] = str(task_key) if task_key else None
    _save_json(Path(path) if path else assign_path(base), data)
    return data


def for_package(package_dir, base=None) -> dict:
    """Task identity for a package dir: assign override > spec.task. Returns {} when unknown (inbox falls back)."""
    import json as _json
    p = Path(package_dir)
    key = ''
    try:
        key = (assign_load(base=base) or {}).get(p.name, '') or ''
    except Exception:
        key = ''
    if not key:
        try:
            spec = _json.loads((p / 'spec.json').read_text(encoding='utf-8'))
            key = spec.get('task') if isinstance(spec.get('task'), str) else ''
        except Exception:
            key = ''
    if not key:
        return {}
    node = None
    try:
        node = load(key, base=base)
    except Exception:
        node = None
    parent = parent_key(key)
    pnode = None
    if parent:
        try:
            pnode = load(parent, base=base)
        except Exception:
            pnode = None
    return {'task': key,
            'task_title': (node or {}).get('title') or key_parts(key)[-1],
            'parent_title': ((pnode or {}).get('title') or (key_parts(parent)[-1] if parent else ''))}
