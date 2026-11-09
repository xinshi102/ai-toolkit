"""append-only 事件日志 + why 叙述（新模块，不碰 supervision 用的 events.py）。

只追加写 ~/.ai-collab/events.jsonl（目录可用 AI_COLLAB_DATA 覆盖），每行一个
事件：时间、包 id、事件类型、原因、mandate_id（有就填）、上一个事件的 id。
写入用追加模式、每写一次 flush；并发写靠进程内锁 + O_APPEND 单次写，
不会写坏行。
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

TYPES = ('dispatch', 'gate', 'start', 'stall', 'continue', 'ask', 'answer', 'done', 'fail')
CN = {'dispatch': '派发', 'gate': '闸门检查', 'start': '开始执行', 'stall': '卡住',
      'continue': '续跑', 'ask': '向用户请示', 'answer': '用户回答',
      'done': '完成', 'fail': '失败'}

_LOCK = threading.Lock()
_LAST = {}     # (path, package_id) -> 该包最后一个事件的 id
_LOADED = set()  # 已扫描过初始内容的 path


def data_dir() -> Path:
    return Path(os.environ.get('AI_COLLAB_DATA') or (Path.home() / '.ai-collab'))


def events_path() -> Path:
    return data_dir() / 'events.jsonl'


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def _read_all(path) -> list:
    if not path.exists():
        return []
    out = []
    with path.open('r', encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            if isinstance(obj, dict):
                out.append(obj)
    return out


def reset_cache(path=None):
    """测试用：清空进程内的上一个事件缓存。"""
    with _LOCK:
        if path is None:
            _LAST.clear()
            _LOADED.clear()
        else:
            key = str(path)
            for k in [k for k in _LAST if k[0] == key]:
                del _LAST[k]
            _LOADED.discard(key)


def _ensure_loaded(path):
    key = str(path)
    if key in _LOADED:
        return
    for ev in _read_all(path):
        _LAST[(key, str(ev.get('package_id')))] = ev.get('id')
    _LOADED.add(key)


def emit(event_type, package_id, reason='', mandate_id=None, payload=None, path=None, task=None) -> dict:
    """追加一行事件并返回该事件；并发写不会写坏行。

    ``task`` 是可选的树节点 key（console-contract §1）；只在传入时写入，
    不传的历史事件结构不变。
    """
    if event_type not in TYPES:
        raise ValueError('unknown event type %r' % event_type)
    path = Path(path) if path is not None else events_path()
    with _LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        _ensure_loaded(path)
        key = (str(path), str(package_id))
        event = {
            'id': uuid.uuid4().hex,
            'ts': _now(),
            'package_id': str(package_id),
            'type': event_type,
            'reason': str(reason or ''),
            'prev_id': _LAST.get(key),
        }
        if mandate_id:
            event['mandate_id'] = str(mandate_id)
        if task:
            event['task'] = str(task)
        if payload:
            event['payload'] = payload
        line = json.dumps(event, ensure_ascii=False, sort_keys=True)
        with path.open('a', encoding='utf-8') as fh:
            fh.write(line + '\n')
            fh.flush()
        _LAST[key] = event['id']
        return event


def read_events(package_id=None, path=None) -> list:
    path = Path(path) if path is not None else events_path()
    events = _read_all(path)
    if package_id is not None:
        events = [e for e in events if str(e.get('package_id')) == str(package_id)]
    # 文件是只追加的，行序即写入（时间）顺序；稳定排序让同一毫秒的事件仍保持行序。
    return sorted(events, key=lambda e: e.get('ts') or '')


def narrate(package_id, path=None) -> str:
    """按时间列出这个包的事件链，用中文说清为什么跑、依据什么、在哪停、结果如何。"""
    events = read_events(package_id, path=path)
    if not events:
        return '包 %s：暂无事件记录，无法解释其来龙去脉。' % package_id
    lines = ['包 %s 的事件链（按时间，共 %d 条）：' % (package_id, len(events))]
    for i, e in enumerate(events, 1):
        bits = ['  %d. [%s] %s(%s)' % (i, e.get('ts') or '-',
                                       CN.get(e.get('type'), '事件'), e.get('type') or '?')]
        if e.get('reason'):
            bits.append('：' + str(e['reason']))
        if e.get('mandate_id'):
            bits.append('（依据 mandate %s）' % e['mandate_id'])
        if e.get('prev_id'):
            bits.append(' ← 上一事件 %s' % e['prev_id'])
        lines.append(''.join(bits))
    first, last = events[0], events[-1]
    why_run = next((e['reason'] for e in events
                    if e.get('type') in ('dispatch', 'start') and e.get('reason')),
                   '由 %s 事件触发' % (first.get('type') or '未知'))
    mandates = [e['mandate_id'] for e in events if e.get('mandate_id')]
    basis = '、'.join(dict.fromkeys(mandates)) if mandates else '未记录 mandate_id（无显式依据）'
    stops = [e for e in events if e.get('type') in ('stall', 'ask', 'fail')]
    where = ('；'.join('%s(%s)' % (CN.get(e['type'], e['type']), e.get('reason') or '未说明')
                       for e in stops) if stops else '未在中途停下')
    result = {'done': '成功完成', 'fail': '失败', 'stall': '卡住',
              'ask': '等待用户回答', 'continue': '仍在续跑',
              'answer': '用户已回答并续做'}.get(last.get('type'),
                                            '停在 %s' % (last.get('type') or '未知'))
    lines.append('结论：')
    lines.append('  为什么跑：%s' % why_run)
    lines.append('  依据什么：%s' % basis)
    lines.append('  在哪停：%s' % where)
    lines.append('  结果如何：%s（最后事件 %s，时间 %s）' %
                 (result, last.get('type'), last.get('ts')))
    return '\n'.join(lines)
