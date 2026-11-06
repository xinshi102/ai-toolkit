"""notify lane: per-item Windows desktop toasts for the collab board.

The board process starts one daemon thread (``start``) that polls the inbox
every ``POLL_SECONDS``.  Item ids are compared against ``notified.json``; each
newly seen id produces exactly one native Windows toast (never a merged
notification).  The first poll after a fresh install only records ids, so a
boot does not replay a pile of historical items.

All OS-facing work is funnelled through small injectable helpers (``fetch``,
``send``, ``now``) so the test suite never shows a real window.  PowerShell
uses ``Windows.UI.Notifications`` (no third-party dependency); any failure
degrades to a log line and must never take the board down.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

import userdata

log = logging.getLogger('collab.notify')

POLL_SECONDS = 10
DEFAULT_PORT = 18765

KINDS = ('decide', 'ms', 'fail', 'done')
KIND_TITLE = {
    'decide': '需要你决定',
    'ms': '里程碑完成',
    'fail': '失败',
    'done': '完成 · 待验收',
}
SUMMARY_TITLE = '新事项'
DEFAULT_CONFIG = {'enabled': True, 'quiet_hours': None, 'kinds': list(KINDS)}

# A registered AppUserModelID (Windows PowerShell) so a toast can be raised
# from a script without installing a dedicated app.
_PS_AUMID = r'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
_PS_TOAST = r'''$ErrorActionPreference = 'Stop'
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($env:NOTIFY_XML)
    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:NOTIFY_AUMID).Show($toast)
    exit 0
} catch {
    exit 1
}
'''


# ---------------------------------------------------------------------------
# config / persisted state
# ---------------------------------------------------------------------------
def config_path(data_dir=None) -> Path:
    return Path(data_dir) / 'notify.json' if data_dir else userdata.data_dir() / 'notify.json'


def notified_path(data_dir=None) -> Path:
    return Path(data_dir) / 'notified.json' if data_dir else userdata.data_dir() / 'notified.json'


def _hm(value):
    try:
        h, m = str(value).split(':')
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def _valid_quiet(qh) -> bool:
    return (isinstance(qh, (list, tuple)) and len(qh) == 2
            and _hm(qh[0]) is not None and _hm(qh[1]) is not None)


def in_quiet(now=None, quiet_hours=None) -> bool:
    """Whether ``now`` falls in the quiet window (wraps midnight if needed)."""
    if not _valid_quiet(quiet_hours):
        return False
    now = now or datetime.now()
    cur = now.hour * 60 + now.minute
    start, end = _hm(quiet_hours[0]), _hm(quiet_hours[1])
    if start == end:
        return False
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end


def load_config(path=None) -> dict:
    """Read notify.json, falling back to defaults; never raises."""
    cfg = dict(DEFAULT_CONFIG)
    cfg['kinds'] = list(KINDS)
    try:
        p = Path(path) if path else config_path()
        raw = json.loads(p.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return cfg
    if not isinstance(raw, dict):
        return cfg
    if 'enabled' in raw:
        cfg['enabled'] = bool(raw['enabled'])
    if 'quiet_hours' in raw:
        qh = raw['quiet_hours']
        cfg['quiet_hours'] = qh if _valid_quiet(qh) else None
    if 'kinds' in raw and isinstance(raw['kinds'], list):
        cfg['kinds'] = [k for k in KINDS if k in raw['kinds']]
    return cfg


def load_notified(path=None) -> set:
    try:
        p = Path(path) if path else notified_path()
        raw = json.loads(p.read_text(encoding='utf-8'))
        if isinstance(raw, list):
            return {str(x) for x in raw}
    except (OSError, ValueError):
        pass
    return set()


def save_notified(ids, path=None) -> None:
    p = Path(path) if path else notified_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + '.tmp')
    tmp.write_text(json.dumps(sorted(ids), ensure_ascii=False), encoding='utf-8')
    os.replace(tmp, p)


# ---------------------------------------------------------------------------
# inbox source (optional inbox module, else HTTP fallback)
# ---------------------------------------------------------------------------
def _normalize(data):
    """Extract the item list from a raw inbox payload; None means 'skip'."""
    if isinstance(data, dict):
        raw = data.get('items')
    elif isinstance(data, list):
        raw = data
    else:
        return None
    if not isinstance(raw, list):
        return None
    return [it for it in raw if isinstance(it, dict) and it.get('id')]


def _http_inbox(port):
    url = 'http://127.0.0.1:%s/api/inbox' % port
    with urllib.request.urlopen(url, timeout=3) as resp:
        return json.loads(resp.read().decode('utf-8'))


def collect_inbox(port=DEFAULT_PORT):
    """Return the raw inbox payload, or None on any failure (caller skips)."""
    try:
        import inbox  # optional, owned by the inbox lane
    except ImportError:
        inbox = None
    try:
        return inbox.collect() if inbox is not None else _http_inbox(port)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# toast (PowerShell / Windows.UI.Notifications)
# ---------------------------------------------------------------------------
def toast_xml(title, body, url) -> str:
    """Build escaped toast XML; protocol activation opens ``url`` on click."""
    u = quoteattr(str(url))
    t = escape(str(title))
    b = escape(str(body))
    return ('<toast launch=%s activationType="protocol">'
            '<visual><binding template="ToastGeneric">'
            '<text>%s</text><text>%s</text>'
            '</binding></visual>'
            '<actions><action activationType="protocol" arguments=%s content="打开"/></actions>'
            '</toast>') % (u, t, b, u)


def _creationflags():
    # CREATE_NO_WINDOW keeps the PowerShell/msg child from flashing a console.
    return getattr(subprocess, 'CREATE_NO_WINDOW', 0)


def _fallback(title, body) -> None:
    """Best effort after a toast failure: try `msg`, then only write a log."""
    text = '%s: %s' % (title, body)
    try:
        subprocess.run(['msg', '*', '/TIME:5', text], creationflags=_creationflags(),
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        pass
    log.warning('toast unavailable; logged instead: %s', text)


def send_toast(title, body, url) -> bool:
    """Show one native Windows toast. Never raises; False when unavailable."""
    env = dict(os.environ)
    env['NOTIFY_XML'] = toast_xml(title, body, url)
    env['NOTIFY_AUMID'] = _PS_AUMID
    try:
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', _PS_TOAST],
            env=env, creationflags=_creationflags(),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=20,
        )
        if result.returncode == 0:
            return True
    except Exception as exc:
        log.warning('toast subprocess failed: %s', exc)
    _fallback(title, body)
    return False


# ---------------------------------------------------------------------------
# notifier
# ---------------------------------------------------------------------------
class Notifier:
    def __init__(self, data_dir=None, port=DEFAULT_PORT, send=None, fetch=None, now=None):
        self.data_dir = Path(data_dir) if data_dir else userdata.data_dir()
        self.config_file = self.data_dir / 'notify.json'
        self.notified_file = self.data_dir / 'notified.json'
        self.console_url = 'http://127.0.0.1:%s/console' % port
        self.send = send or send_toast
        self.fetch = fetch or (lambda: collect_inbox(port))
        self.now = now or (lambda: datetime.now())
        self.notified = load_notified(self.notified_file)
        # A missing notified.json means a fresh install: record, never replay.
        self.first_run = not self.notified_file.exists()
        self.quiet_pending = 0
        self.was_quiet = False

    def _save(self):
        save_notified(self.notified, self.notified_file)

    def _kind_enabled(self, item, cfg):
        return str(item.get('kind') or '') in cfg['kinds']

    def _safe_send(self, title, body, url):
        try:
            return self.send(title, body, url)
        except Exception as exc:
            log.warning('toast failed: %s', exc)
            return False

    def _emit_item(self, item):
        kind = str(item.get('kind') or '')
        title = KIND_TITLE.get(kind, SUMMARY_TITLE)
        item_title = str(item.get('title') or '')
        task = str(item.get('task_title') or item.get('task') or '')
        body = ('%s ‹ %s' % (item_title, task)).strip() if task else item_title
        self._safe_send(title, body, self.console_url + '#' + str(item['id']))

    def _emit_summary(self, count):
        body = '安静时段结束，共 %d 条新事项 · 点击查看收件箱' % count
        self._safe_send(SUMMARY_TITLE, body, self.console_url)

    def poll_once(self):
        cfg = load_config(self.config_file)
        if not cfg['enabled']:
            return
        try:
            raw = self.fetch()
        except Exception as exc:
            log.warning('inbox fetch failed: %s', exc)
            return
        items = _normalize(raw)
        if items is None:
            return  # inbox unavailable this tick: silent skip

        quiet = in_quiet(self.now(), cfg['quiet_hours'])

        if self.first_run:
            self.notified = {str(it['id']) for it in items}
            self._save()
            self.first_run = False
            self.was_quiet = quiet
            self.quiet_pending = 0
            return  # only record on the first poll

        # quiet just ended -> one summary for everything suppressed meanwhile
        if self.was_quiet and not quiet and self.quiet_pending:
            self._emit_summary(self.quiet_pending)
            self.quiet_pending = 0
        self.was_quiet = quiet

        new_items = [it for it in items if str(it['id']) not in self.notified]
        for it in new_items:
            self.notified.add(str(it['id']))
            if not self._kind_enabled(it, cfg):
                continue
            if quiet:
                self.quiet_pending += 1
                continue
            self._emit_item(it)
        if new_items:
            self._save()

    def run_forever(self):
        while True:
            try:
                self.poll_once()
            except Exception as exc:
                log.warning('notify poll failed: %s', exc)
            time.sleep(POLL_SECONDS)


def start(port=DEFAULT_PORT, enabled=True):
    """Start the polling daemon thread; no-op (and no thread) when disabled."""
    if not enabled:
        return None
    notifier = Notifier(port=port)
    thread = threading.Thread(target=notifier.run_forever, daemon=True, name='collab-notify')
    thread.start()
    return thread
