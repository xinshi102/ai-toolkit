"""收件箱：decide / fail / done 三类事项的汇总与一键处理。

接口见 console-contract.md 第 2 节。状态写在 ~/.ai-collab（可用 AI_COLLAB_DATA
覆盖）：accepted.json、dismissed.json、inbox_handled.json。

续做一律经 launch() 在后台线程启动，不阻塞看板 HTTP 进程；测试把 launch 换成
同步调用并用假的 run_package / ask 打桩即可，不会真起进程。

task / task_title / parent_title 优先取 tree 车道模块（可选 import，缺失就
回退到 spec 的 task 字段与包目录推断，推断不出来留空），不硬依赖 tree。
"""
from __future__ import annotations

import importlib
import json
import re
import tempfile
import threading
import time
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path

import eventlog  # noqa: E402
import suspend  # noqa: E402
import userdata  # noqa: E402
import package_discovery  # noqa: E402
import controller_link  # noqa: E402 - 车道 ctl 新模块

ACCEPTED = 'accepted.json'
DISMISSED = 'dismissed.json'
HANDLED = 'inbox_handled.json'
MAX_BODY = 16 * 1024
MAX_TEXT = 2000
WINDOW = 7 * 86400
LOCAL_HOSTS = {'127.0.0.1', '::1', 'localhost'}

_ROOTS = None


def set_roots(roots):
    """看板启动时登记 --roots；collect() 不带参数时用它 + 注册表/扫描结果。"""
    global _ROOTS
    _ROOTS = [Path(r) for r in roots] if roots is not None else None


def is_local(client_address):
    host = client_address[0] if isinstance(client_address, (tuple, list)) else client_address
    return str(host) in LOCAL_HOSTS


# ---- 状态文件 -------------------------------------------------------------
def _state_path(name):
    return userdata.data_dir() / name


def _load(name):
    try:
        data = json.loads(_state_path(name).read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save(name, data):
    path = _state_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=name + '.', suffix='.tmp', dir=str(path.parent))
    with open(fd, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
    Path(tmp).replace(path)
    return data


def _mark(name, key, extra=None):
    data = _load(name)
    data[str(key)] = {'at': time.time(), **(extra or {})}
    return _save(name, data)


def accepted_path():
    return _state_path(ACCEPTED)


def dismissed_path():
    return _state_path(DISMISSED)


# ---- 事件日志 -------------------------------------------------------------
def _emit(action, package_id, reason='', mandate_id=None, payload=None):
    """所有 act 操作都写事件日志。

    eventlog 目前只登记 9 种内建类型；收件箱的 5 种动作类型若还没登记，就
    退回内建的 'answer' 类型，把真实动作放进 payload.action —— 既不改 eventlog
    车道，也不会因为未知类型抛 ValueError。等动作类型登记后会自动直接用它们。
    """
    body = dict(payload or {})
    body['action'] = action
    try:
        return eventlog.emit(action, package_id, reason=reason,
                             mandate_id=mandate_id, payload=body)
    except ValueError:
        return eventlog.emit('answer', package_id, reason=reason,
                             mandate_id=mandate_id, payload=body)


# ---- task / task_title / parent_title -------------------------------------
def _tree_module():
    for name in ('task_tree', 'tree', 'tree_api'):
        try:
            return importlib.import_module(name)
        except ImportError:
            continue
    return None


def _plausible(name):
    if not name or re.fullmatch(r'(?i)(tmp|temp)[\w]*|[\da-f]{8,}', str(name)):
        return ''
    return str(name)


def _task_info(package_dir, spec):
    tree = _tree_module()
    if tree is not None:
        for fname in ('for_package', 'package_info', 'info', 'lookup'):
            fn = getattr(tree, fname, None)
            if not callable(fn):
                continue
            try:
                info = fn(str(package_dir)) or {}
            except Exception:
                continue
            if isinstance(info, dict) and info.get('task'):
                return (str(info.get('task') or ''),
                        str(info.get('task_title') or ''),
                        str(info.get('parent_title') or ''))
    return _infer_task(package_dir, spec)


def _infer_task(package_dir, spec):
    spec = spec or {}
    raw = spec.get('task')
    task = raw.strip() if isinstance(raw, str) else ''
    parts = list(Path(package_dir).resolve().parts)
    parent = parts[-2] if len(parts) >= 2 else ''
    grand = parts[-3] if len(parts) >= 3 else ''
    if not task:
        task = Path(package_dir).name
    task_title = str(spec.get('task_title') or '').strip()
    parent_title = str(spec.get('parent_title') or '').strip()
    if not task_title and '.' in task:
        segs = [s for s in task.split('.') if s]
        if segs:
            task_title = segs[-1].replace('-', ' ').replace('_', ' ').strip()
        if len(segs) > 1 and not parent_title:
            parent_title = segs[0].replace('-', ' ').replace('_', ' ').strip()
    task_title = task_title or _plausible(parent)
    parent_title = parent_title or _plausible(grand)
    return task, task_title, parent_title


_CONTROLLER = {'codex': 'GPT', 'dsh': 'DSH', 'shared': 'GPT'}


def _who(package_dir):
    low = [p.lower() for p in Path(package_dir).parts]
    if 'projects' in low:
        i = low.index('projects')
        host = low[i + 1] if i + 1 < len(low) else ''
        return _CONTROLLER.get(host, host)
    return ''


def _line(text, limit=90):
    for ln in str(text or '').splitlines():
        s = ln.strip().lstrip('#').strip()
        if s:
            return s[:limit]
    return ''


# ---- 回执 -----------------------------------------------------------------
def _receipt_files(d):
    out = []
    for p in d.glob('receipt*.json'):
        m = re.fullmatch(r'receipt(?:\.c(\d+))?\.json', p.name)
        if m:
            out.append((int(m.group(1)) if m.group(1) else 1, p))
    return [p for _, p in sorted(out)]


def _receipt_ok(rec):
    if 'ok' in rec:
        return bool(rec['ok'])
    if rec.get('stall') or rec.get('max_turns_hit') or rec.get('stop_evidence'):
        return False
    parsed = rec.get('parsed') or {}
    if parsed.get('transport_policy_passed') is False:
        return False
    if (rec.get('block') or {}).get('block_error'):
        return False
    return bool(parsed.get('final_text') or rec.get('reply'))


def _failure_reason(rec):
    for key in ('reason', 'failure_reason', 'error'):
        if rec.get(key):
            return str(rec[key])
    stall = rec.get('stall') or {}
    if isinstance(stall, dict) and stall.get('reason'):
        return str(stall['reason'])
    fs = (rec.get('parsed') or {}).get('failures') or []
    if fs:
        return '; '.join(str(x) for x in fs)
    return '执行失败'


def _no_auto_retry(recs, spec):
    """规则不会再自动重试：同一原因失败 >=2 次，或 auto-continue 已用完，或卡住。"""
    import guard
    try:
        budget = int(spec.get('auto_continue') or guard.DEFAULT_AUTO_CONTINUE)
    except (TypeError, ValueError):
        budget = guard.DEFAULT_AUTO_CONTINUE
    reasons = [str(r.get('reason') or _failure_reason(r))
               for r in recs if not _receipt_ok(r)]
    reasons = [x for x in reasons if x]
    if any(c >= 2 for c in Counter(reasons).values()):
        return True
    if len(recs) >= budget:
        return True
    last = recs[-1]
    if last.get('stall') or last.get('stop_evidence'):
        return True
    return False


def _read_package(d):
    files = _receipt_files(d)
    recs = []
    for p in files:
        try:
            recs.append(json.loads(p.read_text(encoding='utf-8-sig')))
        except Exception:
            continue
    if not recs:
        return None
    spec = {}
    for name in ('spec.json', 'request.json'):
        q = d / name
        if q.exists():
            try:
                spec = json.loads(q.read_text(encoding='utf-8-sig'))
                break
            except Exception:
                spec = {}
    if not isinstance(spec, dict):
        spec = {}
    created = max((p.stat().st_mtime for p in files), default=d.stat().st_mtime)
    return {'dir': d, 'spec': spec, 'recs': recs, 'last': recs[-1],
            'ok': _receipt_ok(recs[-1]), 'created_at': created}


def _package_dirs(roots):
    if roots is not None:
        search = [Path(r) for r in roots]
    else:
        search = package_discovery.effective_roots(_ROOTS or [])
    out = {}
    for root in search:
        if not root.is_dir():
            continue
        for rec in root.rglob('receipt*.json'):
            d = rec.parent
            out.setdefault(str(d.resolve()), d)
    return list(out.values())


def _find_package(package_id):
    for d in _package_dirs(None):
        pkg = _read_package(d)
        if pkg is None:
            continue
        pid = str(pkg['spec'].get('task_id') or d.name)
        if pid == package_id or d.name == package_id:
            return pkg
    return None


# ---- 事项构造 -------------------------------------------------------------
def _ask_options(ask):
    flat = []
    for group in (ask.get('options') or []):
        if isinstance(group, list):
            flat.extend(group)
        elif group is not None:
            flat.append(group)
    out = []
    for i, opt in enumerate(flat):
        key = chr(ord('A') + i) if i < 26 else str(i + 1)
        label, hint = '', ''
        if isinstance(opt, dict):
            key = str(opt.get('key') or key)
            label = str(opt.get('label') or opt.get('text') or opt.get('title') or '')
            hint = str(opt.get('hint') or '')
        elif isinstance(opt, (list, tuple)):
            if opt:
                key = str(opt[0])
            if len(opt) > 1:
                label = str(opt[1])
            if len(opt) > 2:
                hint = str(opt[2])
        else:
            label = str(opt)
        out.append({'key': key, 'label': label, 'hint': hint})
    return out


def _ask_created(ask):
    try:
        return datetime.fromisoformat(str(ask.get('ts') or '').replace('Z', '+00:00')).timestamp()
    except Exception:
        return 0.0


def _decide_item(ask):
    questions = ask.get('questions') or []
    q0 = questions[0] if questions and isinstance(questions[0], dict) else {}
    package_dir = ask.get('package_dir') or ''
    spec = {}
    if package_dir:
        p = Path(package_dir) / 'spec.json'
        if p.exists():
            try:
                spec = json.loads(p.read_text(encoding='utf-8-sig'))
            except Exception:
                spec = {}
    task, task_title, parent_title = _task_info(package_dir, spec)
    title = str(q0.get('title') or '').strip() or _line(q0.get('text'), 60) or '需要你决定'
    context = ' '.join(x for x in (str(q0.get('text') or ''),
                                   str(ask.get('next') or '')) if x).strip()[:140]
    return {'id': 'ask:' + str(ask.get('ask_id') or ask.get('id') or ''),
            'kind': 'decide', 'title': title, 'context': context,
            'task': task, 'task_title': task_title, 'parent_title': parent_title,
            'who': _who(package_dir), 'options': _ask_options(ask),
            'created_at': _ask_created(ask)}


FAIL_OPTIONS = [{'key': 'A', 'label': '换模型重试', 'hint': '同一会话续做'},
                {'key': 'B', 'label': '稍后重试', 'hint': ''},
                {'key': 'C', 'label': '放弃', 'hint': ''}]
DONE_OPTIONS = [{'key': 'A', 'label': '通过', 'hint': ''},
                {'key': 'B', 'label': '退回修改', 'hint': '原会话续做'}]


def _package_item(pkg, kind):
    d = pkg['dir']
    spec = pkg['spec']
    package_id = str(spec.get('task_id') or d.name)
    task, task_title, parent_title = _task_info(d, spec)
    title = str(spec.get('title') or '').strip() or _line(spec.get('prompt'), 90) or package_id
    if kind == 'fail':
        reason = str(pkg['last'].get('reason') or _failure_reason(pkg['last']))
        same = sum(1 for r in pkg['recs'] if not _receipt_ok(r)
                   and str(r.get('reason') or _failure_reason(r)) == reason)
        context = (reason + '；同一原因第 %d 次失败，规则不再自动重试' % same)[:140]
        options = [dict(o) for o in FAIL_OPTIONS]
    else:
        context = str(pkg['last'].get('context') or pkg['last'].get('summary') or '').strip()[:140] \
            or '执行完成，等待验收'
        options = [dict(o) for o in DONE_OPTIONS]
    return {'id': kind + ':' + package_id, 'kind': kind, 'title': title,
            'context': context, 'task': task, 'task_title': task_title,
            'parent_title': parent_title, 'who': _who(d), 'options': options,
            'created_at': pkg['created_at']}


# ---- collect --------------------------------------------------------------
def collect(roots=None) -> dict:
    accepted = _load(ACCEPTED)
    dismissed = _load(DISMISSED)
    handled = _load(HANDLED)
    items = []
    for ask in suspend.list_asks():
        if ask.get('type') == 'later':
            continue  # 预约复查不是需要你决定的事
        it = _decide_item(ask)
        if it['id'] not in handled:
            items.append(it)
    now = time.time()
    pkgs = [(d, _read_package(d)) for d in _package_dirs(roots)]

    # 车道 ctl：逐个判定包有没有主控在管；受控包不显示包级 fail/done。
    controlled_pkgs = set()
    controlled_task_dirs = {}
    for d, _p in pkgs:
        info = controller_link.owner(d)
        key = str(d.resolve())
        if info['controlled']:
            controlled_pkgs.add(key)
            if info['task_dir']:
                controlled_task_dirs[str(info['task_dir'])] = info['task_dir']

    ok_ids_continued = set()
    for _d, _p in pkgs:
        if _p and _p['ok']:
            c = (_p['spec'] or {}).get('continuation_of')
            if isinstance(c, str) and c:
                ok_ids_continued.add(c)
    for d, pkg0 in pkgs:
        pkg = pkg0
        if pkg is None:
            continue
        if str(d.resolve()) in controlled_pkgs:
            continue  # 交给主控，主控台不逐包显示
        package_id = str(pkg['spec'].get('task_id') or d.name)
        if pkg['ok']:
            if package_id in accepted or 'done:' + package_id in handled or 'fail:' + package_id in handled:
                continue
            if pkg['created_at'] < now - WINDOW:
                continue
            items.append(_package_item(pkg, 'done'))
        else:
            if package_id in dismissed or 'fail:' + package_id in handled or 'done:' + package_id in handled:
                continue
            if not _no_auto_retry(pkg['recs'], pkg['spec']):
                continue
            if pkg['created_at'] < now - WINDOW:
                continue
            if package_id in ok_ids_continued:
                continue  # 后续续做已成功，这次失败已被接住
            items.append(_package_item(pkg, 'fail'))

    # 主控上报的事：NEEDS_DECISION -> decide；Plan Map 顶层 done -> ms。
    # 只在"确实有主控在管"时才出现，避免污染没有主控的普通收件箱。
    meta = {}
    if controlled_pkgs or controlled_task_dirs:
        for it, m in controller_link.needs_decision_items(
                list(controlled_task_dirs.values()), handled):
            items.append(it)
            meta[it['id']] = m
        first_td = next(iter(controlled_task_dirs.values()), None)
        for it, m in controller_link.milestone_items(handled=handled):
            if first_td is not None:
                m['task_dir'] = str(first_td)
            items.append(it)
            meta[it['id']] = m
        if meta:
            controller_link.remember_targets(meta)

    order = {'decide': 0, 'ms': 1, 'fail': 2, 'done': 3}
    items.sort(key=lambda it: (order.get(it['kind'], 9), -it['created_at']))
    counts = {k: sum(1 for it in items if it['kind'] == k)
              for k in ('decide', 'ms', 'fail', 'done')}
    counts['queued'] = controller_link.queued_count()
    return {'items': items, 'counts': counts}


# ---- 续做 / 后台启动 ------------------------------------------------------
def _continuation(pkg, prompt, model=None):
    pkg = pkg or {}
    d = pkg.get('dir')
    spec = pkg.get('spec') or {}
    recs = pkg.get('recs') or []
    last = recs[-1] if recs else {}
    session = str(spec.get('session_id') or (last.get('parsed') or {}).get('session_id') or '')
    task_id = str(spec.get('task_id') or (Path(d).name if d else 'inbox-continuation'))
    cont = {'task_id': task_id,
            'cwd': str(spec.get('cwd') or (Path(d) if d else userdata.data_dir())),
            'permission': spec.get('permission') or 'read-only',
            'prompt': prompt,
            'continuation_of': task_id,
            'resume': True,
            'persist_session': True,
            'session_id': session}
    if model:
        cont['model'] = model
    parent = Path(d) if d else userdata.data_dir()
    out = parent / ('inbox-' + uuid.uuid4().hex[:8])
    out.mkdir(parents=True, exist_ok=True)
    spec_path = out / 'spec.json'
    spec_path.write_text(json.dumps(cont, ensure_ascii=False, indent=2), encoding='utf-8')
    return cont, spec_path


def launch(fn, *args):
    """在后台线程调用 fn，不阻塞看板进程。测试可把 launch 换成同步调用。"""
    def runner():
        try:
            fn(*args)
        except Exception:
            pass
    t = threading.Thread(target=runner, daemon=True)
    t.start()
    return t


def _choice_index(choice):
    c = str(choice or '').strip().upper()
    if c.isdigit():
        return c
    if len(c) == 1 and 'A' <= c <= 'Z':
        return str(ord(c) - ord('A') + 1)
    return c


def _ctl_info(raw_kind, value, owner_info, rec, pkg, pkg_dir):
    """给受控的旧三类事项构造 controller_link.defer 需要的 meta。"""
    info = dict(owner_info)
    info['package_dir'] = pkg_dir or ''
    info['kind'] = {'ask': 'decide', 'fail': 'fail', 'done': 'done'}.get(raw_kind, 'decide')
    spec = (pkg or {}).get('spec') or {}
    if raw_kind == 'ask':
        questions = (rec or {}).get('questions') or []
        q0 = questions[0] if questions and isinstance(questions[0], dict) else {}
        info['title'] = str(q0.get('title') or '') or value
        info['options'] = {o['key']: o['label'] for o in _ask_options(rec or {})}
    else:
        info['title'] = str(spec.get('title') or '') or value
        base = FAIL_OPTIONS if raw_kind == 'fail' else DONE_OPTIONS
        info['options'] = {o['key']: o['label'] for o in base}
    return info


# ---- act ------------------------------------------------------------------
def act(item_id, choice=None, text=None) -> dict:
    item_id = str(item_id or '')
    if ':' not in item_id:
        return {'ok': False, 'next': None, 'package': None, 'error': 'bad id'}
    raw_kind, value = item_id.split(':', 1)
    # 合同里的 id 前缀是 ask:/fail:/done:（ask -> decide）；ctl 新增 nd:/ms:。
    kind = {'ask': 'decide', 'fail': 'fail', 'done': 'done',
            'nd': 'decide', 'ms': 'ms'}.get(raw_kind)
    if kind is None:
        return {'ok': False, 'next': None, 'package': None, 'error': 'bad kind'}
    text = None if text is None else str(text)
    if text is not None and len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]
    choice = None if choice is None else str(choice).strip().upper()
    payload = {'id': item_id, 'choice': choice, 'text': text}
    if item_id in _load(HANDLED):
        return {'ok': False, 'next': None, 'package': None, 'error': '这件事已经处理过了'}

    # ---- 车道 ctl：主控在管时只记决定、不启动续做 ----
    rec = None
    pkg = None
    pkg_dir = ''
    if raw_kind == 'ask':
        rec = suspend.find(value)
        if rec is not None:
            pkg_dir = str(rec.get('package_dir') or '')
    elif raw_kind in ('fail', 'done'):
        pkg = _find_package(value)
        if pkg is not None:
            pkg_dir = str(pkg.get('dir') or '')

    # 该选择原本会不会启动进程（ask.answer / run_package.main）
    launches = (raw_kind == 'ask'
                or (raw_kind == 'done' and choice != 'A')
                or (raw_kind == 'fail' and choice == 'A'))

    if raw_kind in ('nd', 'ms'):
        # 主控上报的事项本身就是受控的；nd 一律把决定交给主控，ms 选 B 才记。
        info = controller_link.target_info(item_id)
        if raw_kind == 'nd' or choice == 'B':
            res = controller_link.defer(item_id, info, choice, text, queue=True)
            _mark(HANDLED, item_id, {'next': 'queued'})
            return res
        controller_link.defer(item_id, info, choice, text, queue=False)
        _mark(HANDLED, item_id, {'next': 'accepted'})
        return {'ok': True, 'next': 'accepted', 'package': None}

    if pkg_dir:
        owner_info = controller_link.owner(pkg_dir)
        if owner_info['controlled']:
            info = _ctl_info(raw_kind, value, owner_info, rec, pkg, pkg_dir)
            if launches:
                res = controller_link.defer(item_id, info, choice, text, queue=True)
                _mark(HANDLED, item_id, {'next': 'queued'})
                return res
            # 不启动进程的操作（done 选 A / fail 选 C / fail 选 B）照常执行，
            # 但也写进 USER_DECISIONS.md，好让主控知道。
            controller_link.defer(item_id, info, choice, text, queue=False)

    # ---- 以下保持原有行为 ----
    if kind == 'decide':
        import ask
        rec = suspend.find(value)
        if rec is None:
            return {'ok': False, 'next': None, 'package': None, 'error': 'unknown ask'}
        raw = text if text else _choice_index(choice)
        package_id = str(rec.get('task_id') or '')
        launch(ask.answer, value, raw or '')
        _emit('answer', package_id, reason='用户回答了待决定事项', payload=payload)
        next_ = 'resumed'
    elif kind == 'done':
        if choice == 'A':
            _mark(ACCEPTED, value, {'by': 'inbox'})
            _emit('accept', value, reason='验收通过', payload=payload)
            package_id, next_ = None, 'accepted'
        else:
            pkg = _find_package(value)
            cont, spec_path = _continuation(pkg, text or '按用户意见继续修改')
            import run_package
            launch(run_package.main, str(spec_path))
            _emit('reject', value, reason='退回并续做', payload=payload)
            package_id, next_ = cont['task_id'], 'resumed'
    elif kind == 'ms':
        return {'ok': False, 'next': None, 'package': None, 'error': 'bad kind'}
    else:  # fail
        if choice == 'C':
            _mark(DISMISSED, value, {'by': 'inbox'})
            _emit('dismiss', value, reason='放弃', payload=payload)
            package_id, next_ = None, 'dismissed'
        elif choice == 'A':
            pkg = _find_package(value)
            cont, spec_path = _continuation(pkg, text or '换模型重试', model='deepseek-v4.1-flash')
            import run_package
            launch(run_package.main, str(spec_path))
            _emit('retry', value, reason='换模型重试', payload=payload)
            package_id, next_ = cont['task_id'], 'resumed'
        else:  # B 或 None：稍后重试，只记录，不启动续做
            _emit('retry', value, reason='稍后重试（只记录，不启动续做）', payload=payload)
            package_id, next_ = None, 'accepted'

    _mark(HANDLED, item_id, {'next': next_})
    return {'ok': True, 'next': next_, 'package': package_id}


def read_all(kind='done', roots=None) -> dict:
    """一键已读：done（完成待验收）与 ms（里程碑完成）。把当前列出的这两类事项记为已读。"""
    if kind not in ('done', 'ms'):
        return {'ok': False, 'count': 0, 'error': 'only done/ms'}
    items = [it for it in collect(roots)['items'] if it['kind'] == kind]
    for it in items:
        value = it['id'].split(':', 1)[1]
        _mark(ACCEPTED, value, {'by': 'read-all'})
        _mark(HANDLED, it['id'], {'next': 'read'})
    _emit('accept', 'inbox', reason='一键已读 %d 件' % len(items), payload={'kind': kind, 'count': len(items)})
    return {'ok': True, 'count': len(items)}
