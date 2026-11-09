"""车道 ctl（controller-link）：主控台与主控的关系。

新逻辑全部放这里，现有文件只做最小接入。一个包若"有主控在管"（近期
.work/<任务>/STATE.md，或 spec 写了 controller/plan/parent_plan），主控台
只把用户的决定排队给主控，不直接续做执行者——避免主控和主控台两个人同时
指挥同一个执行者。

纯函数 + 小工具：
  * owner(package_dir)：判定有没有主控在管；
  * defer(...)：把决定写进 <task_dir>/USER_DECISIONS.md、decisions.jsonl，
    并发出 decision_queued 事件；
  * needs_decision_items / milestone_items：主控上报的 decide / ms 卡片；
  * queued_count：decisions.jsonl 里 status=pending 的条数。

不启动任何 AI，不改全局配置；写入只落在 AI_COLLAB_DATA 目录或 task_dir。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

STATE_WINDOW = 72 * 3600          # STATE.md 的"近期"阈值
ITEM_WINDOW = 7 * 86400           # NEEDS_DECISION / 里程碑 / 包级 done-fail 窗口
PLAN_MAP_ROOT = Path(os.environ.get('AI_COLLAB_PLANMAP') or Path.home() / '.ai-collab' / 'plan-map')
DECISIONS = 'decisions.jsonl'
USER_DECISIONS = 'USER_DECISIONS.md'
TARGETS = 'decision_targets.json'
CONTROLLED_KEYS = ('controller', 'plan', 'parent_plan')

_plan_map_override = None


# ---- 可覆盖的路径（测试用临时目录） ---------------------------------------
def set_plan_map_root(path):
    global _plan_map_override
    _plan_map_override = Path(path) if path is not None else None


def plan_map_root():
    return _plan_map_override or PLAN_MAP_ROOT


def _data_dir():
    import userdata
    return userdata.data_dir()


def decisions_path():
    return _data_dir() / DECISIONS


def _targets_path():
    return _data_dir() / TARGETS


# ---- 判定"有没有主控在管" -------------------------------------------------
def _fresh(path, now, window):
    try:
        m = Path(path).stat().st_mtime
    except OSError:
        return False
    # 允许 2 秒的时钟/时间戳粒度偏差：刚写出的文件 mtime 可能略领先 time.time()
    return m <= now + 2 and now - m <= window


def _ancestors(package_dir):
    """从 package_dir 向上到项目根（含 .git 的那级）或文件系统根，最多 16 级。"""
    cur = Path(package_dir).resolve()
    out = []
    for _ in range(16):
        out.append(cur)
        if (cur / '.git').exists():
            break
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return out


def _state_task_dirs(levels, now):
    """返回最近优先的 (task_dir, STATE 是否近期) 列表。"""
    found, seen = [], set()
    for base in levels:
        work = base / '.work'
        if not work.is_dir():
            continue
        try:
            tasks = sorted(work.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for task in tasks:
            if not task.is_dir() or str(task) in seen:
                continue
            seen.add(str(task))
            state = task / 'STATE.md'
            ok = state.is_file() and _fresh(state, now, STATE_WINDOW)
            found.append((task, ok))
    return found


def _controller(package_dir):
    try:
        import inbox
        who = inbox._who(package_dir)
    except Exception:
        who = ''
    return who or 'GPT'


def _read_spec(package_dir):
    for name in ('spec.json', 'request.json'):
        p = Path(package_dir) / name
        if p.is_file():
            try:
                data = json.loads(p.read_text(encoding='utf-8-sig'))
                if isinstance(data, dict):
                    return data
            except (OSError, ValueError):
                pass
    return {}


def owner(package_dir, now=None) -> dict:
    """纯函数：判定一个包有没有主控在管。

    测试里用临时目录造数据、用 now 固定时间即可，不改任何全局状态。
    """
    now = time.time() if now is None else now
    package_dir = Path(package_dir)
    spec = _read_spec(package_dir)
    spec_keys = [k for k in CONTROLLED_KEYS
                 if k in spec and spec[k] not in (None, '', False)]
    controller = _controller(package_dir)
    plan = next((spec[k] for k in ('plan', 'parent_plan') if spec.get(k)), None)

    state_dirs = _state_task_dirs(_ancestors(package_dir), now)
    fresh = next((d for d, ok in state_dirs if ok), None)

    def result(controlled, task_dir, reason):
        return {'controlled': controlled, 'controller': controller,
                'task_dir': Path(task_dir) if task_dir else None,
                'plan': plan, 'reason': reason}

    if fresh is not None:
        return result(True, fresh, '找到 %s 的 STATE.md 在 72 小时内更新过' % fresh.name)
    if spec_keys:
        nearest = next((d for d, _ in state_dirs), None)
        return result(True, nearest, 'spec 中含 %s 字段' % '/'.join(spec_keys))
    if state_dirs:
        return result(False, None, 'STATE.md 超过 72 小时未更新（%s）' %
                      ', '.join(d.name for d, _ in state_dirs[:2]))
    return result(False, None,
                  '未找到 .work/<任务>/STATE.md，且 spec 无 controller/plan/parent_plan 字段')


# ---- 记录用户决定 ---------------------------------------------------------
def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def _append_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as fh:
        fh.write(text)
        fh.flush()


def _decision_dir(info):
    td = info.get('task_dir')
    return Path(td) if td else _data_dir()


def _rel(package_dir, task_dir):
    if not package_dir:
        return ''
    p = Path(package_dir)
    if p.is_absolute() and task_dir:
        try:
            return str(p.relative_to(Path(task_dir).parent))
        except (ValueError, OSError):
            pass
    return str(package_dir)


def _emit_queued(package_id, payload):
    """真正调 eventlog.emit('decision_queued', ...)。

    eventlog 车道尚未登记该类型时会抛 ValueError（其 TYPES 必须保持 9 种），
    这里退回内建 'answer' 类型、把真实动作放进 payload.action —— 与 inbox._emit
    同一套路：既不改 eventlog 车道，也不会因未知类型抛异常。登记后自动直接用。
    """
    import eventlog
    body = dict(payload)
    body['action'] = 'decision_queued'
    reason = '用户决定已排队，待主控处理'
    try:
        return eventlog.emit('decision_queued', package_id, reason=reason, payload=body)
    except ValueError:
        return eventlog.emit('answer', package_id, reason=reason, payload=body)


def append_decision(record):
    _append_text(decisions_path(),
                 json.dumps(record, ensure_ascii=False, sort_keys=True) + '\n')


def queued_count():
    path = decisions_path()
    if not path.is_file():
        return 0
    n = 0
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get('status') == 'pending':
            n += 1
    return n


def defer(item_id, info, choice, text, queue=True) -> dict:
    """把一条用户决定写给主控。

    queue=True  ：原本会启动续做的决定——写 USER_DECISIONS.md +
                  decisions.jsonl(pending) + 发 decision_queued + 返回 queued。
    queue=False ：不启动进程的操作（如 done 选 A）——照常执行，只额外写
                  USER_DECISIONS.md 让主控知道，返回 None。
    """
    info = dict(info or {})
    ts = _now_iso()
    controller = info.get('controller') or 'GPT'
    kind = info.get('kind') or 'decide'
    title = info.get('title') or item_id
    task_dir = _decision_dir(info)
    package_rel = _rel(info.get('package_dir'), info.get('task_dir'))
    labels = info.get('options') or {}
    choice_label = str(choice or '')
    if choice and labels.get(str(choice)):
        choice_label = '%s %s' % (choice, labels[str(choice)])

    bits = []
    if choice:
        bits.append('用户选择：%s' % choice_label)
    if text:
        bits.append('用户原话：%s' % text)
    entry = ['## %s · %s' % (ts, title),
             '- 事项：%s（%s）· 包：%s' % (item_id, kind, package_rel),
             '- ' + (' / '.join(bits) if bits else '用户选择：（无）'),
             '- 状态：待主控处理']
    _append_text(task_dir / USER_DECISIONS, '\n'.join(entry) + '\n\n')

    if not queue:
        return None
    append_decision({'ts': ts, 'id': item_id, 'kind': kind,
                     'choice': choice, 'text': text, 'task_dir': str(task_dir),
                     'package_dir': package_rel, 'controller': controller,
                     'status': 'pending'})
    _emit_queued(item_id, {'id': item_id, 'controller': controller,
                           'task_dir': str(task_dir)})
    return {'ok': True, 'next': 'queued', 'controller': controller, 'package': None}


# ---- nd / ms 卡片的 meta（act 在另一请求里靠它找 task_dir） ---------------
def remember_targets(entries):
    """合并写入，不整份覆盖别人的条目。"""
    path = _targets_path()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    data.update(entries)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True),
                   encoding='utf-8')
    os.replace(str(tmp), str(path))
    return data


def target_for(item_id):
    try:
        data = json.loads(_targets_path().read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    if isinstance(data, dict) and isinstance(data.get(str(item_id)), dict):
        return data[str(item_id)]
    return {}


def target_info(item_id):
    t = target_for(item_id)
    return {'controlled': True,
            'controller': t.get('controller') or 'GPT',
            'task_dir': Path(t['task_dir']) if t.get('task_dir') else None,
            'plan': t.get('plan'), 'reason': '主控上报的事项',
            'package_dir': t.get('package_dir') or '',
            'kind': t.get('kind') or 'decide',
            'title': t.get('title') or item_id,
            'options': t.get('options') or {}}


# ---- NEEDS_DECISION*.md -> decide 卡片 ------------------------------------
def _nd_title(text):
    for ln in str(text or '').splitlines():
        s = ln.strip()
        if '【需要你决定】' in s:
            return s.split('【需要你决定】', 1)[1].strip().lstrip('#').strip()
    for ln in str(text or '').splitlines():
        s = ln.strip().lstrip('#').strip()
        if s:
            return s
    return ''


def _nd_background(text):
    """取"背景"第一段，截到 140 字以内。"""
    out, started = [], False
    for ln in str(text or '').splitlines():
        s = ln.strip()
        if not started:
            if '背景' in s:
                started = True
                rest = s.split('背景', 1)[1].lstrip('#：: ').strip()
                if rest:
                    out.append(rest)
            continue
        if not s:
            if out:
                break
            continue
        if s.startswith('#') or re.match(r'^[A-Za-z]\s*[.、:：]', s):
            break
        out.append(s)
    return ' '.join(out).strip()[:140]


def _nd_options(text):
    opts = []
    for ln in str(text or '').splitlines():
        m = re.match(r'^\s*([A-Za-z])\s*[.、:：]\s*(.+?)\s*$', ln)
        if m:
            opts.append({'key': m.group(1).upper(),
                         'label': m.group(2).strip(), 'hint': ''})
    return opts


def _rel_id(p, base):
    try:
        return str(Path(p).resolve().relative_to(Path(base).resolve()))
    except (ValueError, OSError):
        return Path(p).name


def needs_decision_items(task_dirs, handled=None, now=None):
    """返回 [(item, meta)]：每个受控任务目录下未解决、7 天内的 NEEDS_DECISION*.md。"""
    now = time.time() if now is None else now
    handled = handled or {}
    out = []
    for td in task_dirs:
        td = Path(td)
        base = td.parent.parent if td.parent.name == '.work' else td.parent
        try:
            files = sorted(td.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for p in files:
            up = p.name.upper()
            if not (p.is_file() and up.startswith('NEEDS_DECISION')
                    and p.name.lower().endswith('.md')):
                continue
            if 'resolved' in p.name.lower():
                continue
            if not _fresh(p, now, ITEM_WINDOW):
                continue
            try:
                text = p.read_text(encoding='utf-8-sig')
                mtime = p.stat().st_mtime
            except OSError:
                continue
            rel = _rel_id(p, base)
            iid = 'nd:' + hashlib.sha1(rel.encode('utf-8')).hexdigest()[:12]
            if iid in handled:
                continue
            title = _nd_title(text) or p.stem
            opts = _nd_options(text)
            who = _controller(td)
            it = {'id': iid, 'kind': 'decide', 'title': title[:90],
                  'context': _nd_background(text), 'task': td.name,
                  'task_title': td.name, 'parent_title': '', 'who': who,
                  'options': opts, 'created_at': mtime}
            meta = {'task_dir': str(td), 'controller': who, 'package_dir': rel,
                    'kind': 'decide', 'title': title[:90],
                    'options': {o['key']: o['label'] for o in opts}}
            out.append((it, meta))
    return out


# ---- Plan Map -> ms 里程碑卡片 --------------------------------------------
def _is_bak(p):
    parts = {x.lower() for x in p.parts}
    return '.maintenance' in parts or 'bak' in p.name.lower()


def milestone_items(root=None, handled=None, now=None):
    """返回 [(item, meta)]：顶层 done 节点、7 天内、按 planId:nodeId 去重。"""
    now = time.time() if now is None else now
    handled = handled or {}
    base = Path(root) if root is not None else plan_map_root()
    out, seen = [], set()
    if not base.is_dir():
        return out
    for f in sorted(base.rglob('*.json')):
        if _is_bak(f) or not _fresh(f, now, ITEM_WINDOW):
            continue
        try:
            data = json.loads(f.read_text(encoding='utf-8-sig'))
            mtime = f.stat().st_mtime
        except (OSError, ValueError):
            continue
        plan_id = str(data.get('planId') or f.stem)
        nodes = (data.get('state') or {}).get('nodes') or {}
        if not isinstance(nodes, dict):
            continue
        for nid, node in nodes.items():
            if not isinstance(node, dict):
                continue
            if str(node.get('status') or '').lower() != 'done':
                continue
            if str(node.get('parent') or '').strip():
                continue
            if not node.get('statusSeq'):
                continue
            key = '%s:%s' % (plan_id, nid)
            if key in seen:
                continue
            seen.add(key)
            iid = 'ms:' + key
            if iid in handled:
                continue
            title = str(node.get('title') or key)[:90]
            note = str(node.get('note') or '')[:140]
            it = {'id': iid, 'kind': 'ms', 'title': title, 'context': note,
                  'task': plan_id, 'task_title': plan_id, 'parent_title': '',
                  'who': 'GPT',
                  'options': [{'key': 'A', 'label': '通过', 'hint': ''},
                              {'key': 'B', 'label': '有问题', 'hint': '记给主控'}],
                  'created_at': mtime}
            meta = {'task_dir': None, 'controller': 'GPT',
                    'package_dir': key, 'kind': 'ms', 'title': title,
                    'options': {'A': '通过', 'B': '有问题'}, 'plan': plan_id}
            out.append((it, meta))
    return out
