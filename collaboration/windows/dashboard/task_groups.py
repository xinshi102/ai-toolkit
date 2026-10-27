"""Explicit task grouping. Only mappings in task_groups.json are merged.

No suffix/prefix/parent-directory inference: an unknown key stays its own task.
"""
from __future__ import annotations

import json
from pathlib import Path

DEFAULT = Path(__file__).with_name('task_groups.json')


def load(path=None) -> dict:
    try:
        data = json.loads(Path(path or DEFAULT).read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def group_for(key, mapping=None) -> str:
    key = str(key or '')
    mapping = mapping if isinstance(mapping, dict) else load()
    return str(mapping.get(key, key))
