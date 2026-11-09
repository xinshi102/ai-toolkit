"""Best-effort mapping of the *old* data into task-tree nodes (read-only).

Sources (never written to):
  * Plan Map JSON  ``$AI_COLLAB_PLANMAP/**/*.json``  -> one top-level
    node each; its ``state.nodes``/``state.order`` become the node's stages.
  * Project STATE.md under ``$AI_COLLAB_PROJECTS``            -> one node
    each, hung below a Plan Map when the plan can be identified, otherwise a
    top-level node.
  * Existing packages -> matched to a node by "project directory + time";
    ambiguous / uncertain matches are reported as ``unassigned``.

All roots are overridable so tests can fabricate data in a temp directory.
"""
from __future__ import annotations

import json
import re
import time
import os
from pathlib import Path

import task_tree

PLAN_MAP_ROOT = Path(os.environ.get('AI_COLLAB_PLANMAP') or Path.home() / '.ai-collab' / 'plan-map')
PROJECTS_ROOT = Path(os.environ.get('AI_COLLAB_PROJECTS') or Path.home())
STATE_GLOBS = ['*/*/.work/*/STATE.md', '*/.work/*/STATE.md']
TIME_WINDOW = 14 * 86400  # seconds; a package this far from a node is uncertain


def _norm(text) -> str:
    return re.sub(r'[^\w]+', '-', str(text or '').lower()).strip('-')


def slug(text) -> str:
    return _norm(text) or 'task'


def _unique(key, seen) -> str:
    if key not in seen:
        seen.add(key)
        return key
    i = 2
    while '%s-%d' % (key, i) in seen:
        i += 1
    out = '%s-%d' % (key, i)
    seen.add(out)
    return out


# --------------------------------------------------------------------------
# Plan Map -> top-level nodes (+ stages)
# --------------------------------------------------------------------------
def parse_plan_maps(plan_root=None) -> list:
    root = Path(plan_root) if plan_root else PLAN_MAP_ROOT
    out, seen = [], set()
    if not root.exists():
        return out
    for p in sorted(root.rglob('*.json')):
        try:
            data = json.loads(p.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        st = data.get('state') or {}
        nodes = st.get('nodes') or {}
        order = st.get('order') or list(nodes)
        children = {}
        for nid in order:
            n = nodes.get(nid) if isinstance(nodes, dict) else None
            if isinstance(n, dict):
                children.setdefault(n.get('parent') or '', []).append(n)
        roots = children.get('', [])
        if len(roots) == 1 and children.get(roots[0].get('id')):
            stages = children[roots[0].get('id')]
        else:
            stages = roots
        stage_rows = [{'title': s.get('title', ''), 'status': s.get('status', 'pending')}
                      for s in stages if isinstance(s, dict)]
        plan_id = str(data.get('planId') or p.stem)
        title = str(data.get('title') or p.stem)
        key = _unique(slug(plan_id or title), seen)
        mtime = p.stat().st_mtime
        out.append({
            'key': key, 'title': title, 'parent': None,
            'controller': _controller(p), 'modules': [slug(plan_id)],
            'plan_map': plan_id, 'state_md': '', 'created_at': int(mtime),
            'stages': stage_rows, 'project': '', 'mtime': mtime, 'file': str(p),
            '_tokens': [slug(plan_id), slug(title)],
        })
    return out


def _controller(path: Path) -> str:
    """Rough guess: a Plan Map kept under a host folder belongs to that host."""
    try:
        from board_api import CONTROLLER
    except Exception:
        return ''
    return CONTROLLER.get(path.parent.name.lower(), '')


# --------------------------------------------------------------------------
# STATE.md -> nodes (children of a plan when identifiable)
# --------------------------------------------------------------------------
def _match_plan(haystack, plan_nodes):
    h = _norm(haystack)
    best, best_len = None, 0
    for pn in plan_nodes or []:
        for token in pn.get('_tokens') or []:
            if len(token) >= 3 and token in h and len(token) > best_len:
                best, best_len = pn, len(token)
    return best


def parse_states(projects_root=None, plan_nodes=None) -> list:
    root = Path(projects_root) if projects_root else PROJECTS_ROOT
    plan_nodes = plan_nodes if plan_nodes is not None else []
    out, seen, seen_paths = [], set(), set()
    if not root.exists():
        return out
    for pattern in STATE_GLOBS:
        for p in sorted(root.glob(pattern)):
            if p in seen_paths or 'archive' in p.parts or 'Shared' in p.parts:
                continue
            seen_paths.add(p)
            try:
                text = p.read_text(encoding='utf-8', errors='replace')
                mtime = p.stat().st_mtime
            except OSError:
                continue
            task_dir = p.parent
            project = task_dir.parent.parent.name
            task = task_dir.name
            title = (text.splitlines() or [''])[0].lstrip('#').strip() or task
            plan = _match_plan(' '.join([title, project, task, text[:500]]), plan_nodes)
            if plan is not None:
                key = _unique(task_tree.child_key(plan['key'], slug(task)), seen)
                parent = plan['key']
                plan_map = plan.get('plan_map', '')
            else:
                key = _unique(slug(project) + '-' + slug(task), seen)
                parent = None
                plan_map = ''
            out.append({
                'key': key, 'title': title, 'parent': parent,
                'controller': _state_controller(p), 'modules': [],
                'plan_map': plan_map, 'state_md': str(p), 'created_at': int(mtime),
                'stages': [], 'project': project, 'mtime': mtime, 'file': str(p),
            })
    return out


def _state_controller(path: Path) -> str:
    try:
        from board_api import _owner
        return _owner(str(path))[1]
    except Exception:
        return ''


# --------------------------------------------------------------------------
# packages -> nodes by "project directory + time"
# --------------------------------------------------------------------------
def match_packages(packages, nodes):
    """-> (assignments {id: key}, unassigned [id]).  A package is assigned only
    when exactly one project-matching node is closest in time and within the
    window; ties / no match / no project are left unassigned."""
    candidates = [n for n in (nodes or []) if n.get('project')]
    assignments, unassigned = {}, []
    for p in packages or []:
        pid = p.get('id')
        proj = _norm(p.get('project') or '')
        mtime = float(p.get('mtime') or p.get('updated_at') or 0)
        if not proj:
            unassigned.append(pid)
            continue
        matches = [n for n in candidates if _norm(n.get('project') or '') == proj]
        if not matches:
            unassigned.append(pid)
            continue
        scored = sorted((abs(float(n.get('mtime') or 0) - mtime), n['key'])
                        for n in matches)
        best_gap, best_key = scored[0]
        if best_gap > TIME_WINDOW or (len(scored) > 1 and scored[1][0] == best_gap):
            unassigned.append(pid)
            continue
        assignments[pid] = best_key
    return assignments, unassigned


# --------------------------------------------------------------------------
# optional one-shot persistence of the mapping (idempotent)
# --------------------------------------------------------------------------
def _record(n) -> dict:
    return {k: v for k, v in n.items()
            if not k.startswith('_') and k not in ('file', 'stages')}


def seed(plan_root=None, projects_root=None, packages=None, base=None) -> dict:
    """Persist scanned nodes (skip existing) and write package claims.

    Idempotent: never overwrites an existing node file.  Purely optional -- the
    live API builds its payload from these scans read-only without seeding.
    """
    plan_nodes = parse_plan_maps(plan_root)
    state_nodes = parse_states(projects_root, plan_nodes)
    nodes = plan_nodes + state_nodes
    created = []
    for n in nodes:
        if task_tree.load(n['key'], base=base) is None:
            task_tree.save(_record(n), base=base)
            created.append(n['key'])
    assignments, unassigned = match_packages(packages or [], nodes)
    for pid, key in assignments.items():
        task_tree.assign_set(pid, key, base=base)
    return {'nodes': nodes, 'created': created,
            'assignments': assignments, 'unassigned': unassigned}
