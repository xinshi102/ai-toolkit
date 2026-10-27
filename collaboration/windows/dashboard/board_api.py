"""Light-weight API + page routes for the redesigned board (board_ui/).

Mounted by collab_dashboard.py. Read-only except /api/open (opens an allowed
data folder in Explorer, local machine only).
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

UI_DIR = Path(__file__).resolve().parent / 'board_ui'
PAGES = {'/': 'calm.html', '/calm': 'calm.html'}

WORDS = {
    'fix': '修复', 'review': '审查', 'plan': '方案', 'dryrun': '演练', 'publish': '发布', 'finalize': '定稿',
    'evidence': '证据', 'closeout': '收尾', 'production': '生产', 'ready': '就绪', 'acceptance': '验收',
    'package': '打包', 'milestone': '里程碑', 'install': '安装', 'entry': '入口', 'unified': '统一',
    'return': '退回', 'revise': '修订', 'restore': '恢复', 'docs': '文档', 'version': '版本', 'parent': '父目录',
    'cwd': '工作目录', 'release': '发布', 'installer': '安装器', 'preflight': '预检', 'correct': '更正',
    'execute': '执行', 'prepare': '准备', 'offline': '离线', 'display': '展示', 'distribution': '分布',
    'scoring': '评分', 'migration': '迁移', 'refresh': '刷新', 'cleanup': '清理', 'test': '测试', 'tests': '测试',
    'preserve': '保留', 'source': '来源', 'null': '空值', 'time': '时间', 'access': '访问', 'code': '代码',
    'quality': '质量', 'smoke': '冒烟', 'stall': '卡住', 'model': '模型', 'deploy': '部署', 'deployed': '已部署',
    'pilot': '试点', 'doc': '文档', 'hook': '钩子', 'html': 'HTML', 'kb': '知识库', 'skill': '技能',
    'export': '导出', 'upload': '上传', 'threshold': '阈值', 'calibration': '校准', 'stage': '阶段',
    'complete': '补齐', 'implementation': '实现', 'branch': '支线', 'exporter': '导出器', 'media': '媒体',
    'integrate': '集成', 'accept': '验收', 'resume': '续跑', 'http': 'HTTP', 'finalize': '定稿', 'ops': '运维',
    'rehearsal': '彩排', 'gate': '闸门', 'live': '上线', 'handoff': '交接', 'sync': '同步', 'check': '检查',
    'audit': '审计', 'apply': '应用', 'rollback': '回滚', 'backup': '备份', 'index': '索引', 'search': '检索',
    'normalize': '规范化', 'dup': '判重', 'duplicate': '判重', 'score': '评分', 'recompute': '重算',
    'vector': '向量', 'vectors': '向量', 'embed': '向量化', 'samples': '样本', 'label': '标注', 'labels': '标注',
    'ui': '界面', 'page': '页面', 'board': '看板', 'run': '运行', 'package': '打包', 'pkg': '包', 'main': '主线',
    'quality': '质量', 'execa': '', 'wecom': '企微', 'continuation': '接续', 'continue': '接续',
}


def humanize(slug: str) -> str:
    """'skill141-stage2-review-fix' -> 'Skill 1.4.1 · 阶段2 审查修复'."""
    s = str(slug or '').strip()
    if not s or re.search(r'[\u4e00-\u9fff]', s):
        return s
    parts = [p for p in re.split(r'[-_\s]+', s) if p]
    head, words = [], []
    for p in parts:
        low = p.lower()
        m = re.fullmatch(r'skill(\d)(\d)(\d)', low)
        if m:
            head.append('Skill %s.%s.%s' % m.groups())
            continue
        m = re.fullmatch(r'(stage|wp|d|s|p|c)(\d+)', low)
        if m:
            words.append({'stage': '阶段', 'wp': 'WP', 'd': 'D', 's': 'S', 'p': 'P', 'c': 'C'}[m.group(1)] + m.group(2))
            continue
        m = re.fullmatch(r'([a-z]+)(\d+)', low)
        if m and m.group(1) in WORDS:
            words.append(WORDS[m.group(1)] + m.group(2))
            continue
        w = WORDS.get(low, p)
        if w:
            words.append(w)
    text = ''.join(w if re.search(r'[\u4e00-\u9fff]$', w) and i + 1 < len(words) and re.match(r'[\u4e00-\u9fff]', words[i + 1]) else w + ' '
                   for i, w in enumerate(words)).strip()
    return ' · '.join([*head, text] if text else head) or s


def _sentence(text: str, limit: int = 90) -> str:
    for line in str(text or '').splitlines():
        line = re.sub(r'^[#>*\-\s\d.、]+', '', line).strip().strip('*').strip()
        if len(line) >= 4:
            line = re.split(r'(?<=[。；;！!？?])', line)[0]
            return line[:limit] + ('…' if len(line) > limit else '')
    return ''


STATE = {'OK': 'ok', 'ACCEPTED': 'ok', 'UNREVIEWED': 'ok', 'WARN': 'warn', 'FAIL': 'bad', 'RUNNING': 'run',
         'SUPERSEDED': 'gone', 'NO_RECEIPT': 'idle', 'NO_REPLY': 'idle', 'UNKNOWN': 'idle'}
LABEL = {'ok': '完成', 'warn': '完成·有告警', 'bad': '失败', 'run': '运行中', 'gone': '已接替', 'idle': '中断'}


def _agent(r):
    a = r.get('assigned') or r.get('agent') or ''
    if a and a != '未知':
        return a
    hay = (r.get('dir') or '').lower() + ' ' + (r.get('model') or '').lower()
    for k, v in (('execb', 'ExecB'), ('execa', 'ExecA'), ('dsh', 'DSH'), ('codex', 'Codex'), ('cursor', 'Cursor')):
        if k in hay:
            return v
    return '未知'


CONTROLLER = {'codex': 'GPT', 'hostc': 'HostC', 'dsh': 'DSH', 'cursor': 'Cursor', 'shared': 'GPT'}


def _owner(dir_path: str):
    """(project, controller) from Projects/<Host>/<project>/... ."""
    parts = Path(dir_path).parts
    low = [p.lower() for p in parts]
    if 'projects' not in low:
        return '', ''
    i = low.index('projects')
    host = parts[i + 1] if i + 1 < len(parts) else ''
    proj = parts[i + 2] if i + 2 < len(parts) else ''
    return proj, CONTROLLER.get(host.lower(), host)


def _clean_state_title(s):
    label = re.sub(r'[（(]\s*\d{4}-\d{2}-\d{2}\s*[)）]', '', str(s.get('title') or ''))
    label = re.sub(r'[:：]?\s*接续状态.*$', '', label).strip()
    return label or s.get('task') or ''


def assign_tasks(items, rounds, states):
    """Attach 'task' to each feed row = same controller + same project.
    Label = the most recently updated STATE.md of that project (falls back to the project folder name).
    Deliberately coarse: package ids are not reliably mentioned in STATE/journal, so per-package matching
    split one task into several groups (2026-10-27)."""
    newest = {}
    for s in states or []:
        proj, _c = _owner(s.get('path') or '')
        if proj and (proj not in newest or (s.get('mtime') or 0) > (newest[proj].get('mtime') or 0)):
            newest[proj] = s
    for it in items:
        st = newest.get(it.get('project') or '')
        it['task'] = (_clean_state_title(st) if st else '') or it.get('project') or '未归类'
    return items


def feed(rounds: list, days: int = 7) -> list:
    """One row per package; packages taken over by a later continuation are marked 'gone' (history)."""
    cutoff = time.time() - days * 86400
    out = []
    for last in rounds:
        if (last.get('mtime') or 0) < cutoff:
            continue
        st = STATE.get(last.get('status'), 'idle')
        key = last.get('task_id') or last.get('name')
        items = [last]
        result = _sentence(last.get('reply')) if st in ('ok', 'warn') else (last.get('reason') or _sentence(last.get('reply')))
        project, controller = _owner(last['dir'])
        out.append({
            'id': key, 'dir': last['dir'], 'title': humanize(key), 'raw': key,
            'project': project, 'controller': controller,
            'parent': humanize(last.get('continuation_of')) if last.get('continuation_of') else '',
            'status': st, 'label': LABEL[st], 'summary': (result or '')[:140],
            'agent': _agent(last), 'model': last.get('model') or '',
            'steps': len(items), 'attempts': sum(int(x.get('attempts') or 1) for x in items),
            'mtime': last.get('mtime') or 0, 'time': last.get('time') or '',
            'tokens': sum(int(x.get('tokens_in') or 0) for x in items),
            'duration': sum(int(x.get('duration') or 0) for x in items),
        })
    out.sort(key=lambda x: x['mtime'], reverse=True)
    return out[:120]


def detail(r: dict) -> dict:
    d = Path(r['dir'])
    files = [p.name for p in sorted(d.iterdir()) if p.is_file() and p.suffix in ('.md', '.json', '.txt')] if d.exists() else []
    st = STATE.get(r.get('status'), 'idle')
    return {'title': humanize(r.get('task_id') or r['name']), 'raw': r.get('task_id') or r['name'], 'dir': r['dir'],
            'status': st, 'label': LABEL[st], 'reason': r.get('reason') or '',
            'agent': _agent(r), 'model': r.get('model') or '',
            'time': r.get('time') or '', 'turns': r.get('turns'), 'attempts': r.get('attempts') or 1,
            'tokens_in': r.get('tokens_in'), 'tokens_out': r.get('tokens_out'), 'duration': r.get('duration'),
            'continuation_of': r.get('continuation_of') or '', 'session': r.get('session') or '',
            'prompt': r.get('prompt') or '', 'reply': r.get('reply') or '', 'files': files}


def open_folder(path: str, allowed: list) -> bool:
    try:
        p = Path(path).resolve()
    except Exception:
        return False
    if not p.exists():
        return False
    for a in allowed:
        try:
            p.relative_to(Path(a).resolve())
            os.startfile(str(p if p.is_dir() else p.parent))  # noqa: S606 - local tool, allow-listed roots only
            return True
        except Exception:
            continue
    return False
