"""Persistent archive for dashboard packages. Archived packages stay in the
tab, but are excluded from active/all counts and from the sidebar."""
from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

import userdata

NAME = 'task_archive.json'
ARCHIVED = {}


def default_path() -> Path:
    return userdata.path(NAME)


def load(path=None) -> dict:
    global ARCHIVED
    try:
        data = json.loads(Path(path or default_path()).read_text(encoding='utf-8'))
        ARCHIVED = data if isinstance(data, dict) else {}
    except Exception:
        ARCHIVED = {}
    return ARCHIVED


def save(data, path=None):
    global ARCHIVED
    custom = path is not None
    path = Path(path) if custom else default_path()
    if not custom:
        userdata.ensure(NAME)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=str(path.parent))
    with open(fd, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
    Path(tmp).replace(path)
    ARCHIVED = data
    return data


def archive(keys, reason='manual'):
    data = load()
    now = time.strftime('%Y-%m-%d %H:%M:%S')
    for key in keys:
        if key:
            data[str(key)] = {'reason': reason, 'at': now}
    return save(data)


def unarchive(keys=None):
    data = load()
    if keys is None:
        data = {}
    else:
        for key in keys:
            data.pop(str(key), None)
    return save(data)
