"""Background refresh + cache for the six quota rows.

A daemon thread refreshes once at startup and then every 5 minutes. Each
provider's HTTP call is bounded by common.http_json(timeout=15). The cache
holds ONLY fetch() return values (numbers/labels); no credential is stored.
On a failed refresh the last successful row is kept and marked stale.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

from . import common, gpt, dsh

PROVIDERS = [('gpt', gpt), ('dsh', dsh)]
NAME = {'gpt': 'GPT', 'dsh': 'DSH'}
ROLE = {'gpt': '主控', 'dsh': '执行'}
INTERVAL = 300

_cache = {}
_lock = threading.RLock()
_started = False


def cache_path():
    base = os.environ.get('AI_COLLAB_DATA')
    return (Path(base) if base else Path.home() / '.ai-collab') / 'quota_cache.json'


def _save():
    try:
        p = cache_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({'rows': list(_cache.values()),
                                 'saved_at': time.time()}, ensure_ascii=False),
                     encoding='utf-8')
    except Exception:
        pass


def _load():
    try:
        obj = json.loads(cache_path().read_text(encoding='utf-8'))
        for r in obj.get('rows') or []:
            if isinstance(r, dict) and r.get('key') in NAME:
                r.setdefault('stale', True)        # disk values are stale until refreshed
                _cache[r['key']] = r
    except Exception:
        pass


def refresh():
    fetched = {}
    for key, mod in PROVIDERS:
        try:
            fetched[key] = mod.fetch()
        except Exception as exc:
            fetched[key] = common.unknown(NAME[key],
                                          '抓取失败：%s' % type(exc).__name__)
    now = time.time()
    with _lock:
        for key, fresh in fetched.items():
            fresh['key'] = key
            fresh['role'] = ROLE.get(key)
            if fresh.get('status') == 'ok':
                fresh['stale'] = False
                fresh['last_ok_at'] = fresh.get('fetched_at') or now
                _cache[key] = fresh
            else:
                prev = _cache.get(key)
                if prev and prev.get('status') == 'ok':
                    served = dict(prev)
                    served['stale'] = True
                    served['last_ok_at'] = prev.get('last_ok_at') or prev.get('fetched_at')
                    served['stale_reason'] = fresh.get('reason')
                    _cache[key] = served
                else:
                    fresh['stale'] = False
                    _cache[key] = fresh
        _save()
    return snapshot()


def snapshot():
    with _lock:
        rows = [dict(_cache[k]) for k, _ in PROVIDERS if k in _cache]
    have = {r.get('key') for r in rows}
    for key, _ in PROVIDERS:
        if key not in have:
            rows.append(common.unknown(NAME[key], '正在获取额度…',
                                       key=key, role=ROLE[key]))
    order = {k: i for i, (k, _) in enumerate(PROVIDERS)}
    rows.sort(key=lambda r: order.get(r.get('key'), 99))
    return rows


def start(interval=INTERVAL):
    global _started
    with _lock:
        if _started:
            return
        _started = True
        _load()

    def loop():
        while True:
            try:
                refresh()
            except Exception:
                pass
            time.sleep(interval)
    threading.Thread(target=loop, daemon=True).start()
