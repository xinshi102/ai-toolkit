"""Append-only registry of launched work packages (standard library only).

The board reads this file to learn about package directories it was not
started with. Registration is deliberately best-effort: a failed write must
never affect the package launch that triggered it, so ``register`` swallows
every error and returns a bool.

Each line is one JSON object: {dir, task_id, cwd, adapter, started_at}.
No credentials or package contents are ever stored here.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

DEFAULT_DIR = Path.home() / '.ai-collab'
FILENAME = 'packages.jsonl'


def registry_path() -> Path:
    """$AI_COLLAB_DATA/packages.jsonl, default ~/.ai-collab/packages.jsonl."""
    base = os.environ.get('AI_COLLAB_DATA')
    return (Path(base) if base else DEFAULT_DIR) / FILENAME


def register(package_dir, task_id=None, cwd=None, adapter=None,
             path=None, now=None) -> bool:
    """Append one record. Returns False on any failure; never raises."""
    try:
        record = {
            'dir': str(package_dir),
            'task_id': task_id,
            'cwd': str(cwd) if cwd is not None else None,
            'adapter': adapter,
            'started_at': time.time() if now is None else now,
        }
        target = Path(path) if path else registry_path()
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('a', encoding='utf-8') as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + '\n')
        return True
    except Exception:
        return False


def read_registered(path=None) -> list:
    """Return every usable 'dir' value. Corrupt lines/files are skipped."""
    target = Path(path) if path else registry_path()
    out = []
    try:
        with target.open('r', encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    d = obj.get('dir') if isinstance(obj, dict) else None
                    if isinstance(d, str) and d:
                        out.append(d)
                except (ValueError, TypeError):
                    continue
    except (OSError, UnicodeDecodeError):
        return []
    return out
