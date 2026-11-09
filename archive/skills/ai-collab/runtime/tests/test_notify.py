"""notify lane: per-item Windows toast behaviour. All OS-facing calls are
stubbed (injected `send`), so no real toast / subprocess is ever shown.
No AI is started and nothing outside a TemporaryDirectory is written.
"""
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import collab_dashboard  # noqa: E402
import notify  # noqa: E402


def item(i, kind='decide', title='标题', task='xinshi.planmap', task_title='Plan Map 改造'):
    return {'id': i, 'kind': kind, 'title': title, 'task': task, 'task_title': task_title}


class Harness:
    def __init__(self, tmp):
        self.tmp = Path(tmp)
        self.sent = []
        self.data = None
        self.clock = datetime(2026, 11, 5, 12, 0)  # noon: outside any quiet window
        self.n = notify.Notifier(
            data_dir=self.tmp,
            send=lambda t, b, u: self.sent.append((t, b, u)),
            fetch=lambda: self.data,
            now=lambda: self.clock,
        )

    def set_items(self, items):
        self.data = {'items': items, 'counts': {}}


class NotifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.h = Harness(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    # 1. first launch only records, never pops
    def test_first_run_only_records(self):
        self.h.set_items([item('ask:1'), item('done:p1'), item('fail:p2')])
        self.h.n.poll_once()
        self.assertEqual(self.h.sent, [])
        self.assertEqual(self.h.n.notified, {'ask:1', 'done:p1', 'fail:p2'})
        self.assertTrue((Path(self.tmp.name) / 'notified.json').is_file())

    # 2. only a newly added id produces a toast
    def test_new_id_pops(self):
        self.h.set_items([item('ask:1')])
        self.h.n.poll_once()  # first run, no pop
        self.assertEqual(self.h.sent, [])
        self.h.set_items([item('ask:1'), item('ask:2')])
        self.h.n.poll_once()
        self.assertEqual(len(self.h.sent), 1)
        self.assertTrue(self.h.sent[0][2].endswith('#ask:2'))

    # 3. the same id is only ever popped once
    def test_same_id_only_once(self):
        self.h.n.first_run = False
        self.h.set_items([item('ask:1')])
        for _ in range(4):
            self.h.n.poll_once()
        self.assertEqual(len(self.h.sent), 1)

    # 4. quiet hours: record only, then one summary when the window ends
    def test_quiet_records_then_one_summary(self):
        (Path(self.tmp.name) / 'notify.json').write_text(
            json.dumps({'quiet_hours': ['23:00', '08:00']}), encoding='utf-8')
        self.h.clock = datetime(2026, 11, 5, 23, 30)
        self.h.set_items([item('ask:1')])
        self.h.n.poll_once()  # first run during quiet: record only
        self.assertEqual(self.h.sent, [])
        self.h.set_items([item('ask:1'), item('ask:2'), item('ask:3')])
        for _ in range(3):
            self.h.n.poll_once()
        self.assertEqual(self.h.sent, [])  # still no pop while quiet
        self.assertEqual(self.h.n.notified, {'ask:1', 'ask:2', 'ask:3'})
        self.assertEqual(self.h.n.quiet_pending, 2)
        self.h.clock = datetime(2026, 11, 6, 8, 5)  # quiet ended
        self.h.n.poll_once()
        self.assertEqual(len(self.h.sent), 1)
        self.assertIn('安静时段结束', self.h.sent[0][1])
        self.assertEqual(self.h.n.quiet_pending, 0)

    # 5. a failing toast call must never crash the board
    def test_toast_failure_does_not_crash(self):
        self.h.n.first_run = False
        self.h.set_items([item('ask:1')])
        self.h.n.send = mock.Mock(side_effect=RuntimeError('powershell boom'))
        self.h.n.poll_once()  # _safe_send swallows it
        self.assertEqual(self.h.n.notified, {'ask:1'})
        with mock.patch.object(notify.subprocess, 'run', side_effect=OSError('no exe')):
            self.assertFalse(notify.send_toast('t', 'b', 'http://x'))
        with mock.patch.object(notify.subprocess, 'run',
                               return_value=mock.Mock(returncode=1)):
            self.assertFalse(notify.send_toast('t', 'b', 'http://x'))

    # 6. disabled switch: config off and CLI off both suppress notifications
    def test_disabled_config_no_toast(self):
        (Path(self.tmp.name) / 'notify.json').write_text(
            json.dumps({'enabled': False}), encoding='utf-8')
        self.h.n.first_run = False
        self.h.set_items([item('ask:1')])
        self.h.n.poll_once()
        self.assertEqual(self.h.sent, [])

    def test_start_disabled_spawns_nothing(self):
        self.assertIsNone(notify.start(enabled=False))

    # extra: kinds filter, titles/body, inbox fallback, config defaults
    def test_titles_body_and_kinds(self):
        self.h.n.first_run = False
        self.h.set_items([item('a', 'decide'), item('b', 'fail'), item('c', 'done')])
        self.h.n.poll_once()
        self.assertEqual([s[0] for s in self.h.sent],
                         ['需要你决定', '失败', '完成 · 待验收'])
        self.assertIn('‹ Plan Map 改造', self.h.sent[0][1])

    def test_kinds_filter(self):
        (Path(self.tmp.name) / 'notify.json').write_text(
            json.dumps({'kinds': ['decide']}), encoding='utf-8')
        self.h.n.first_run = False
        self.h.set_items([item('a', 'decide'), item('b', 'fail')])
        self.h.n.poll_once()
        self.assertEqual(len(self.h.sent), 1)
        self.assertEqual(self.h.n.notified, {'a', 'b'})

    def test_inbox_unavailable_is_silent_skip(self):
        self.h.n.first_run = False
        self.h.set_items(None)
        self.h.n.fetch = lambda: None
        self.h.n.poll_once()
        self.assertEqual(self.h.sent, [])

    def test_collect_inbox_http_fallback(self):
        with mock.patch.dict(sys.modules, {'inbox': None}):
            with mock.patch.object(notify.urllib.request, 'urlopen',
                                   side_effect=OSError('no server')):
                self.assertIsNone(notify.collect_inbox(18765))
            resp = mock.MagicMock()
            resp.read.return_value = json.dumps(
                {'items': [item('ask:1')]}).encode('utf-8')
            resp.__enter__.return_value = resp
            with mock.patch.object(notify.urllib.request, 'urlopen',
                                   return_value=resp):
                data = notify.collect_inbox(18765)
            self.assertEqual(len(data['items']), 1)
            self.assertEqual(data['items'][0]['id'], 'ask:1')

    def test_default_config(self):
        cfg = notify.load_config(Path(self.tmp.name) / 'missing.json')
        self.assertTrue(cfg['enabled'])
        self.assertIsNone(cfg['quiet_hours'])
        self.assertEqual(cfg['kinds'], ['decide', 'ms', 'fail', 'done'])

    def test_toast_xml_escapes_and_links(self):
        xml = notify.toast_xml('A & B', '<x>', 'http://h/console#ask:1')
        self.assertIn('A &amp; B', xml)
        self.assertIn('&lt;x&gt;', xml)
        self.assertIn('http://h/console#ask:1', xml)

    def test_dashboard_no_notify_flag(self):
        for extra, expected in ((['--no-notify'], False), ([], True)):
            with self.subTest(extra=extra):
                with tempfile.TemporaryDirectory() as d:
                    fake_httpd = mock.MagicMock()
                    with mock.patch.object(collab_dashboard, 'ThreadingHTTPServer',
                                           return_value=fake_httpd), \
                         mock.patch.object(collab_dashboard.threading, 'Thread'), \
                         mock.patch.object(notify, 'start') as start, \
                         mock.patch.object(collab_dashboard, 'package_discovery'), \
                         mock.patch.object(collab_dashboard, 'quota_service'), \
                         mock.patch.object(collab_dashboard, 'userdata'), \
                         mock.patch.object(sys, 'argv',
                                           ['collab_dashboard.py', *extra, '--root', d]), \
                         mock.patch('builtins.print'):
                        rc = collab_dashboard.main()
                    self.assertEqual(rc, 0)
                    start.assert_called_once_with(port=18765, enabled=expected)


if __name__ == '__main__':
    unittest.main()
