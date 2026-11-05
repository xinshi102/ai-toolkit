"""Plan Map JSON and project STATE.md parsing.

FORMAT: Plan Map JSON (``state.nodes`` / ``state.order``) + STATE.md markdown.
VERSION: Plan Map v1 — ``state.nodes[].status`` / ``state.nodes[].title``;
         STATE.md uses Chinese headings 当前任务 / 下一步 / 挂起项 / 交接日志.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from .base import ok, unknown

NAME = 'planmap'
FORMAT = 'Plan Map JSON + STATE.md markdown'
VERSION = ('Plan Map v1: state.nodes[].status/title, state.order; '
           'STATE.md headings 当前任务/下一步/挂起项/交接日志')
PLAN_ROOT = Path(os.environ.get('AI_COLLAB_PLANMAP') or Path.home() / '.ai-collab' / 'plan-map')


def parse_json(path):
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        return unknown('planmap json: %s' % exc.__class__.__name__)
    if not isinstance(data, dict):
        return unknown('planmap json: not an object')
    return ok(data)


def parse_state(text):
    if not isinstance(text, str) or not text.strip():
        return unknown('planmap STATE.md: empty')
    sections, current = {}, None
    for line in text.splitlines():
        if line.startswith('#'):
            current = line.lstrip('#').strip()
            sections[current] = []
        elif current:
            sections[current].append(line.rstrip())
    return ok(sections)


def health():
    if not PLAN_ROOT.exists():
        return unknown('planmap health: no Plan Map root')
    path = next(PLAN_ROOT.glob('*.json'), None)
    if path is None:
        return unknown('planmap health: no plan files')
    return parse_json(path)
