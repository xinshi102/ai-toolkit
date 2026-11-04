"""Explicit package/subtask taxonomy. Only mappings here are grouped.

No similarity/prefix inference: an unmapped run stays its own package/subtask.
"""
from __future__ import annotations

import json
from pathlib import Path

DEFAULT = Path(__file__).with_name('task_taxonomy.json')


def load(path=None) -> dict:
    try:
        data = json.loads(Path(path or DEFAULT).read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def package_for(task, group='', mapping=None) -> str:
    mapping = mapping if isinstance(mapping, dict) else load()
    packages = mapping.get('packages') or {}
    for key in (str(task or ''), str(group or '')):
        if key and key in packages:
            return str(packages[key])
    return str(group or task or '未归属')


def subtask_for(name, task='', mapping=None) -> str:
    mapping = mapping if isinstance(mapping, dict) else load()
    subtasks = mapping.get('subtasks') or {}
    name = str(name or '')
    if name in subtasks:
        return str(subtasks[name])
    return name or str(task or '未命名')


def title_for(package, mapping=None) -> str:
    mapping = mapping if isinstance(mapping, dict) else load()
    return str((mapping.get('titles') or {}).get(str(package), package))
