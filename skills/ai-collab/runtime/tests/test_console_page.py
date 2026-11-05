"""console lane: /console page structure + HTTP smoke.

The visual standard is board_ui/mock/console-v4.html. Regions are separated by
28px whitespace only, never by border divider lines; the shortcut table and the
v4 layout behaviour (collapse-to-zero, edge pull-out, keys, localStorage) come
straight from the approved sample.
"""
from __future__ import annotations

import json
import re
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen

RUNTIME = Path(__file__).resolve().parents[1]
if str(RUNTIME) not in sys.path:
    sys.path.insert(0, str(RUNTIME))

import board_api  # noqa: E402
import board_page  # noqa: E402
import board_routes  # noqa: E402

UI = RUNTIME / 'board_ui'


class ConsoleHtmlStructureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (UI / 'console.html').read_text(encoding='utf-8')
        cls.js = (UI / 'console.js').read_text(encoding='utf-8')

    def test_required_regions_exist(self):
        # four panes, the two columns, the edge handles, the hero and the drawer
        for rid in ('shell', 'cL', 'cR', 'tree', 'res', 'inbox', 'det',
                    'eL', 'eT', 'eB', 'hero', 'help', 'list', 'ol', 'mm',
                    'mmsvg', 'resb', 'detBody', 'toast', 'veil', 'drawer',
                    'dwT', 'dwB', 'th', 'hp'):
            self.assertIn('id="%s"' % rid, self.html, rid)

    def test_shortcut_table_has_all_keys(self):
        table = re.search(r'<table[^>]*>.*?</table>', self.html, re.S)
        self.assertIsNotNone(table, 'a shortcut <table> is required')
        for key in ('[', 'i', 'd', 'r', 'f', '0', '?'):
            self.assertIn('<kbd>%s</kbd>' % key, table.group(0), key)

    def test_no_border_divider_lines(self):
        # v4 separates regions with 28px whitespace, never with border lines.
        self.assertIn('--gap:28px', self.html)
        for bad in ('border-left', 'border-right', 'border-top'):
            self.assertNotIn(bad, self.html, bad)
        self.assertIsNone(
            re.search(r'class="[^"]*\b(divider|separator|sep-line|vline|hline)\b',
                      self.html, re.I))
        # the structural layout classes must not declare any border line
        border_decl = re.compile(r'(?:^|;)\s*border(?:-(?:left|right|top|bottom))?\s*:', re.S)
        for cls in ('shell', 'col', 'pane', 'gut', 'edge', 'cedge'):
            for m in re.finditer(r'\.' + cls + r'\b[^{]*\{([^}]*)\}', self.html):
                self.assertIsNone(border_decl.search(m.group(1)), cls)

    def test_console_route_is_registered(self):
        rendered = board_page.render('/console')
        self.assertIsNotNone(rendered)
        data, ctype, csp = rendered
        self.assertIn(b'<title>', data)
        self.assertTrue(ctype.startswith('text/html'))
        self.assertIn("connect-src 'self'", csp)
        self.assertIn(b'/ui/console.js', data)

    def test_board_api_pages_left_untouched(self):
        # registration lives in board_page, so the M4 exact-PAGES test stays green
        self.assertEqual(board_api.PAGES, {'/': 'calm.html', '/calm': 'calm.html'})

    def test_console_js_contract(self):
        for marker in ('/api/tree', '/api/inbox', '/api/quota', '/api/detail',
                       '/api/inbox/act', "localStorage.getItem('console-v4')",
                       '已发给 GPT，继续中', "setInterval(()=>{if(!document.hidden)loadAll()},10000)",
                       'console-theme', 'window.__mm=mm', 'syncAmberHint'):
            self.assertIn(marker, self.js, marker)


class ConsoleHttpSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name) / 'runs'
        cls.root.mkdir()
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), board_routes.make_handler([cls.root]))
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        cls.tmp.cleanup()

    def get(self, path):
        with urlopen('http://127.0.0.1:%d%s' % (self.port, path), timeout=10) as resp:
            return resp.status, resp.read()

    def test_console_returns_200(self):
        status, body = self.get('/console')
        self.assertEqual(status, 200)
        self.assertIn(b'<title>', body)
        self.assertIn(b'/ui/console.js', body)

    def test_console_asset_is_served(self):
        status, body = self.get('/ui/console.js')
        self.assertEqual(status, 200)
        self.assertIn(b'/api/tree', body)

    def test_quota_endpoint_still_works(self):
        status, body = self.get('/api/quota')
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body), list)


if __name__ == '__main__':
    unittest.main()
