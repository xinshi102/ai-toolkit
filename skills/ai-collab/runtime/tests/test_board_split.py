"""M4 (3): collab_dashboard.py split into data / routes / page; HTTP smoke."""
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import board_api
import board_data
import board_page
import board_routes
import collab_dashboard


class SplitModulesTest(unittest.TestCase):
    def test_modules_expose_the_three_parts(self):
        self.assertTrue(callable(board_data.parse_round))
        self.assertTrue(callable(board_data.rounds_cached))
        self.assertTrue(callable(board_routes.make_handler))
        self.assertTrue(callable(board_page.render))

    def test_entry_point_is_a_thin_shell(self):
        self.assertTrue(callable(collab_dashboard.main))
        source = (Path(__file__).resolve().parents[1] / 'collab_dashboard.py').read_text(encoding='utf-8')
        self.assertNotIn('def parse_round', source)
        self.assertNotIn('def make_handler', source)
        self.assertIn('board_routes.make_handler', source)

    def test_pages_are_served_from_board_ui(self):
        rendered = board_page.render('/')
        self.assertIsNotNone(rendered)
        data, ctype, csp = rendered
        self.assertIn(b'<title>', data)
        self.assertTrue(ctype.startswith('text/html'))
        self.assertIn("connect-src 'self'", csp)
        self.assertEqual(board_api.PAGES['/calm'], 'calm.html')
        self.assertIsNone(board_page.render('/classic'))
        self.assertIsNone(board_page.render('/v/a'))
        self.assertIsNone(board_page.render('/ui/missing.js'))

    def test_static_assets_render_without_csp_header(self):
        rendered = board_page.render('/ui/common.css')
        self.assertIsNotNone(rendered)
        self.assertEqual(rendered[1], 'text/css; charset=utf-8')
        self.assertEqual(rendered[2], '')

    def test_calm_html_features_are_preserved(self):
        html = (Path(__file__).resolve().parents[1] / 'board_ui' / 'calm.html').read_text(encoding='utf-8')
        for marker in ('const groups=[]', '最近动作', 'id="drawer"',
                       '/api/archive', 'setTheme', 'data-theme'):
            self.assertIn(marker, html, marker)


class BoardHttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.prev_data = os.environ.get('AI_COLLAB_DATA')
        os.environ['AI_COLLAB_DATA'] = str(Path(cls.tmp.name) / 'data')
        cls.root = Path(cls.tmp.name) / 'runs'
        cls.root.mkdir()
        cls.run_dir = cls.root / 'pkg-sample'
        cls.run_dir.mkdir()
        (cls.run_dir / 'request.json').write_text(
            json.dumps({'task_id': 'M4-SAMPLE-TASK', 'prompt': '目标：抽查看板'}), encoding='utf-8')
        (cls.run_dir / 'receipt.json').write_text(
            json.dumps({'exit_code': 0, 'task_state': 'succeeded'}), encoding='utf-8')
        (cls.run_dir / 'reply.md').write_text('完成。', encoding='utf-8')
        (cls.run_dir / 'stdout.ndjson').write_text(
            '{"type":"system","subtype":"init","session_id":"s1","model":"m1"}\n', encoding='utf-8')
        board_data._rounds_cache.update({'data': None, 'key': None})
        board_data._tasks_cache.update({'data': None, 'at': 0.0})
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), board_routes.make_handler([cls.root]))
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=5)
        if cls.prev_data is None:
            os.environ.pop('AI_COLLAB_DATA', None)
        else:
            os.environ['AI_COLLAB_DATA'] = cls.prev_data
        cls.tmp.cleanup()

    def get(self, path):
        with urlopen('http://127.0.0.1:%d%s' % (self.port, path), timeout=10) as resp:
            return resp.status, resp.read()

    def test_home_and_calm_pages(self):
        for path in ('/', '/calm'):
            status, body = self.get(path)
            self.assertEqual(status, 200)
            self.assertIn(b'<title>', body)

    def test_removed_routes_are_404(self):
        for path in ('/classic', '/v/a', '/s/1'):
            with self.assertRaises(HTTPError) as ctx:
                self.get(path)
            self.assertEqual(ctx.exception.code, 404)

    def test_api_feed(self):
        status, body = self.get('/api/feed')
        self.assertEqual(status, 200)
        self.assertIn('items', json.loads(body))

    def test_api_tasks(self):
        status, body = self.get('/api/tasks')
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body), dict)

    def test_api_rounds_and_meta(self):
        status, body = self.get('/api/rounds')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['count'], 1)
        status, body = self.get('/api/meta')
        self.assertEqual(status, 200)
        self.assertIn('sources', json.loads(body))

    def test_api_detail(self):
        status, body = self.get('/api/detail?dir=' + quote(str(self.run_dir)))
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload['raw'], 'M4-SAMPLE-TASK')

    def test_api_archive(self):
        status, body = self.get('/api/archive')
        self.assertEqual(status, 200)
        self.assertIn('archived', json.loads(body))

    def test_api_events(self):
        status, body = self.get('/api/events?dir=' + quote(str(self.run_dir)))
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body), list)


if __name__ == '__main__':
    unittest.main()
