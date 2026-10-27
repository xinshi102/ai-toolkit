# Collab dashboard: a local read-only web board for the Codex <-> ExecA CLI bridge.
# Each "round" is a directory containing request.json / stdout.ndjson / receipt.json / reply.md.
# Rounds are grouped by task (explicit task id in request.json, or a XINSHI-* token in the prompt,
# or the dated output folder that contains the run).
#
# Usage:
#   python -B runtime/collab_dashboard.py --port 18765
#   python -B runtime/collab_dashboard.py --port 18765 --root E:/.../outputs
#
# Read-only: it never writes into the run directories. Binds 127.0.0.1 only.
import argparse
import json
import re
import sys
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os as _os
_WS = _os.environ.get('XINSHI_WORKSPACE', 'E:/AI-Workspace').replace('\\', '/').rstrip('/')
from urllib.parse import parse_qs, urlparse

import session_scanner
import token_meter
import workflow_scanner
import agent_usage
import task_groups
import remote_target
import dispatch_guard
import task_taxonomy
import task_archive
import task_progress
import board_api

DEFAULT_ROOT = Path(_WS + '/Projects/Shared/Agent-Conventions/outputs')
DEFAULT_ROOTS = [
    DEFAULT_ROOT,
]
PROJECTS_ROOT = Path(_WS + '/Projects')
ALLOWED_SUFFIXES = {'.json', '.md', '.ndjson', '.log', '.txt', '.png'}


def load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding='utf-8', errors='replace'))
    except Exception:
        return {}


def read_text(path: Path, limit: int = 0) -> str:
    if not path.exists():
        return ''
    text = path.read_text(encoding='utf-8', errors='replace')
    return text[:limit] if limit else text


def collect(root: Path, limit: int = 300):
    dirs = set()
    for p in root.rglob('stdout*.ndjson'):
        if 'node_modules' in p.parts:
            continue
        d = p.parent
        if (d / 'request.json').exists() or (d / 'reply.md').exists() or (d / 'spec.json').exists():
            dirs.add(d)
    runs = sorted(dirs, key=lambda d: d.stat().st_mtime, reverse=True)
    return runs[:limit]


def collect_all(roots, limit: int = 300):
    items = []
    for root in roots:
        if not root.exists():
            continue
        for d in collect(root, limit):
            items.append((d, root))
    items.sort(key=lambda pair: pair[0].stat().st_mtime, reverse=True)
    return items[:limit]


def derive_task(d: Path, root: Path, req: dict, prompt: str):
    """Return (task_key, source). Prefer a short explicit id, then a XINSHI-* token, then the dated folder."""
    for key in ('task_id', 'taskId', 'planId', 'plan'):
        value = req.get(key) if isinstance(req, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip(), 'field'
    # Some older runners put the whole task text in "task"; only use it as a label when it is short.
    value = req.get('task') if isinstance(req, dict) else None
    if isinstance(value, str):
        text = ' '.join(value.split())
        if 0 < len(text) <= 60 and '\n' not in value:
            return text, 'field'
    match = re.search(r'\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+){2,})\b', prompt or '')
    if match:
        token = match.group(1)
        base = re.sub(r'-[A-Z]$', '', token)
        if base.count('-') >= 2:
            return base, 'id'
        return token, 'id'
    try:
        rel = d.resolve().relative_to(root.resolve())
        parts = list(rel.parts[:-1])
    except Exception:
        parts = [d.name]
    for part in reversed(parts):
        if re.match(r'^\d{4}-\d{2}-\d{2}', part):
            return part, 'folder'
    return (parts[0] if parts else d.name), 'folder'


def infer_agent(req, d: Path) -> str:
    if isinstance(req, dict):
        for key in ('assigned_agent', 'agent', 'owner', 'provider', 'executor'):
            value = req.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    argv = ' '.join(str(x) for x in ((req or {}).get('argv') or []))
    hay = f'{argv} {d.name} {d.parent.name}'.lower()
    if 'execb' in hay:
        return 'ExecB'
    if 'execa' in hay:
        return 'ExecA'
    if 'codex' in hay or d.name.lower().startswith('gpt'):
        return 'Codex'
    if 'dsh' in hay or 'deepseek' in hay:
        return 'DSH'
    return '未知'


def first_line(text, limit=70) -> str:
    for line in str(text or '').splitlines():
        value = line.strip().lstrip('#').strip()
        if value:
            return value[:limit]
    return ''


def _attempt_files(d: Path, stem: str, ext: str):
    """stdout.ndjson, stdout.c2.ndjson, ... in attempt order (run_package.py continuation)."""
    files = list(d.glob('%s*%s' % (stem, ext)))
    def order(p):
        mid = p.name[len(stem):-len(ext)]
        return int(mid[2:]) if mid.startswith('.c') and mid[2:].isdigit() else (1 if mid == '' else 10 ** 6)
    return sorted([p for p in files if order(p) < 10 ** 6], key=order)


def parse_round(d: Path, root: Path):
    req = load_json(d / 'request.json') or load_json(d / 'spec.json') or {}
    receipts = _attempt_files(d, 'receipt', '.json')
    rec = load_json(receipts[-1]) if receipts else {}
    replies = _attempt_files(d, 'reply', '.md')
    reply = read_text(replies[-1]).strip() if replies else ''
    if not reply:
        reply = str((rec.get('parsed') or {}).get('final_text', '') or rec.get('reply', '') or '').strip()
    prompt = str(req.get('prompt', '') or '')
    argv = req.get('argv', []) or []
    tools = ''
    if '--tools' in argv:
        i = argv.index('--tools')
        if i + 1 < len(argv):
            tools = str(argv[i + 1])
    acp_tools = []
    seen_messages = set()
    tokens_in = tokens_out = 0
    session = model = first = last = ''
    turns = 0
    result_errors = []
    result_subtype = ''
    attempts = len(receipts) or 1
    for log in _attempt_files(d, 'stdout', '.ndjson'):
        for line in log.read_text(encoding='utf-8', errors='replace').splitlines():
            try:
                ev = json.loads(line)
            except Exception:
                continue
            if ev.get('type') == 'system' and ev.get('subtype') == 'init':
                session = ev.get('session_id', '') or session
                model = ev.get('model', '') or model
            if ev.get('type') == 'assistant':
                turns += 1
                usage = (ev.get('message') or {}).get('usage') or {}
                if isinstance(usage, dict):
                    tokens_in += int(usage.get('input_tokens') or 0)
                    tokens_out += int(usage.get('output_tokens') or 0)
            if ev.get('type') == 'result':
                result_subtype = str(ev.get('subtype') or '')
                result_errors = [str(x) for x in (ev.get('errors') or []) if str(x).strip()]
            if ev.get('method') == 'session/update':
                params = ev.get('params') or {}
                update = params.get('update') or {}
                session = params.get('sessionId') or session
                kind = update.get('sessionUpdate')
                if kind == 'agent_message_chunk':
                    mid = update.get('messageId')
                    if mid not in seen_messages:
                        seen_messages.add(mid)
                        turns += 1
                elif kind == 'tool_call':
                    meta = update.get('_meta') or {}
                    name = meta.get('execa.ai/toolName') or str(update.get('title') or '').split(' ')[0]
                    if name:
                        acp_tools.append(str(name))
            ts = ev.get('__timestamp') or ''
            if ts:
                first = first or ts
                last = ts
    if not tools and acp_tools:
        tools = ', '.join(dict.fromkeys(acp_tools))
    duration = None
    if first and last:
        try:
            a = datetime.fromisoformat(first.replace('Z', '+00:00'))
            b = datetime.fromisoformat(last.replace('Z', '+00:00'))
            duration = int((b - a).total_seconds())
        except Exception:
            pass
    exit_code = rec.get('exit_code')
    if rec.get('task_state') == 'unknown':
        status = 'UNKNOWN'
    elif rec.get('workflow_status') == 'accepted':
        status = 'ACCEPTED'
    elif rec.get('stall'):
        status = 'FAIL'
    elif (rec.get('parsed') or {}).get('transport_policy_passed') is False and exit_code == 0 and reply \
            and set((rec.get('parsed') or {}).get('failures') or []) <= {'tool_error'}:
        status = 'WARN'
    elif rec.get('workflow_status') == 'failed' or (rec.get('parsed') or {}).get('transport_policy_passed') is False:
        status = 'FAIL'
    elif rec.get('task_state') == 'succeeded':
        status = 'UNREVIEWED'
    elif exit_code == 0 and reply:
        status = 'OK'
    elif exit_code == 0:
        status = 'NO_REPLY'
    elif exit_code is None:
        logs = _attempt_files(d, 'stdout', '.ndjson')
        log_path = logs[-1] if logs else d / 'stdout.ndjson'
        try:
            recent = log_path.exists() and time.time() - log_path.stat().st_mtime < 300
        except Exception:
            recent = False
        status = 'RUNNING' if recent else 'NO_RECEIPT'
    else:
        status = 'FAIL'
    task, task_source = derive_task(d, root, req, prompt)
    reason = ''
    if status == 'WARN':
        reason = '已完成并有最终回复；过程中有工具报错（如测试失败后修复）'
    elif status == 'FAIL' and rec.get('stall'):
        reason = '卡住检测：' + str((rec.get('stall') or {}).get('reason') or '')
    elif status == 'FAIL':
        reason = '; '.join(result_errors)
        if not reason:
            reason = '; '.join(str(x) for x in ((rec.get('parsed') or {}).get('failures') or []))
        if not reason:
            reason = '运行失败（无更多错误信息）'
    elif status in ('NO_RECEIPT', 'NO_REPLY', 'UNKNOWN'):
        reason = '没有回执/最终回复，可能已中断或未继续'
    group = str((req.get('task_group') if isinstance(req, dict) else '') or '') or task_groups.group_for(task)
    agent = infer_agent(req, d)
    title = first_line(prompt) or d.name
    remote = remote_target.extract(prompt + '\n' + json.dumps(req, ensure_ascii=False))
    assigned = dispatch_guard.normalize_agent(req.get('assigned_agent')) if isinstance(req, dict) and req.get('assigned_agent') else ''
    if not assigned:
        assigned = dispatch_guard.normalize_agent(dispatch_guard.contract_for(task).get('executor'))
    package = str((req.get('package') if isinstance(req, dict) else '') or task_taxonomy.package_for(task, group))
    subtask = str((req.get('subtask') if isinstance(req, dict) else '') or task_taxonomy.subtask_for(d.name, task))
    package_title = task_taxonomy.title_for(package)
    nonce = ''
    m = re.search(r'nonce[ \t]*[:：]?[ \t]*([0-9a-fA-F]{6,})', prompt + ' ' + reply)
    if m:
        nonce = m.group(1)
    try:
        folder = str(d.resolve().relative_to(root.resolve()).parent)
    except Exception:
        folder = ''
    return {
        'dir': str(d),
        'name': d.name,
        'folder': folder,
        'task': task,
        'task_source': task_source,
        'group': group,
        'package': package,
        'package_title': package_title,
        'subtask': subtask,
        'agent': agent,
        'title': title,
        'remote': remote,
        'assigned': assigned,
        'task_id': str(req.get('task_id') or '') if isinstance(req, dict) else '',
        'continuation_of': str(req.get('continuation_of') or '') if isinstance(req, dict) else '',
        'attempts': attempts,
        'time': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(d.stat().st_mtime)),
        'mtime': d.stat().st_mtime,
        'status': status,
        'reason': reason,
        'result_subtype': result_subtype,
        'exit': exit_code,
        'tree': rec.get('tree_stopped'),
        'tools': tools,
        'turns': turns,
        'tokens_in': tokens_in,
        'tokens_out': tokens_out,
        'duration': duration,
        'session': session,
        'model': model or (str(req.get('model') or '') if isinstance(req, dict) else ''),
        'prompt': prompt,
        'reply': reply,
        'nonce': nonce,
        'artifacts': {
            'request.json': (d / 'request.json').exists(),
            'stdout.ndjson': (d / 'stdout.ndjson').exists(),
            'receipt.json': (d / 'receipt.json').exists(),
            'reply.md': (d / 'reply.md').exists(),
        },
    }


def mark_superseded(rounds):
    """A failed/unfinished package that a later package continues is history, not an open problem."""
    continued = {}
    for r in rounds:
        parent = r.get('continuation_of')
        if parent:
            continued[parent] = max(continued.get(parent, 0), r.get('mtime') or 0)
    for r in rounds:
        key = r.get('task_id') or r.get('name')
        if r['status'] in ('FAIL', 'NO_RECEIPT', 'NO_REPLY', 'WARN') and key in continued and continued[key] >= (r.get('mtime') or 0):
            r['status_raw'] = r['status']
            r['status'] = 'SUPERSEDED'
            r['reason'] = '已由后续续包接替（原状态 %s）' % r['status_raw']
    return rounds


def parse_events(dir_path: Path, limit: int = 40):
    logs = _attempt_files(dir_path, 'stdout', '.ndjson')
    log = logs[-1] if logs else dir_path / 'stdout.ndjson'
    events = []
    if not log.exists():
        return events
    lines = log.read_text(encoding='utf-8', errors='replace').splitlines()
    for line in lines[-limit:]:
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get('type', '')
        out = {'type': t, 'subtype': ev.get('subtype', ''), 'ts': ev.get('__timestamp', '')}
        if ev.get('method') == 'session/update':
            params = ev.get('params') or {}
            update = params.get('update') or {}
            kind = str(update.get('sessionUpdate', ''))
            out['type'] = 'acp'
            out['subtype'] = kind
            if kind == 'tool_call':
                out['text'] = f"[tool {update.get('title','')}] {json.dumps(update.get('rawInput', {}), ensure_ascii=False)[:300]}"
            elif kind == 'agent_message_chunk':
                content = update.get('content') or {}
                out['text'] = str(content.get('text', ''))[:800]
            else:
                out['text'] = f"{kind} {json.dumps(update, ensure_ascii=False)[:300]}"
        elif t == 'system' and ev.get('subtype') == 'init':
            out['text'] = f"session={str(ev.get('session_id',''))[:8]} model={ev.get('model','')} tools={','.join(ev.get('tools', []))}"
        elif t == 'assistant':
            parts = []
            for c in (ev.get('message') or {}).get('content', []) or []:
                if c.get('type') == 'text':
                    parts.append(c.get('text', ''))
                elif c.get('type') == 'tool_use':
                    parts.append(f"[tool_use {c.get('name','')}] " + json.dumps(c.get('input', {}), ensure_ascii=False)[:200])
            out['text'] = '\n'.join(parts)[:1500]
        elif t == 'result':
            out['text'] = str(ev.get('result', ''))[:800]
        else:
            out['text'] = json.dumps(ev, ensure_ascii=False)[:300]
        events.append(out)
    return events


PAGE = r'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Collab Board · 任务协作监控台</title>
<style>
:root{--bg:#0f1216;--panel:#171c22;--panel2:#13181e;--line:#2a323b;--text:#e6e9ee;--dim:#8b96a5;--ok:#3fb950;--warn:#d29922;--fail:#f85149;--none:#6e7681;--accent:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;overflow-anchor:none}
header{position:sticky;top:0;z-index:5;background:rgba(15,18,22,.96);border-bottom:1px solid var(--line);padding:12px 20px;backdrop-filter:blur(6px)}
h1{margin:0 0 4px;font-size:17px;font-weight:600}
.meta{color:var(--dim);font-size:12px}
.controls{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
input,select,button{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:6px 10px;font-size:13px}
input{width:280px}
button{cursor:pointer}
button:hover{border-color:var(--accent);color:var(--accent)}
main{padding:16px 20px 60px;max-width:1400px;margin:0 auto}
.group{background:var(--panel2);border:1px solid var(--line);border-radius:12px;margin-bottom:14px;overflow:hidden}
.ghead{display:flex;gap:12px;align-items:center;padding:12px 16px;cursor:pointer;list-style:none;user-select:none;flex-wrap:wrap}
.ghead::-webkit-details-marker{display:none}
.ghead:hover{background:#182028}
.gname{font-weight:600;font-size:15px}
.gmeta{color:var(--dim);font-size:12px}
.gstat{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.badge{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.badge.ok{color:var(--ok);border-color:#1d4d2b}
.badge.fail{color:var(--fail);border-color:#5c2020}
.badge.warn{color:var(--warn);border-color:#4d3d12}
.round{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:10px 14px}
.round .head{display:flex;gap:10px;align-items:center;padding:9px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.OK .dot{background:var(--ok)}.NO_REPLY .dot{background:var(--warn)}.FAIL .dot{background:var(--fail)}.NO_RECEIPT .dot{background:var(--none)}
.status{font-weight:600;font-size:12px;letter-spacing:.4px}
.OK .status{color:var(--ok)}.NO_REPLY .status{color:var(--warn)}.FAIL .status{color:var(--fail)}.NO_RECEIPT .status{color:var(--none)}
.name{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--accent)}
.task{font-size:12px;color:var(--dim)}
.chips{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.chip{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
.body{padding:10px 14px}
details>summary{cursor:pointer;color:var(--accent);font-size:12px;user-select:none;padding:3px 0}
pre{white-space:pre-wrap;word-break:break-word;background:#0b0e12;border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0;max-height:340px;overflow:auto;font:12px/1.45 ui-monospace,Consolas,monospace}
.files{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.files a{color:var(--accent);font-size:12px;text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:2px 8px}
.files a.off{color:var(--none);text-decoration:line-through;pointer-events:none}
.reply{color:#c9d1d9}.prompt{color:#9da7b3}
.events{font:12px/1.5 ui-monospace,Consolas,monospace;max-height:280px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px;margin-top:6px;background:#0b0e12}
.events .e{padding:2px 0;border-bottom:1px dashed #222a33}
.events .t{color:var(--dim)}
.empty{color:var(--dim);text-align:center;padding:40px}
.pill{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.sechead{display:flex;gap:10px;align-items:center;margin:24px 0 10px;font-weight:600;flex-wrap:wrap}
.sess{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:10px;padding:10px 14px}
.shead{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.src{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line)}
.src.Codex{color:#a371f7;border-color:#3d2b5e}.src.DSH{color:#58a6ff;border-color:#1f3b5c}.src.Cursor{color:#3fb950;border-color:#1d4d2b}
.agent{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--line);font-weight:600;white-space:nowrap}
.agent.ExecB{color:#d29922;border-color:#4d3d12;background:#241c08}
.agent.ExecA{color:#58a6ff;border-color:#1f3b5c;background:#0d1b2a}
.agent.Codex{color:#a371f7;border-color:#3d2b5e;background:#1a1226}
.agent.DSH{color:#3fb950;border-color:#1d4d2b;background:#0c1b12}
.agent.未知{color:#8b96a5}
.stime{font-size:12px;color:var(--dim)}
.stitle{font-size:13px;color:var(--text)}
.smeta{margin-left:auto;font-size:11px;color:var(--dim)}
.spath{font:11px ui-monospace,Consolas,monospace;color:var(--dim);word-break:break-all;margin-top:4px}
.sess pre{max-height:200px}
.headrow{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;max-width:1100px;margin:16px auto 0;padding:0 20px}
.statusbar{max-width:1100px;margin:10px auto 0;padding:0 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--dim)}
.statusbar .rstate{color:#3fb950;font-weight:600}
.statusbar .rstate.fail{color:#ff929c}
.statusbar .rstate.paused{color:var(--dim)}
.agentcard .big{display:flex;align-items:baseline;gap:8px;margin:10px 0 8px}
.agentcard .big strong{font-size:32px;line-height:1;font-weight:700}
.agentcard .big span{font-size:12px;color:var(--dim)}
.agentcard .bar{height:8px;background:#354154;border-radius:999px;overflow:hidden;margin-bottom:8px}
.agentcard .bar i{display:block;height:100%;width:0;background:#78adff;border-radius:999px;transition:width .35s ease}
.agentcard .note{font-size:11px;color:var(--dim);margin-top:8px;line-height:1.45}
.agentcard .tkline{display:flex;gap:24px;margin:8px 0 4px}
.agentcard label{display:block;font-size:11px;color:var(--dim);margin-bottom:1px}
.agentcard b{font-size:20px;font-weight:600;line-height:1.1}
.seg{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.seg button{border:0;border-radius:0;padding:5px 10px;background:transparent;color:var(--dim);font-size:12px}
.seg button.on{background:#223040;color:var(--text)}
#list{max-width:1100px;margin:12px auto 0;padding:0 20px}
.record{background:#19212c;border:1px solid #354154;border-left:3px solid #3a4656;border-radius:12px;margin:0 0 12px;overflow:hidden}
.record.warn{border-left-color:#f2c66d}
.record.fail{border-left-color:#ff929c}
.rhead{display:grid;grid-template-columns:auto auto auto 1fr auto;gap:4px 9px;align-items:center;padding:12px 14px 10px;cursor:pointer;list-style:none;user-select:none}
.rhead::-webkit-details-marker{display:none}
.rtype{font-size:10px;border:1px solid var(--line);border-radius:999px;padding:1px 7px;color:var(--dim);white-space:nowrap}
.ragent{font-size:12px;color:#b8c4d4;white-space:nowrap}
.rstat{font-size:12px;color:var(--dim);display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.sdot{width:7px;height:7px;border-radius:50%;background:#3a4656;display:inline-block}
.rstat.ok .sdot{background:#3fb950}.rstat.warn .sdot{background:#f2c66d}.rstat.fail .sdot{background:#ff929c}
.rstat.ok{color:#3fb950}.rstat.warn{color:#f2c66d}.rstat.fail{color:#ff929c}
.rtime{margin-left:auto;font-size:11px;color:var(--dim);white-space:nowrap}
.rarrow{color:var(--dim);font-size:16px;line-height:1}
.rtitle{grid-column:1/-1;font-size:15px;font-weight:600;line-height:1.35;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px}
.rmeta{grid-column:1/-1;font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rsum{grid-column:1/-1;font-size:12px;color:#b8c4d4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rbody{padding:0 14px 14px;border-top:1px solid var(--line)}
.rbody .sub{font-size:12px;color:var(--accent);margin-top:8px}
.wfn{display:flex;gap:8px;align-items:center;font-size:12px;margin-top:6px;flex-wrap:wrap}
.wfnid{font-family:ui-monospace,Consolas,monospace;color:var(--accent)}
.wfnst{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:1px 7px}
.wfnst.ok{color:var(--ok);border-color:#1d4d2b}
.wfnst.fail{color:var(--fail);border-color:#5c2020}
.wfnst.warn{color:var(--warn);border-color:#4d3d12}
.wfreason{color:var(--dim);font-size:11px;flex:1 1 100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfgates{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.wfgate{font-size:11px;color:#f2c66d;border:1px solid #4d3d12;border-radius:999px;padding:1px 8px}
.tech{font-size:11px;color:var(--dim);margin-top:8px}
.card{background:#19212c;border:1px solid #354154;border-radius:12px;padding:14px 16px;font-variant-numeric:tabular-nums}
.cardhead{display:flex;justify-content:space-between;align-items:center;gap:8px}
.card h2{margin:0;font-size:13px;font-weight:600;color:#b8c4d4;letter-spacing:.3px}
.card .state{font-size:12px;color:#78adff;white-space:nowrap}
.quota .big{display:flex;align-items:baseline;gap:8px;margin:10px 0 8px}
.quota .big strong{font-size:34px;line-height:1;font-weight:700}
.quota .big span{font-size:12px;color:var(--dim)}
.bar{height:8px;background:#354154;border-radius:999px;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:#78adff;border-radius:999px;transition:width .35s ease}
.quota[data-level="warning"] .bar i{background:#f2c66d}
.quota[data-level="danger"] .bar i{background:#ff929c}
.quota[data-level="warning"] .state{color:#f2c66d}
.quota[data-level="danger"] .state{color:#ff929c}
.rline{font-size:12px;color:#b8c4d4;margin-top:6px}
.tokens .tkline{display:flex;gap:28px;margin:10px 0 6px}
.tokens label{display:block;font-size:11px;color:var(--dim);margin-bottom:1px}
.tokens b{font-size:24px;font-weight:600;line-height:1.1}
.cacheline{font-size:12px;color:#b8c4d4}
.cacheline b{font-weight:600;color:var(--text)}
.refresh .rstate{font-size:12px;color:#3fb950;white-space:nowrap}
.refresh .rstate.warn{color:#f2c66d}
.refresh .rstate.fail{color:#ff929c}
.refresh .rstate.paused{color:var(--dim)}
@media(max-width:900px){.hero{grid-template-columns:1fr}}
#wfWrap{max-width:1400px;margin:18px auto 0;padding:0 20px}
.wfgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px}
.wfcard{background:#19212c;border:1px solid #354154;border-radius:12px;padding:12px 14px;min-width:0}
.wfhead{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.wfname{font-weight:600;font-size:14px}
.wfmeta{color:var(--dim);font-size:11px;margin-top:4px;word-break:break-all}
.wfn{display:flex;gap:8px;align-items:center;font-size:12px;margin-top:6px;flex-wrap:wrap}
.wfnid{font-family:ui-monospace,Consolas,monospace;color:var(--accent)}
.wfnst{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:1px 7px}
.wfnst.ok{color:var(--ok);border-color:#1d4d2b}
.wfnst.fail{color:var(--fail);border-color:#5c2020}
.wfnst.warn{color:var(--warn);border-color:#4d3d12}
.wfreason{color:var(--dim);font-size:11px;flex:1 1 100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfgates{margin-top:8px;display:flex;gap:6px;flex-wrap:wrap}
.wfgate{font-size:11px;color:#f2c66d;border:1px solid #4d3d12;border-radius:999px;padding:1px 8px}
.refreshbox{margin-left:auto;display:flex;gap:12px;align-items:center;font-size:11px;color:var(--dim);white-space:nowrap}
.refreshbox .rstate{color:#3fb950;font-weight:600}
.refreshbox .rstate.fail{color:#ff929c}
.refreshbox .rstate.paused{color:var(--dim)}
.task{background:#19212c;border:1px solid #354154;border-left:3px solid #3a4656;border-radius:12px;margin:0 0 12px;overflow:hidden}
.task.warn{border-left-color:#f2c66d}.task.fail{border-left-color:#ff929c}
.taskhead{display:flex;flex-direction:column;gap:4px;padding:12px 14px 10px;cursor:pointer;list-style:none;user-select:none}
.taskhead::-webkit-details-marker{display:none}
.taskline{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.ttitle{font-size:15px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tmeta{font-size:11px;color:var(--dim)}
.tgoal{font-size:12px;color:#b8c4d4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.preview{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.preview .ragent{font-size:11px}
.preview .pintent{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;color:#b8c4d4}
.preview .presult{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}
.preview.more{color:var(--dim);font-style:italic}
.att{border-top:1px solid var(--line);margin-top:6px;padding-left:0}
.attsum{display:flex;flex-direction:column;gap:3px;padding:9px 0 7px;cursor:pointer;list-style:none;user-select:none}
.attsum::-webkit-details-marker{display:none}
.attline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.attintent{font-size:12px;color:var(--text);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.attresult{font-size:11px;color:var(--dim);display:flex;gap:8px;align-items:center}
.attmeta{margin-left:auto;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%}
.rremote{font-size:10px;border:1px solid #1f3b5c;color:#78adff;border-radius:999px;padding:1px 6px;white-space:nowrap}
.rassigned{font-size:10px;border:1px solid #6e4a12;color:#f2c66d;border-radius:999px;padding:1px 6px;white-space:nowrap}
.pkgcols,.pkgrow{display:grid;grid-template-columns:minmax(220px,1.4fr) 110px minmax(220px,1.5fr) 150px 110px 18px;gap:10px;align-items:center}
.agentstrip{background:#19212c;border:1px solid #354154;border-radius:12px;overflow:hidden}
.agentstriphead,.agentstriprow{display:grid;grid-template-columns:150px 1.1fr 1.2fr 1.6fr;gap:12px;align-items:center;padding:7px 14px}
.agentstriphead{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px;border-bottom:1px solid var(--line)}
.agentstriprow{border-top:1px solid #222a33;font-size:12px;min-height:34px}
.agentstriprow:first-of-type{border-top:0}
.aname{font-weight:600;white-space:nowrap}
.sumrun{color:#78adff}.sumfail{color:#ff929c}.sumok{color:#7fcf9f}
.ares,.atok,.astate{color:#b8c4d4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.astate{color:var(--dim)}
.pkgcols{font-size:10px;color:var(--dim);padding:0 14px 6px;text-transform:uppercase;letter-spacing:.4px}
.package{background:#19212c;border:1px solid #354154;border-left:3px solid #3a4656;border-radius:12px;margin:0 0 10px;overflow:hidden}
.package.warn{border-left-color:#f2c66d}.package.fail{border-left-color:#ff929c}
.pkgrow{padding:12px 14px;cursor:pointer;list-style:none;user-select:none}
.pkgrow::-webkit-details-marker{display:none}
.pkgname{font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pkgprog{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dim)}
.pkgprog b{color:var(--text);font-weight:600}
.pkgprog i{height:6px;background:#354154;border-radius:999px;overflow:hidden;display:block}
.pkgprog em{display:block;height:100%;background:#78adff;border-radius:999px}
.pkgcur{font-size:12px;color:#b8c4d4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pkgagents{font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pkgbody{border-top:1px solid var(--line);padding:10px 14px 12px}
.pkgmeta{font-size:11px;color:var(--dim);margin-bottom:6px}
.subtask{border-top:1px dashed #222a33;padding:6px 0}
.subthead{display:flex;gap:8px;align-items:center;font-size:12px}
.sname{font-weight:600;color:var(--text)}
.smeta{margin-left:auto;font-size:11px;color:var(--dim)}
#pendingData{position:fixed;right:20px;bottom:20px;z-index:20;background:#1f6feb;color:#fff;border-color:#388bfd;box-shadow:0 4px 16px rgba(0,0,0,.35)}
@media(max-width:900px){.pkgcols{display:none}.pkgrow{grid-template-columns:1fr 90px}.pkgcur,.pkgagents{grid-column:1/-1}}
.att .rbody{padding:0 0 8px}
.sesschat{margin-top:6px}
.chatline{font-size:12px;line-height:1.5;color:#c9d1d9;border-top:1px dashed #222a33;padding:4px 0}
.chatline .role{font-size:10px;border:1px solid var(--line);border-radius:999px;padding:0 6px;margin-right:6px;color:var(--dim)}
.chatline .role.user{color:#78adff;border-color:#1f3b5c}
.chatline .role.assistant{color:#3fb950;border-color:#1d4d2b}
/* mission-control theme: neutral charcoal, low-saturation accents */
:root{--bg:#0b0d10;--panel:#14181d;--panel2:#101419;--line:#252b34;--text:#e7e9ee;--dim:#8b94a3;--ok:#65b87c;--warn:#d4a24c;--fail:#d16b6b;--none:#6b7280;--accent:#5b8def}
body{background:var(--bg)}
.appbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:18px;padding:16px 24px;background:rgba(11,13,16,.97);border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}
.brand{display:flex;gap:12px;align-items:center}
.logo{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#1b2a42;color:#7fa8ff;font-size:18px;border:1px solid #2b3b55}
.appbar h1{font-size:18px;margin:0 0 2px;letter-spacing:.2px}
.appbar .meta{font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70vw}
.appbar .refreshbox{margin-left:auto;display:flex;gap:14px;align-items:center;font-size:11px;color:var(--dim);white-space:nowrap}
.shell{max-width:1500px;margin:0 auto;padding:16px 24px 60px}
.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
.toolbar input{width:300px}
.toolbar select{min-width:120px}
.viewtoggle{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.viewtoggle button{border:0;border-radius:0;background:transparent;color:var(--dim);padding:6px 12px}
.viewtoggle button.on{background:#1c2532;color:var(--text)}
.dashboard{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:14px;align-items:start}
.maincol{min-width:0;display:flex;flex-direction:column;gap:14px}
.sidecol{display:flex;flex-direction:column;gap:14px;position:sticky;top:76px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.panelhead{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line)}
.panelhead h2{font-size:14px;margin:0;font-weight:600;display:flex;gap:8px;align-items:center}
.pico{color:#7fa8ff;font-size:12px}
.hint{color:var(--dim);font-size:11px;margin-left:auto}
.pill{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--dim);white-space:nowrap}
.agents-panel #agents{padding:12px}
.agentcards{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.agcard{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px 11px;min-width:0}
.agtop{display:flex;align-items:center;gap:8px;min-width:0}
.agicon{width:22px;height:22px;border-radius:7px;display:grid;place-items:center;background:#1b2533;color:#8db4ff;font-size:11px;flex:none}
.agname{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agstate{margin-left:auto;font-size:10px;border-radius:999px;padding:1px 6px;border:1px solid #2a3a2e;color:#65b87c;white-space:nowrap}
.agstate.off{color:var(--dim);border-color:var(--line)}
.agmetric{font-size:23px;font-weight:650;margin-top:9px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agsub{font-size:10px;color:var(--dim);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agbar{height:4px;background:#2a323d;border-radius:999px;overflow:hidden;margin-top:8px}
.agbar i{display:block;height:100%;background:#5b8def;border-radius:999px}
.tasks-panel .panelhead{border-bottom:0;padding-bottom:6px}
.tabs{display:flex;gap:6px;padding:0 14px 10px;flex-wrap:wrap}
.tabs button{border:1px solid transparent;background:transparent;color:var(--dim);padding:4px 9px;border-radius:7px;font-size:12px}
.tabs button.on{background:#1c2532;color:var(--text);border-color:var(--line)}
#list{padding:0 12px 12px}
.pkgcols,.pkgrow{grid-template-columns:minmax(180px,1.2fr) 96px minmax(200px,1.7fr) 132px 96px 74px 14px}
.pkgcols{display:grid;gap:10px;padding:7px 10px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
.package{background:transparent;border:0;border-bottom:1px solid #1d232b;border-radius:0;margin:0;border-left:2px solid transparent}
.package.fail{border-left-color:#a95555}.package.warn{border-left-color:#a27b3d}
.package[open]{background:#11161c}
.pkgrow{padding:11px 10px;display:grid;align-items:center;gap:10px}
.pkgname{font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px;min-width:0}
.pkgact{margin-left:auto;padding:2px 7px;font-size:10px;border:1px solid #3a434f;border-radius:6px;color:var(--dim);background:transparent;flex:none}
.pkgact:hover{color:var(--text);border-color:#5b8def}
.pkgprog b{font-size:11px}
.pkgprog em{background:#5b8def}
.pkgcur{font-size:11px}
.pkgfail{font-size:10px;color:#e08a8a;border:1px solid #573030;border-radius:999px;padding:1px 6px;margin-left:6px;white-space:nowrap}
.pkgagents{font-size:11px}
.pkgtime{font-size:10px;color:var(--dim);white-space:nowrap}
.pkgbody{padding:8px 12px 12px;background:#0f1318}
.subtask{border-top:1px solid #1d232b}
.sidecard{padding:13px 14px}
.sidehead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.sidehead h3{font-size:13px;margin:0;font-weight:600}
.sidehead .hint{font-size:10px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.stat{background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:9px}
.stat label{display:block;font-size:10px;color:var(--dim)}
.stat b{display:block;font-size:22px;line-height:1.2;margin-top:2px}
.stat small{font-size:10px;color:var(--dim)}
.archline{font-size:10px;color:var(--dim);border-top:1px solid #1d232b;padding-top:7px;margin-top:9px}
.curbox{border-left:2px solid #5b8def;padding-left:10px}
.curtitle{font-size:12px;font-weight:600;margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.currow{display:flex;gap:7px;align-items:center;font-size:11px;color:var(--dim);margin-top:5px}
.currow b{color:#b8c4d4;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:210px}
.alertrow{display:flex;gap:8px;align-items:center;padding:7px 0;border-top:1px solid #1d232b;font-size:11px}
.alertrow:first-of-type{border-top:0}
.alertname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c3cad5}
.alertmain{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.alertwhy{font-size:10px;color:#b77;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.alerttime{color:var(--dim);font-size:10px}
.failreason{font-size:10px;color:#d99;background:#1d1416;border:1px solid #3b2529;border-radius:6px;padding:5px 8px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.actrow{display:flex;gap:8px;padding:6px 0;border-top:1px solid #1d232b;font-size:11px;color:#b8c4d4}
.actrow:first-of-type{border-top:0}
.actdot{width:6px;height:6px;border-radius:50%;background:#65b87c;margin-top:5px;flex:none}
.actdot.fail{background:#d16b6b}.actdot.run{background:#5b8def}
.acttext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acttime{margin-left:auto;color:var(--dim);font-size:10px;white-space:nowrap}
.empty{padding:22px;text-align:center;color:var(--dim);font-size:12px}
#list.board{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;padding:10px}
#list.board .pkgcols{display:none}
#list.board .package{border:1px solid var(--line);border-radius:10px;border-left:2px solid #333b46}
#list.board .pkgrow{grid-template-columns:1fr auto;gap:7px}
#list.board .pkgcur,#list.board .pkgagents,#list.board .pkgtime{grid-column:1/-1}
#list.board .pkgprog{grid-column:1/-1}
@media(max-width:1180px){.dashboard{grid-template-columns:1fr}.sidecol{position:static;display:grid;grid-template-columns:repeat(2,1fr)}.agentcards{grid-template-columns:repeat(3,1fr)}}
@media(max-width:760px){.agentcards{grid-template-columns:1fr 1fr}.sidecol{grid-template-columns:1fr}.pkgcols{display:none}.pkgrow{grid-template-columns:1fr 90px}.pkgcur,.pkgagents,.pkgtime{grid-column:1/-1}}

.attn-panel,.progress-panel{margin-bottom:12px}
.attok{padding:14px 16px;color:#7ee2a8;font-size:13px}
.attitem{padding:10px 14px;border-top:1px solid #1d232b}.attitem:first-child{border-top:0}
.atthead{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.atttag{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid}
.atttag.lv0{color:#ffb86b;border-color:#6b4a1f;background:#241808}.atttag.lv1{color:#ff929c;border-color:#5c2a2e}.atttag.lv2{color:#c9a2a2;border-color:#3b2529}
.atttitle{font-weight:600;font-size:13px}
.attwhy{font-size:12px;color:#d9b3b3;margin-top:4px;white-space:normal;word-break:break-all}
.atthint{font-size:11px;color:var(--dim);margin-top:2px}
.decbody{white-space:pre-wrap;font-size:12px;background:#11161c;border:1px solid var(--line);border-radius:6px;padding:8px;margin:6px 0 0}
.tgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:10px;padding:10px;max-height:620px;overflow:auto}
.tcard{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--panel2)}
.thead{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.tname{font-weight:600;font-size:14px;flex:1;min-width:0}
.tpct{font-weight:700;color:var(--accent)}.ttime{font-size:11px;color:var(--dim)}
.tbar{height:5px;background:#222a33;border-radius:3px;margin:8px 0;overflow:hidden}.tbar i{display:block;height:100%;background:linear-gradient(90deg,#2f81f7,#3fb950)}
.stgs{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
.stg{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--line);color:var(--dim)}
.stg em{font-style:normal;opacity:.8}
.stg.ok{color:#7ee2a8;border-color:#1d4d2b}.stg.run{color:#8cc2ff;border-color:#1f3b5c;background:#0d1a2a}.stg.fail{color:#ff929c;border-color:#5c2a2e}
.tline{display:flex;gap:8px;font-size:12px;line-height:1.5;margin-top:4px;white-space:normal;word-break:break-all}
.tline small{display:block;color:var(--dim);font-size:11px}
.tlab{flex:none;font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 5px;height:18px;line-height:16px}
.tlab.run{color:#8cc2ff;border-color:#1f3b5c}.tlab.fail{color:#ff929c;border-color:#5c2a2e}
.tnotes{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:6px}
.notelink{font-size:11px;color:var(--accent);border:1px solid #1f3b5c;border-radius:4px;padding:0 6px;text-decoration:none}
.notelink:hover{background:#0d1a2a}
.agdays button{padding:2px 9px;font-size:12px;margin-left:4px}.agdays button.on{border-color:var(--accent);color:var(--accent)}
.agentcards{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))!important}
.agrole{font-size:10px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.agsub{white-space:normal!important;line-height:1.5}
.agwin{font-size:10px;color:var(--dim);margin-top:4px}
.agna{color:#8b8b8b}
.rstat.none,.att.none{opacity:.55}
</style>
</head>
<body>
<header class="appbar">
  <div class="brand"><div class="logo">◈</div><div><h1>Collab Board · 任务协作监控台</h1>
    <div class="meta"><span id="root"></span> · 数据生成 <span id="updated">--</span></div></div></div>
  <div class="refreshbox"><span class="rstate" id="refreshState">● 自动刷新</span><span id="refreshLast">上次成功 --</span><span id="refreshLatency">请求耗时 --</span></div>
</header>
<main class="shell">
  <div class="toolbar">
    <input id="q" placeholder="搜索：任务包 / prompt / reply / session">
    <select id="status"><option value="">全部状态</option><option>RUNNING</option><option>FAIL</option><option>OK</option><option>ACCEPTED</option><option>NO_RECEIPT</option><option>NO_REPLY</option><option>UNKNOWN</option><option>blocked</option></select>
    <select id="agent"><option value="">全部执行者</option><option>ExecB</option><option>ExecA</option><option>Codex</option><option>DSH</option><option>未知</option></select>
    <select id="pkgFilter"><option value="">全部任务包</option></select>
    <div class="viewtoggle"><button id="viewList" class="on">☰ 列表</button><button id="viewBoard">▦ 看板</button></div>
    <button id="refreshNow">刷新</button>
    <button id="archiveDone">归档已完成</button>
    <button id="archiveFailed">归档异常</button>
    <button id="archiveStale">归档过期等待</button>
    <button id="restoreArchived" hidden>恢复归档</button>
    <select id="autoEvery" title="自动刷新间隔"><option value="5000">自动刷新 5s</option><option value="10000" selected>自动刷新 10s</option><option value="30000">自动刷新 30s</option><option value="0">暂停自动刷新</option></select>
  </div>
  <div class="dashboard">
    <section class="maincol">
      <section class="panel attn-panel">
        <div class="panelhead"><h2><span class="pico">!</span> 需要你处理</h2><span class="hint" id="attnHint"></span></div>
        <div id="attn"><div class="empty">加载中…</div></div>
      </section>
      <section class="panel progress-panel">
        <div class="panelhead"><h2><span class="pico">▶</span> 任务进度</h2><span class="hint">Plan Map + 项目 STATE · 近 7 天 · 点笔记可直接查看</span></div>
        <div id="progress"><div class="empty">加载中…</div></div>
      </section>
      <section class="panel agents-panel">
        <div class="panelhead"><h2><span class="pico">▦</span> Agent 资源与状态</h2><span class="agdays"><button data-days="1" class="on">今日</button><button data-days="7">近 7 天</button></span></div>
        <div id="agents"><div class="empty">加载 Agent 用量…</div></div>
      </section>
      <section class="panel tasks-panel">
        <div class="panelhead"><h2><span class="pico">▤</span> 执行记录（任务包）</h2><span class="pill" id="count">0 个任务包</span></div>
        <div class="tabs" id="tabs"><button data-tab="all" class="on">全部</button><button data-tab="running">运行中</button><button data-tab="done">已完成</button><button data-tab="failed">异常</button><button data-tab="waiting">等待</button><button data-tab="archived">已归档</button></div>
        <div id="list"><div class="empty">加载中…</div></div>
      </section>
    </section>
    <aside class="sidecol">
      <section class="panel sidecard" id="todayCard"></section>
      <section class="panel sidecard" id="currentCard"></section>
      <section class="panel sidecard" id="alertsCard"></section>
      <section class="panel sidecard" id="activityCard"></section>
    </aside>
  </div>
  <button id="pendingData" hidden>有新数据 · 刷新</button>
  <section id="sessionsWrap" hidden>
    <div class="sechead">本机会话 <span class="gmeta">Codex / DSH / ExecA / Cursor · 最近 3 天</span>
      <select id="srcFilter"><option value="">全部来源</option><option>Codex</option><option>DSH</option><option>ExecA</option><option>Cursor</option></select>
      <span class="pill" id="scount">0 条</span>
    </div>
    <div id="sessions"></div>
  </section>
</main>
<script>
const state={rounds:[],workflows:[],archived:{},autoArchiveDone:false,open:new Map(),attOpen:new Map(),detailOpen:new Map(),kind:'',paused:false,tab:'all',view:'list',autoMs:10000,lastHash:'',lastWfHash:'',lastAgentHash:'',lastRenderAt:0,pendingRender:false,loading:false};
const list=document.getElementById('list'),q=document.getElementById('q'),st=document.getElementById('status'),ag=document.getElementById('agent');
const kindBtns=[...document.querySelectorAll('#kind button')];
const esc=s=>(s==null?'':String(s)).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const byId=id=>document.getElementById(id);

function statusKind(s){s=String(s||'').toLowerCase();
  if(s.includes('fail'))return 'failed';
  if(s.includes('running'))return 'running';
  if(s.includes('block')||s.includes('await')||s.includes('wait'))return 'blocked';
  if(s==='no_receipt'||s==='no_reply'||s==='unknown')return 'pending';
  return 'accepted';
}
function stClass(s){s=String(s||'').toLowerCase();
  if(s.includes('fail')||s==='blocked')return 'fail';
  if(s.includes('running')||s.includes('awaiting')||s.includes('wait')||s.includes('needs')||s==='no_receipt'||s==='no_reply'||s==='unknown')return 'warn';
  if(s==='warn')return 'warn';
  if(s==='superseded')return 'none';
  return 'ok';
}
function agentLabel(a){const m={dsh:'DSH',execa:'ExecA',codex:'Codex',execb:'ExecB'};return m[String(a||'').toLowerCase()]||a||'未知';}
function remoteBadge(r){
  if(!r)return '';
  const host=r.host||'';
  const label=host?'远端 '+host+(r.port?':'+r.port:''):'远端';
  return `<span class="rremote" title="${esc(r.path||'')}">${esc(label)}</span>`;
}
function agentMismatch(a){
  if(!a.assigned)return false;
  const actual=String(a.agent||'').toLowerCase().split(/\s*\+\s*/).map(x=>x.trim());
  return !actual.includes(String(a.assigned).toLowerCase());
}
function assignedBadge(a){
  if(!a||!agentMismatch(a))return '';
  return `<span class="rassigned" title="任务约定执行者">约定 ${esc(a.assigned)}</span>`;
}

function runAttempt(r){
  const intent=(r.prompt||r.title||'').split('\n').map(x=>x.trim()).find(Boolean)||'';
  const result=(r.reply||'').split('\n').map(x=>x.trim()).find(Boolean)||r.status;
  const tools=[r.tools,r.turns?r.turns+' turns':''].filter(Boolean).join(' · ');
  return {kind:'run',key:'run:'+r.dir,mtime:r.mtime||0,time:r.time,status:r.status,agent:r.agent,
    title:r.title||r.name,intent:intent.slice(0,220),result:result.slice(0,180),failure:r.reason||'',
    package:r.package||r.group||r.task||r.dir,packageTitle:r.package_title||r.package||r.group||r.task||r.dir,
    subtask:r.subtask||r.name,
    meta:[tools,r.dir].filter(Boolean).join(' · '),raw:r,group:r.group||r.task||r.dir,remote:r.remote||null,assigned:r.assigned||''};
}
function wfAttempt(w){
  const nodes=w.nodes||[];
  const first=nodes.map(n=>n.intent).find(Boolean)||w.goal||w.id;
  const fail=nodes.find(n=>n.status==='failed');
  const gate=(w.gates||[])[0];
  const result=fail&&fail.reason?('失败：'+fail.reason):(gate?`${gate.kind}: ${gate.status}${gate.reason?' · '+gate.reason:''}`:w.status);
  return {kind:'workflow',key:'wf:'+w.path,mtime:w.mtime||0,time:w.time,status:w.status,
    agent:[...new Set((w.agents||[]).map(agentLabel))].join(' + ')||'未知',
    title:w.title||w.id,intent:String(first).slice(0,220),result:String(result).slice(0,180),failure:fail&&fail.reason?String(fail.reason):'',
    package:w.package||w.group||w.id,packageTitle:w.package_title||w.package||w.group||w.id,
    subtask:w.subtask||w.id,
    meta:[nodes.length+' nodes',(w.gates||[]).length+' gates'].join(' · '),raw:w,group:w.group||w.id,remote:w.remote||null,assigned:w.assigned||''};
}
function runBody(r){
  const dop=k=>state.detailOpen.get(r.dir+'|'+k)?'open':'';
  const files=Object.entries(r.artifacts||{}).map(([k,v])=>`<a class="${v?'':'off'}" target="_blank" href="/file?path=${encodeURIComponent(r.dir+'/'+k)}">${k}</a>`).join('');
  const chips=[r.tools&&`tools ${r.tools}`,r.turns+' turns',r.session&&`session ${String(r.session).slice(0,8)}`,r.model,r.nonce&&`nonce ${r.nonce}`].filter(Boolean).map(c=>`<span class="chip">${esc(c)}</span>`).join('');
  return `<details class="sub" data-dk="${esc(r.dir)}|prompt" ${dop('prompt')}><summary>prompt（${r.prompt.length} 字）</summary><pre class="prompt">${esc(r.prompt)}</pre></details>
    <details class="sub" data-dk="${esc(r.dir)}|reply" ${dop('reply')}><summary>reply（${r.reply.length} 字）</summary><pre class="reply">${esc(r.reply)}</pre></details>
    <details class="sub" data-dk="${esc(r.dir)}|events" ${dop('events')}><summary>事件（最近 40 条）</summary><div class="events" data-dir="${esc(r.dir)}">点开加载…</div></details>
    <div class="tech">${chips}</div><div class="files">${files}</div>`;
}
function wfBody(w){
  const nodes=(w.nodes||[]).map(n=>`<div class="wfn"><span class="wfnid">${esc(n.id)}</span><span class="ragent">${esc(agentLabel(n.owner||n.provider))}</span><span class="wfnst ${stClass(n.status)}">${esc(n.status)}</span><span class="wfreason">${esc(n.reason||n.intent||'')}</span></div>`).join('');
  const gates=(w.gates||[]).map(g=>`<span class="wfgate">${esc(g.kind)}:${esc(g.status)}${g.reason?' · '+esc(g.reason):''}</span>`).join('');
  return `${w.goal?`<div class="tech">目标：${esc(w.goal)}</div>`:''}${nodes}${gates?`<div class="wfgates">${gates}</div>`:''}<div class="tech">revision ${esc(w.revision)} · ${esc(w.path)}</div>`;
}
function attemptCard(a){
  const open=state.attOpen.get(a.key)||false;
  return `<details class="att ${stClass(a.status)}" data-ak="${esc(a.key)}" ${open?'open':''}>
    <summary class="attsum">
      <span class="attline"><span class="rtype">${a.kind==='run'?'运行':'工作流'}</span><span class="ragent">${esc(a.agent)}</span>${remoteBadge(a.remote)}${assignedBadge(a)}<span class="rstat ${stClass(a.status)}"><i class="sdot"></i>${esc(a.status)}</span><span class="rtime">${esc(a.time)}</span><span class="rarrow">›</span></span>
      <span class="attintent">${esc(a.intent||'（无意图摘要）')}</span>
      <span class="attresult">${esc(a.result||'')}<span class="attmeta">${esc(a.meta)}</span></span>
    </summary>
    <div class="rbody">${a.kind==='run'?runBody(a.raw):wfBody(a.raw)}</div></details>`;
}
function buildPackages(){
  const map=new Map();
  const push=a=>{
    const pkg=a.package||'未归属';
    if(!map.has(pkg))map.set(pkg,{key:'pkg:'+pkg,package:pkg,title:a.packageTitle||pkg,attempts:[],subs:new Map()});
    const p=map.get(pkg);p.attempts.push(a);
    const sub=a.subtask||a.title||a.key;
    if(!p.subs.has(sub))p.subs.set(sub,[]);
    p.subs.get(sub).push(a);
  };
  state.rounds.forEach(r=>push(runAttempt(r)));
  state.workflows.forEach(w=>push(wfAttempt(w)));
  return [...map.values()].map(p=>{
    p.attempts.sort((a,b)=>a.mtime-b.mtime);
    p.subs=[...p.subs.entries()].map(([name,list])=>{
      list.sort((a,b)=>a.mtime-b.mtime);
      const latest=list[list.length-1];
      return {name,attempts:list,latest,status:latest.status,kind:statusKind(latest.status)};
    });
    p.done=p.subs.filter(s=>s.kind==='accepted').length;
    p.total=p.subs.length;
    p.pct=p.total?Math.round(p.done/p.total*100):null;
    p.current=p.attempts[p.attempts.length-1];
    p.time=p.current.time;p.mtime=p.current.mtime;
    p.primary=p.subs.some(s=>s.kind==='failed')?'FAIL':p.current.status;
    p.agents=[...new Set(p.attempts.map(a=>a.agent))];
    p.counts={accepted:0,failed:0,running:0,blocked:0,pending:0};
    p.attempts.forEach(a=>{p.counts[statusKind(a.status)]++});
    p.fails=p.attempts.filter(a=>statusKind(a.status)==='failed').length;
    p.lastFail=[...p.attempts].reverse().find(a=>statusKind(a.status)==='failed')||null;
    p.failReason=p.lastFail?(p.lastFail.failure||p.lastFail.result||'运行失败'):'';
    return p;
  });
}
function packageCard(p){
  const open=state.open.get(p.key)||false;
  const c=p.counts;
  const counts=[c.accepted&&`accepted ${c.accepted}`,c.failed&&`failed ${c.failed}`,c.running&&`running ${c.running}`,c.blocked&&`blocked ${c.blocked}`,c.pending&&`pending ${c.pending}`].filter(Boolean).join(' · ');
  const subtasks=p.subs.map(s=>`<div class="subtask"><div class="subthead"><span class="sname">${esc(s.name)}</span><span class="rstat ${stClass(s.status)}"><i class="sdot"></i>${esc(s.status)}</span><span class="smeta">${s.attempts.length} 次</span></div>${s.attempts.map(attemptCard).join('')}</div>`).join('');
  return `<details class="package ${stClass(p.primary)}" data-pk="${esc(p.key)}" ${open?'open':''}>
    <summary class="pkgrow">
      <span class="pkgname">${esc(p.title)}<button class="pkgact" data-${isArchived(p)?'restore':'archive'}-pkg="${esc(p.package)}">${isArchived(p)?'恢复':'归档'}</button></span>
      <span class="pkgprog"><b>${p.done}/${p.total}</b><i><em style="width:${p.pct||0}%"></em></i></span>
      <span class="pkgcur">当前：${esc(p.current.title||p.current.intent||'—')} ${p.fails?`<span class="pkgfail">失败 ${p.fails}</span>`:''}</span>
      <span class="pkgagents">${esc(p.agents.join(' + '))}</span>
      <span class="rstat ${stClass(p.primary)}"><i class="sdot"></i>${esc(p.primary)}</span>
      <span class="pkgtime">${esc(p.time||'')}</span>
      <span class="rarrow">›</span>
    </summary>
    <div class="pkgbody"><div class="pkgmeta">${esc(p.package)} · ${p.attempts.length} 次运行${counts?' · '+counts:''}${isArchived(p)?' · 已归档':''}</div>${p.failReason?`<div class="failreason">最近失败：${esc(p.failReason)}</div>`:''}${subtasks}</div>
  </details>`;
}
function sideHead(title,hint=''){return `<div class="sidehead"><h3>${esc(title)}</h3>${hint?`<span class="hint">${esc(hint)}</span>`:''}</div>`}
function isArchived(p){return !!state.archived[p.package]}
function isRecent(p){return p.mtime>Date.now()/1000-300}
function isStaleWaiting(p){return ['blocked','pending'].includes(statusKind(p.primary))&&p.mtime<Date.now()/1000-12*3600&&!isRecent(p)}
async function loadArchive(){
  try{const r=await fetch('/api/archive',{cache:'no-store'});const d=await r.json();state.archived=d.archived||{}}catch(e){state.archived={}}
}
async function archiveKeys(keys,reason){
  if(!keys.length)return;
  try{
    const r=await fetch('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'archive',keys:keys,reason:reason})});
    const d=await r.json();state.archived=d.archived||state.archived;
  }catch(e){}
  renderFeed(true);
}
async function restoreAll(){
  try{const r=await fetch('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'unarchive',keys:[]})});const d=await r.json();state.archived=d.archived||{}}catch(e){}
  renderFeed(true);
}
async function restoreKeys(keys){
  if(!keys.length)return;
  try{const r=await fetch('/api/archive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'unarchive',keys:keys})});const d=await r.json();state.archived=d.archived||{}}catch(e){}
  renderFeed(true);
}
async function autoArchive(){
  const all=buildPackages();
  const keys=all.filter(p=>!isArchived(p)&&statusKind(p.primary)==='accepted'&&p.done===p.total&&!isRecent(p)).map(p=>p.package);
  if(keys.length)await archiveKeys(keys,'auto');
}
function renderSidebar(all){
  const run=all.filter(p=>['running','pending'].includes(statusKind(p.primary))).sort((a,b)=>(statusKind(a.primary)==='running'?0:1)-(statusKind(b.primary)==='running'?0:1)||b.mtime-a.mtime);
  const fail=all.filter(p=>statusKind(p.primary)==='failed').sort((a,b)=>b.mtime-a.mtime);
  const done=all.filter(p=>statusKind(p.primary)==='accepted');
  const today=new Date().toLocaleDateString('zh-CN');
  byId('todayCard').innerHTML=sideHead('今日概况',today)+
    `<div class="stats"><div class="stat"><label>活跃任务</label><b>${run.length}</b><small>运行/等待</small></div>
     <div class="stat"><label>异常任务</label><b style="color:var(--fail)">${fail.length}</b><small>需处理</small></div>
     <div class="stat"><label>已验收</label><b style="color:var(--ok)">${done.length}</b><small>完成</small></div></div>
     <div class="archline">已归档 ${Object.keys(state.archived).length} 个任务包 · 不计入全部</div>`;
  const cur=run[0];
  const curStep=cur?String(cur.current.intent||cur.current.title||'—').replace(/\s+/g,' '):'';
  byId('currentCard').innerHTML=sideHead('当前协作',cur?`${run.length} 个活跃`:'空闲')+
    (cur?`<div class="curbox"><div class="curtitle">${esc(cur.title)}</div>
      <div class="currow"><span class="ragent">${esc(cur.agents.join(' + '))}</span><span class="rstat ${stClass(cur.primary)}"><i class="sdot"></i>${esc(cur.primary)}</span></div>
      <div class="currow"><span>当前：</span><b>${esc(curStep)}</b></div>
      <div class="currow"><span>更新：</span><b>${esc(cur.time||'')}</b></div></div>`:'<div class="empty">当前没有运行中的任务</div>');
  byId('alertsCard').innerHTML=sideHead('异常提醒',fail.length?`${fail.length} 个待处理`:'无')+
    (fail.slice(0,3).map(p=>`<div class="alertrow"><span class="rstat fail"><i class="sdot"></i></span><span class="alertmain"><span class="alertname">${esc(p.title)}</span><span class="alertwhy">${esc(p.failReason||'运行失败')}</span></span><span class="alerttime">${esc(p.time||'')}</span></div>`).join('')||'<div class="empty">没有异常</div>');
  const act=[...all].sort((a,b)=>b.mtime-a.mtime).slice(0,5);
  byId('activityCard').innerHTML=sideHead('最近动态','')+
    (act.map(p=>`<div class="actrow"><span class="actdot ${statusKind(p.primary)==='failed'?'fail':statusKind(p.primary)==='running'?'run':''}"></span><span class="acttext">${esc(p.title)} · ${esc(p.primary)}</span><span class="acttime">${esc(p.time||'')}</span></div>`).join('')||'<div class="empty">暂无动态</div>');
}
function renderFeed(force){
  if(!force&&window.scrollY>80){state.pendingRender=true;const b=byId('pendingData');if(b)b.hidden=false;return}
  state.pendingRender=false;const b=byId('pendingData');if(b)b.hidden=true;
  const term=q.value.trim().toLowerCase(),sf=st.value,af=ag.value,kf=state.kind,tab=state.tab||'all';
  const all=buildPackages();
  const activeAll=all.filter(p=>!isArchived(p));
  const archAll=all.filter(isArchived);
  const base=tab==='archived'?archAll:activeAll;
  const pf=byId('pkgFilter'),pkgKey=pf.value;
  const titles=[...new Set(base.map(p=>p.title))].sort((a,b)=>a.localeCompare(b));
  pf.innerHTML='<option value="">全部任务包</option>'+titles.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');
  pf.value=titles.includes(pkgKey)?pkgKey:'';
  const tabCount={all:activeAll.length,running:0,done:0,failed:0,waiting:0,archived:archAll.length};
  activeAll.forEach(p=>{const k=statusKind(p.primary);if(k==='running'||k==='pending')tabCount.running++;if(k==='accepted')tabCount.done++;if(k==='failed')tabCount.failed++;if(k==='blocked'||k==='pending')tabCount.waiting++;});
  const tabNames={all:'全部',running:'运行中',done:'已完成',failed:'异常',waiting:'等待',archived:'已归档'};
  byId('tabs').querySelectorAll('button').forEach(x=>{x.classList.toggle('on',x.dataset.tab===tab);x.textContent=`${tabNames[x.dataset.tab]} ${tabCount[x.dataset.tab]}`});
  byId('restoreArchived').hidden=tab!=='archived';
  let packages=base.filter(p=>{
    const k=statusKind(p.primary);
    if(tab==='running'&&!['running','pending'].includes(k))return false;
    if(tab==='done'&&k!=='accepted')return false;
    if(tab==='failed'&&k!=='failed')return false;
    if(tab==='waiting'&&!['blocked','pending'].includes(k))return false;
    if(kf&&!p.attempts.some(a=>a.kind===kf))return false;
    if(af&&!p.attempts.some(a=>a.agent===af))return false;
    if(sf&&String(p.primary).toLowerCase()!==sf.toLowerCase())return false;
    if(pf.value&&p.title!==pf.value)return false;
    if(!term)return true;
    const hay=[p.title,p.package,p.current.title,p.failReason,...p.attempts.flatMap(a=>[a.intent,a.result,a.failure,a.agent,a.title,a.subtask])].join(' ');
    return hay.toLowerCase().includes(term);
  });
  const rank=s=>{const k=statusKind(s);return k==='running'?0:k==='failed'?1:k==='blocked'?2:k==='pending'?3:4};
  packages.sort((a,b)=>rank(a.primary)-rank(b.primary)||b.mtime-a.mtime);
  byId('count').textContent=`${packages.length} 个${tab==='archived'?'已归档':'任务包'}`;
  renderSidebar(activeAll);renderAttention(activeAll);
  list.classList.toggle('board',state.view==='board');
  if(!packages.length){list.innerHTML='<div class="empty">没有匹配的任务包</div>';return}
  const forceOpen=!!term||!!sf||!!af||!!kf||!!pf.value;
  if(forceOpen)packages.forEach(p=>state.open.set(p.key,true));
  list.innerHTML='<div class="pkgcols"><span>任务包</span><span>进度</span><span>当前步骤</span><span>执行者</span><span>状态</span><span>更新时间</span><span></span></div>'+packages.map(packageCard).join('');
  state.lastRenderAt=Date.now();
}

function loadEvents(el){
  if(el.dataset.loaded)return;
  el.dataset.loaded='1';el.textContent='加载中…';
  fetch('/api/events?dir='+encodeURIComponent(el.dataset.dir)+'&limit=40').then(r=>r.json()).then(evs=>{
    el.innerHTML=evs.map(e=>`<div class="e"><span class="t">${esc(e.type)}${e.subtype?'/'+esc(e.subtype):''}</span> ${esc(e.text||'')}</div>`).join('')||'（无事件）';
  }).catch(()=>{el.textContent='加载失败'});
}

document.addEventListener('toggle',e=>{
  const el=e.target;if(!el.dataset)return;
  if(el.dataset.pk)state.open.set(el.dataset.pk,el.open);
  if(el.dataset.ak)state.attOpen.set(el.dataset.ak,el.open);
  if(el.dataset.dk){state.detailOpen.set(el.dataset.dk,el.open);if(el.open){const box=el.querySelector('.events');if(box)loadEvents(box)}}
  if(el.dataset.sk)sessOpen.set(el.dataset.sk,el.open);
},true);

q.addEventListener('input',()=>renderFeed(true));
st.addEventListener('change',()=>renderFeed(true));
ag.addEventListener('change',()=>renderFeed(true));
byId('pkgFilter').addEventListener('change',()=>renderFeed(true));
byId('tabs').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{state.tab=b.dataset.tab||'all';renderFeed(true)}));
byId('viewList').addEventListener('click',()=>{state.view='list';byId('viewList').classList.add('on');byId('viewBoard').classList.remove('on');renderFeed(true)});
byId('viewBoard').addEventListener('click',()=>{state.view='board';byId('viewBoard').classList.add('on');byId('viewList').classList.remove('on');renderFeed(true)});
byId('pendingData').addEventListener('click',()=>renderFeed(true));
list.addEventListener('click',e=>{
  const a=e.target.closest('[data-archive-pkg]'),r=e.target.closest('[data-restore-pkg]');
  if(a){e.preventDefault();e.stopPropagation();archiveKeys([a.dataset.archivePkg],'manual');return}
  if(r){e.preventDefault();e.stopPropagation();restoreKeys([r.dataset.restorePkg]);return}
});
const refresh={lastSuccess:0,latency:0,failed:false,refreshing:false};
byId('autoEvery').addEventListener('change',e=>{
  state.autoMs=parseInt(e.target.value,10)||0;
  state.paused=state.autoMs<=0;
  if(!state.paused)tick(true);
  scheduleTicker();
  updateRefresh();
});

async function tick(force){
  if(state.paused||state.loading)return;
  state.loading=true;refresh.refreshing=true;updateRefresh();
  const t0=performance.now();
  try{
    const res=await fetch('/api/rounds',{cache:'no-store'});
    const data=await res.json();
    if(!res.ok)throw new Error('http '+res.status);
    state.rounds=data.rounds;
    byId('root').textContent=data.root;
    byId('updated').textContent=data.generated_at;
    refresh.lastSuccess=Date.now();refresh.latency=performance.now()-t0;refresh.failed=false;
    if(!state.autoArchiveDone&&data.rounds.length){state.autoArchiveDone=true;autoArchive()}
    const hash=JSON.stringify(data.rounds.map(r=>[r.dir,r.status,r.package,r.subtask]));
    if(hash!==state.lastHash){state.lastHash=hash;state.pendingRender=true}
    if(state.pendingRender&&(force||Date.now()-state.lastRenderAt>8000)){
      state.pendingRender=false;renderFeed(false);
    }
  }catch(e){refresh.failed=true}
  finally{state.loading=false;refresh.refreshing=false;updateRefresh()}
}

function updateRefresh(){
  const s=byId('refreshState'),last=byId('refreshLast'),lat=byId('refreshLatency');
  s.className='rstate';
  if(state.paused){s.textContent='⏸ 已暂停自动刷新';s.classList.add('paused')}
  else if(refresh.refreshing){s.textContent='● 刷新中…'}
  else if(refresh.failed){s.textContent='⚠ 刷新失败 · 显示上次数据';s.classList.add('fail')}
  else{s.textContent=`● 自动刷新 · 每 ${Math.round((state.autoMs||10000)/1000)} 秒`}
  if(refresh.lastSuccess){
    const age=Math.max(0,Math.round((Date.now()-refresh.lastSuccess)/1000));
    last.textContent=`上次成功 ${new Date(refresh.lastSuccess).toLocaleTimeString('zh-CN',{hour12:false})}（${age} 秒前）`;
  }else{last.textContent='上次成功 --'}
  lat.textContent=refresh.latency?`请求耗时 ${Math.round(refresh.latency)}ms`:'请求耗时 --';
}

loadArchive().finally(()=>tick(true));
let refreshTimer=null;
function scheduleTicker(){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=state.autoMs>0?setInterval(()=>tick(false),state.autoMs):null}
scheduleTicker();
window.addEventListener('scroll',()=>{
  if(state.pendingRender&&window.scrollY<50){renderFeed(true)}
}, {passive:true});
window.addEventListener('focus',()=>tick(true));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick(true)});
byId('refreshNow').addEventListener('click',()=>tick(true));
byId('archiveDone').addEventListener('click',()=>{
  const keys=buildPackages().filter(p=>!isArchived(p)&&statusKind(p.primary)==='accepted'&&p.done===p.total).map(p=>p.package);
  archiveKeys(keys,'completed');
});
byId('archiveStale').addEventListener('click',()=>{
  const keys=buildPackages().filter(p=>!isArchived(p)&&isStaleWaiting(p)).map(p=>p.package);
  archiveKeys(keys,'stale-waiting');
});
byId('archiveFailed').addEventListener('click',()=>{
  const keys=buildPackages().filter(p=>!isArchived(p)&&statusKind(p.primary)==='failed'&&!isRecent(p)).map(p=>p.package);
  archiveKeys(keys,'failed');
});
byId('restoreArchived').addEventListener('click',()=>restoreAll());
ag.addEventListener('change',()=>renderFeed(true));
setInterval(updateRefresh,1000);updateRefresh();

function fmtToken(n){n=Number(n||0);if(n>=1e6)return (n/1e6).toFixed(2)+'M';if(n>=1e3)return (n/1e3).toFixed(1)+'k';return String(n)}
async function loadAgents(){
  try{
    const r=await fetch('/api/agents?days='+state.agentDays,{cache:'no-store'});
    if(!r.ok)throw new Error('http '+r.status);
    const d=await r.json();
    const rows=d.agents||[];
    const h=JSON.stringify(rows);
    if(h===state.lastAgentHash)return;
    state.lastAgentHash=h;
    const cards=rows.map(agentCard).join('');
    byId('agents').innerHTML=`<div class="agentcards">${cards}</div>`;
  }catch(e){byId('agents').innerHTML='<div class="empty">Agent 用量读取失败，重试中…</div>';setTimeout(loadAgents,3000)}
}

state.agentDays=1;state.tasks=null;state.lastTaskHash='';
function agentCard(a){
  const pct=(a.quota&&a.quota.primary!=null)?a.quota.primary:null;
  const T=fmtToken;let metric='—',sub='',role='',on=false;
  if(a.agent==='Codex / GPT'){role='主控';metric=pct!=null?pct+'%':T(a.input);on=pct!=null||a.input>0;
    sub=`5h 额度 ${pct??'?'}% · 周 ${a.quota?.secondary??'?'}%<br>入 ${T(a.input)} · 出 ${T(a.output)} · ${a.calls} 次`;}
  else if(a.agent==='ExecA'){role='执行';metric=T(a.input);on=a.calls>0;
    sub=`入 ${T(a.input)}（缓存 ${T(a.cached)}）· 出 ${T(a.output)}<br>${a.calls} 次请求 · ${a.sessions} 会话`;}
  else if(a.agent==='ExecB'){role='执行';on=a.sessions>0;metric=a.credits!=null?a.credits+' 积分':T(a.context_used);
    sub=`${a.requests||0} 次计费请求 · ${a.sessions} 会话<br>上下文峰值 ${T(a.context_used)} / ${T(a.context_size)}`;}
  else if(a.agent==='DSH'){role='执行';metric=T(a.input);on=a.calls>0;
    sub=`入 ${T(a.input)} · 缓存读 ${T(a.cached)} · 出 ${T(a.output)}<br>${a.calls} 次 · ${a.tools} 工具 · ${a.sessions} 会话`;}
  else if(a.agent==='Cursor'){role='执行';metric=a.sessions+' 会话';on=a.sessions>0;
    sub=`${a.calls} 消息 · ${a.tools} 工具${(a.models||[]).length?' · '+esc(a.models.join('/')):''}<br><span class="agna">token 本地不记录</span>`;}
  else if(a.agent==='HostC'){role='分析/迭代';metric=a.sessions+' 会话';on=a.sessions>0;
    sub=`${a.calls} 次回复 · ${a.tools} 次工具<br>${a.last_title?'最近：'+esc(a.last_title)+'<br>':''}<span class="agna">token 本地不记录</span>`;}
  return `<div class="agcard"><div class="agtop"><span class="agicon">${esc(a.agent.slice(0,2))}</span><span class="agname">${esc(a.agent)}</span>${role?`<span class="agrole">${role}</span>`:''}<span class="agstate ${on?'':'off'}">${on?'有活动':'无活动'}</span></div>
    <div class="agmetric">${esc(metric)}</div><div class="agsub">${sub}</div><div class="agwin">${esc(a.window||'')}</div>
    ${pct!=null?`<div class="agbar"><i style="width:${pct}%"></i></div>`:''}</div>`;
}
document.querySelectorAll('.agdays button').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();
  state.agentDays=Number(b.dataset.days);document.querySelectorAll('.agdays button').forEach(x=>x.classList.toggle('on',x===b));
  state.lastAgentHash='';loadAgents();}));
function noteLink(path,label){return `<a class="notelink" target="_blank" href="/note?path=${encodeURIComponent(path)}">${esc(label)}</a>`}
const PST={done:'ok',active:'run',blocked:'fail',pending:'none'};
const PSTN={done:'完成',active:'进行中',blocked:'卡住',pending:'未开始'};
function renderTasks(){
  const d=state.tasks;if(!d)return;
  const plans=(d.plans||[]).map(p=>{
    const pct=p.total?Math.round(p.done/p.total*100):0;
    const stages=(p.stages||[]).map(s=>`<span class="stg ${PST[s.status]||'none'}" title="${esc(s.note||'')}">${esc(s.title)}${s.total?` <em>${s.done}/${s.total}</em>`:''}</span>`).join('');
    const cur=(p.current||[]).map(c=>`<div class="tline"><span class="tlab run">正在做</span><span>${esc(c.title)}${c.note?`<small>${esc(c.note)}</small>`:''}</span></div>`).join('');
    const blk=(p.blocked||[]).map(c=>`<div class="tline"><span class="tlab fail">卡住</span><span>${esc(c.title)}${c.note?`<small>${esc(c.note)}</small>`:''}</span></div>`).join('');
    return `<div class="tcard"><div class="thead"><span class="tname">${esc(p.title)}</span><span class="tpct">${p.done}/${p.total}</span><span class="ttime">${esc(p.updated)}</span></div>
      <div class="tbar"><i style="width:${pct}%"></i></div><div class="stgs">${stages}</div>${cur}${blk}</div>`;
  }).join('');
  const states=(d.states||[]).map(s=>{
    const notes=(s.journal||[]).slice(0,6).map(j=>noteLink(j.path,j.name+' · '+j.time)).join('')+((s.journal||[]).length>6?`<span class="ttime">另 ${(s.journal||[]).length-6} 篇</span>`:'');
    return `<div class="tcard"><div class="thead"><span class="tname">${esc(s.project)} / ${esc(s.task)}</span>${noteLink(s.path,'STATE.md')}<span class="ttime">${esc(s.updated)}</span></div>
      ${s.current[0]?`<div class="tline"><span class="tlab run">现状</span><span>${esc(s.current[0])}</span></div>`:''}
      ${s.next[0]?`<div class="tline"><span class="tlab">下一步</span><span>${esc(s.next[0])}</span></div>`:''}
      ${notes?`<div class="tnotes"><span class="tlab">里程碑笔记</span>${notes}</div>`:''}</div>`;
  }).join('');
  byId('progress').innerHTML=(plans||states)?`<div class="tgrid">${plans}${states}</div>`:'<div class="empty">近 7 天没有任务计划</div>';
}
function renderAttention(activeAll){
  const items=[];const d=state.tasks||{};
  (d.states||[]).forEach(s=>(s.decisions||[]).forEach(x=>items.push({lv:0,tag:'需要你决定',title:x.title,body:`<pre class="decbody">${esc(x.body)}</pre>`,src:noteLink(x.source,'来源')})));
  (d.plans||[]).forEach(p=>(p.blocked||[]).forEach(b=>items.push({lv:1,tag:'卡住',title:p.title+' · '+b.title,body:b.note?`<div class="attwhy">${esc(b.note)}</div>`:'',src:''})));
  const recent=(activeAll||buildPackages()).filter(p=>statusKind(p.primary)==='failed'&&p.mtime>Date.now()/1000-3*86400);
  recent.slice(0,5).forEach(p=>items.push({lv:2,tag:'执行异常',title:p.title,body:`<div class="attwhy">${esc(p.failReason||'运行失败')}</div><div class="atthint">主控会先自行处理；同一原因两次失败才会找你</div>`,src:`<span class="ttime">${esc(p.time||'')}</span>`}));
  items.sort((a,b)=>a.lv-b.lv);
  const running=(d.plans||[]).reduce((n,p)=>n+(p.current||[]).length,0);
  byId('attnHint').textContent=items.length?`${items.length} 项`:'';
  byId('attn').innerHTML=items.length?items.map(i=>`<div class="attitem lv${i.lv}"><div class="atthead"><span class="atttag lv${i.lv}">${i.tag}</span><span class="atttitle">${esc(i.title)}</span>${i.src}</div>${i.body}</div>`).join('')
    :`<div class="attok">没有需要你处理的事 · ${running} 个步骤进行中，主控在推进</div>`;
}
async function loadTasks(){
  try{const r=await fetch('/api/tasks',{cache:'no-store'});if(!r.ok)return;const d=await r.json();
    const h=JSON.stringify([d.plans,d.states]);if(h===state.lastTaskHash)return;state.lastTaskHash=h;state.tasks=d;
    renderTasks();renderAttention(null);}catch(e){}
}
loadTasks();setInterval(loadTasks,15000);
loadAgents();setInterval(loadAgents,30000);

async function loadWorkflows(){
  try{
    const r=await fetch('/api/workflows',{cache:'no-store'});
    if(!r.ok)throw new Error('http '+r.status);
    const d=await r.json();
    state.workflows=d.workflows||[];
    const h=JSON.stringify(state.workflows.map(w=>[w.id,w.status,(w.nodes||[]).map(n=>n.status),(w.gates||[]).map(g=>g.status)]));
    if(h!==state.lastWfHash){state.lastWfHash=h;renderFeed(false)}
  }catch(e){}
}
loadWorkflows();setInterval(loadWorkflows,10000);

const sessionsBtn=byId('sessionsBtn'),sessionsWrap=byId('sessionsWrap'),sessionsBox=byId('sessions'),srcFilter=byId('srcFilter');
let sessionsCache=null,sessionsHash='',sessOpen=new Map();
async function loadSessions(force){
  if(!force&&sessionsCache&&Date.now()-sessionsCache.at<4000)return;
  try{
    const r=await fetch('/api/sessions',{cache:'no-store'});
    const d=await r.json();
    const h=JSON.stringify(d.sessions.map(s=>[s.path,s.msgs,s.mtime,s.title]));
    if(!force&&h===sessionsHash){sessionsCache={...d,at:Date.now()};return}
    sessionsHash=h;
    sessionsCache={...d,at:Date.now()};
    renderSessions();
  }catch(e){sessionsBox.innerHTML='<div class="empty">加载失败</div>'}
}
function renderSessions(){
  if(!sessionsCache)return;
  const f=srcFilter.value;
  const rows=sessionsCache.sessions.filter(s=>!f||s.source===f);
  byId('scount').textContent=rows.length+' 条';
  if(!rows.length){sessionsBox.innerHTML='<div class="empty">没有会话</div>';return}
  sessionsBox.innerHTML=rows.map(s=>{
    const folder=s.cwd?String(s.cwd).split('\\').slice(-1)[0]:'';
    return `<div class="sess">
      <div class="shead"><span class="src ${esc(s.source)}">${esc(s.source)}</span>
        <span class="stime">${esc(s.time||'-')}</span>
        <span class="stitle">${esc(s.title)}</span>
        <span class="smeta">${esc(s.model||'')}${folder?' · '+esc(folder):''}${s.msgs?' · '+s.msgs+' 条':''}</span></div>
      <details data-sk="${esc(s.path)}" ${sessOpen.get(s.path)?'open':''}><summary>最后回复 / 路径</summary><pre>${esc(s.last||'（无）')}</pre><div class="spath">${esc(s.path)}</div></details>
      ${(s.recent&&s.recent.length)?`<details class="sesschat"><summary>最近对话（${s.recent.length} 条）</summary>${s.recent.map(m=>`<div class="chatline"><span class="role ${m.role}">${m.role==='user'?'你':'GPT'}</span>${esc(m.text)}</div>`).join('')}</details>`:''}
    </div>`;
  }).join('');
}
if(sessionsBtn)sessionsBtn.addEventListener('click',()=>{sessionsWrap.hidden=!sessionsWrap.hidden;if(!sessionsWrap.hidden)loadSessions(true)});
srcFilter.addEventListener('change',renderSessions);
setInterval(()=>{if(!sessionsWrap.hidden&&!state.paused)loadSessions(false)},5000);
</script>
</body>
</html>'''


_usage_cache = {'at': 0.0, 'data': None}
_rounds_cache = {'at': 0.0, 'key': None, 'data': None}
_wf_cache = {'at': 0.0, 'data': None}
_agents_cache = {}
_tasks_cache = {'at': 0.0, 'data': None}


def agents_payload(days=1):
    now = time.time()
    days = 7 if days == 7 else 1
    entry = _agents_cache.setdefault(days, {'at': 0.0, 'data': None})
    if entry['data'] is None or now - entry['at'] > 10:
        entry['data'] = agent_usage.scan(days=days)
        entry['at'] = now
    return entry['data']


def workflows_payload():
    now = time.time()
    if _wf_cache['data'] is None or now - _wf_cache['at'] > 15:
        _wf_cache['data'] = workflow_scanner.scan(days=3)
        _wf_cache['at'] = now
    return {'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'workflows': _wf_cache['data']}


def usage_payload():
    now = time.time()
    if _usage_cache['data'] is None or now - _usage_cache['at'] > 10:
        sessions = token_meter.scan()
        _usage_cache['data'] = token_meter.summarize(sessions, days=2, recent=8)
        _usage_cache['at'] = now
    return _usage_cache['data']


def rounds_cached(roots):
    now = time.time()
    key = tuple(str(r) for r in roots)
    if (_rounds_cache['data'] is None or now - _rounds_cache['at'] > 8 or _rounds_cache['key'] != key):
        _rounds_cache['data'] = mark_superseded([parse_round(d, r) for d, r in collect_all(roots)])
        _rounds_cache['at'] = now
        _rounds_cache['key'] = key
    return _rounds_cache['data']


def make_handler(roots):
    roots = [r.resolve() for r in roots]
    open_roots = [*roots, task_progress.PLAN_ROOT, PROJECTS_ROOT]

    def inside(path: Path) -> bool:
        try:
            path = path.resolve()
        except Exception:
            return False
        for root in roots:
            try:
                path.relative_to(root)
                return True
            except Exception:
                continue
        return False

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _json(self, payload, code=200):
            body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _html(self, html: str):
            body = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'")
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _static(self, path: Path, ctype: str):
            data = path.read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            if ctype.startswith('text/html'):
                self.send_header('Content-Security-Policy', "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'")
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            u = urlparse(self.path)
            if u.path == '/api/open':
                if 'application/json' not in (self.headers.get('Content-Type') or ''):
                    self._json({'error': 'json only'}, 415)
                    return
                try:
                    length = int(self.headers.get('Content-Length') or 0)
                    payload = json.loads(self.rfile.read(length) or b'{}')
                except Exception:
                    payload = {}
                self._json({'ok': board_api.open_folder(str(payload.get('path') or ''), open_roots)})
                return
            if u.path != '/api/archive':
                self.send_response(404)
                self.end_headers()
                return
            try:
                length = int(self.headers.get('Content-Length') or 0)
                payload = json.loads(self.rfile.read(length) or b'{}')
            except Exception:
                payload = {}
            action = str(payload.get('action') or '')
            keys = [str(k) for k in (payload.get('keys') or []) if str(k).strip()]
            if action == 'archive':
                task_archive.archive(keys, str(payload.get('reason') or 'manual'))
            elif action == 'unarchive':
                task_archive.unarchive(keys or None)
            elif action != 'list':
                self._json({'error': 'unknown action'}, 400)
                return
            self._json({'ok': True, 'archived': task_archive.load()})

        def do_GET(self):
            u = urlparse(self.path)
            qs = parse_qs(u.query)
            if u.path in board_api.PAGES:
                self._static(board_api.UI_DIR / board_api.PAGES[u.path], 'text/html; charset=utf-8')
                return
            if u.path.startswith('/ui/'):
                name = u.path[4:]
                p = board_api.UI_DIR / name
                if '/' in name or '\\' in name or not p.is_file() or p.suffix not in ('.css', '.js'):
                    self.send_response(404)
                    self.end_headers()
                    return
                self._static(p, 'text/css; charset=utf-8' if p.suffix == '.css' else 'text/javascript; charset=utf-8')
                return
            if u.path == '/classic':
                self._html(PAGE)
                return
            if u.path == '/api/feed':
                rounds = rounds_cached(roots)
                if _tasks_cache['data'] is None or time.time() - _tasks_cache['at'] > 10:
                    _tasks_cache['data'] = task_progress.scan()
                    _tasks_cache['at'] = time.time()
                items = board_api.feed(rounds)
                board_api.assign_tasks(items, rounds, (_tasks_cache['data'] or {}).get('states', []))
                self._json({'items': items})
                return
            if u.path == '/api/detail':
                dir_path = Path(qs.get('dir', [''])[0])
                if not inside(dir_path):
                    self._json({'error': 'outside roots'}, 403)
                    return
                key = str(dir_path)
                cached = _rounds_cache.get('data') or []
                hit = next((r for r in cached if r['dir'] == key), None)
                if hit is None:
                    root = next(r for r in roots if str(dir_path.resolve()).startswith(str(r)))
                    hit = parse_round(dir_path, root)
                self._json(board_api.detail(hit))
                return
            if u.path == '/api/meta':
                srcs = [{'label': '执行记录 · ' + r.name, 'path': str(r)} for r in roots]
                srcs.append({'label': 'Plan Map 计划数据', 'path': str(task_progress.PLAN_ROOT)})
                for s in (_tasks_cache.get('data') or task_progress.scan()).get('states', [])[:6]:
                    srcs.append({'label': '项目状态 · %s/%s' % (s['project'], s['task']), 'path': str(Path(s['path']).parent)})
                self._json({'sources': srcs})
                return
            if u.path == '/api/rounds':
                rounds = rounds_cached(roots)
                self._json({'root': ' | '.join(str(r) for r in roots), 'count': len(rounds),
                            'generated_at': time.strftime('%Y-%m-%d %H:%M:%S'), 'rounds': rounds})
                return
            if u.path == '/api/sessions':
                self._json(session_scanner.scan_all())
                return
            if u.path == '/api/usage':
                self._json(usage_payload())
                return
            if u.path == '/api/workflows':
                self._json(workflows_payload())
                return
            if u.path == '/api/agents':
                try:
                    days = int(qs.get('days', ['1'])[0])
                except ValueError:
                    days = 1
                self._json(agents_payload(days))
                return
            if u.path == '/api/tasks':
                now = time.time()
                if _tasks_cache['data'] is None or now - _tasks_cache['at'] > 10:
                    _tasks_cache['data'] = task_progress.scan()
                    _tasks_cache['at'] = now
                self._json(_tasks_cache['data'])
                return
            if u.path == '/note':
                try:
                    p = Path(qs.get('path', [''])[0]).resolve()
                    p.relative_to(PROJECTS_ROOT.resolve())
                    ok = p.is_file() and p.suffix.lower() == '.md' and (p.name == 'STATE.md' or p.parent.name == 'journal')
                except Exception:
                    ok = False
                if not ok:
                    self._json({'error': 'not allowed'}, 403)
                    return
                data = p.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if u.path == '/api/archive':
                self._json({'archived': task_archive.load()})
                return
            if u.path == '/api/events':
                dir_path = Path(qs.get('dir', [''])[0])
                if not inside(dir_path):
                    self._json({'error': 'outside roots'}, 403)
                    return
                try:
                    limit = int(qs.get('limit', ['40'])[0])
                except Exception:
                    limit = 40
                self._json(parse_events(dir_path, max(1, min(limit, 200))))
                return
            if u.path == '/file':
                raw = qs.get('path', [''])[0]
                p = Path(raw)
                try:
                    p = p.resolve()
                except Exception:
                    p = None
                if p is None or not inside(p):
                    self._json({'error': 'outside roots'}, 403)
                    return
                if not p.is_file() or p.suffix.lower() not in ALLOWED_SUFFIXES:
                    self._json({'error': 'not allowed'}, 404)
                    return
                data = p.read_bytes()
                ctype = 'application/json; charset=utf-8' if p.suffix.lower() == '.json' else (
                    'text/plain; charset=utf-8' if p.suffix.lower() in {'.md', '.ndjson', '.log', '.txt'} else 'image/png')
                self.send_response(200)
                self.send_header('Content-Type', ctype)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_response(404)
            self.end_headers()

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--roots', default=','.join(str(p) for p in DEFAULT_ROOTS),
                    help='comma-separated run roots (default: outputs)')
    ap.add_argument('--root', default='', help='single root override')
    ap.add_argument('--port', type=int, default=18765)
    ap.add_argument('--host', default='127.0.0.1')
    args = ap.parse_args()
    if args.root:
        roots = [Path(args.root)]
    else:
        roots = [Path(part.strip()) for part in args.roots.split(',') if part.strip()]
    roots = [r for r in roots if r.exists()]
    if not roots:
        print('no existing roots: ' + args.roots)
        return 2
    httpd = ThreadingHTTPServer((args.host, args.port), make_handler(roots))
    threading.Thread(target=session_scanner.scan_all, daemon=True).start()
    threading.Thread(target=token_meter.scan, daemon=True).start()
    threading.Thread(target=lambda: collect_all(roots), daemon=True).start()
    print(f'collab dashboard: http://{args.host}:{args.port}/  (roots: {", ".join(str(r) for r in roots)})')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    raise SystemExit(main())
