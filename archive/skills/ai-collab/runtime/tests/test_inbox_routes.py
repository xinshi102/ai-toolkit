"""车道 inbox：GET /api/inbox 与 POST /api/inbox/act 的路由接入与安全约束。

不真起 HTTP 服务：用 object.__new__ 造一个不带 socket 的 Handler，直接调
do_GET / do_POST，捕获 _json 的返回。
"""
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import board_api  # noqa: E402
import board_routes  # noqa: E402
import board_page  # noqa: E402
import eventlog  # noqa: E402
import inbox  # noqa: E402


class RouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.root = base / 'roots'
        self.root.mkdir()
        self.env = mock.patch.dict(os.environ, {'AI_COLLAB_DATA': str(base / 'data')})
        self.env.start()
        eventlog.reset_cache()
        inbox.set_roots([self.root])

    def tearDown(self):
        inbox.set_roots(None)
        self.env.stop()
        eventlog.reset_cache()
        self.tmp.cleanup()

    def pkg(self, name, ok=True):
        d = self.root / name
        d.mkdir()
        (d / 'spec.json').write_text(json.dumps({'task_id': name, 'cwd': str(d),
                                                 'prompt': '目标：完成 ' + name}), encoding='utf-8')
        (d / 'receipt.json').write_text(json.dumps({'ok': ok, 'exit_code': 0 if ok else 1}),
                                        encoding='utf-8')
        (d / 'stdout.ndjson').write_text('', encoding='utf-8')
        return d

    def handler(self, path='/api/inbox/act', client='127.0.0.1', body=b'{}',
                content_type='application/json', length=None):
        Handler = board_routes.make_handler([self.root])
        h = object.__new__(Handler)
        h.path = path
        h.client_address = (client, 12345)
        h.headers = {'Content-Type': content_type,
                     'Content-Length': str(len(body) if length is None else length)}
        h.rfile = io.BytesIO(body)
        h.wfile = io.BytesIO()
        h.responses = []
        h._json = lambda payload, code=200: h.responses.append((code, payload))
        h._asset = lambda *a: None
        h.send_response = lambda *a, **k: None
        h.send_header = lambda *a, **k: None
        h.end_headers = lambda: None
        return h

    # ---- POST /api/inbox/act ----
    def test_post_rejects_non_local(self):
        h = self.handler(client='10.0.0.5')
        with mock.patch.object(inbox, 'act') as act:
            h.do_POST()
        self.assertEqual(h.responses[0][0], 403)
        act.assert_not_called()

    def test_post_requires_json_content_type(self):
        h = self.handler(content_type='text/plain')
        with mock.patch.object(inbox, 'act') as act:
            h.do_POST()
        self.assertEqual(h.responses[0][0], 415)
        act.assert_not_called()

    def test_post_rejects_body_over_16kb(self):
        h = self.handler(body=b'{}', length=inbox.MAX_BODY + 1)
        with mock.patch.object(inbox, 'act') as act:
            h.do_POST()
        self.assertEqual(h.responses[0][0], 413)
        act.assert_not_called()

    def test_post_rejects_text_over_2000(self):
        body = json.dumps({'id': 'done:x', 'choice': 'A', 'text': '字' * 2001}).encode('utf-8')
        h = self.handler(body=body)
        with mock.patch.object(inbox, 'act') as act:
            h.do_POST()
        self.assertEqual(h.responses[0][0], 413)
        act.assert_not_called()

    def test_post_passes_id_choice_text_to_act(self):
        body = json.dumps({'id': 'done:x', 'choice': 'A', 'text': 'ok'}).encode('utf-8')
        h = self.handler(body=body)
        with mock.patch.object(inbox, 'act',
                               return_value={'ok': True, 'next': 'accepted', 'package': None}) as act:
            h.do_POST()
        self.assertEqual(h.responses[0][0], 200)
        self.assertEqual(h.responses[0][1]['next'], 'accepted')
        act.assert_called_once_with('done:x', 'A', 'ok')

    def test_post_end_to_end_done_accept(self):
        self.pkg('d')
        body = json.dumps({'id': 'done:d', 'choice': 'A', 'text': None}).encode('utf-8')
        h = self.handler(body=body)
        h.do_POST()
        self.assertEqual(h.responses[0][0], 200)
        self.assertEqual(h.responses[0][1]['next'], 'accepted')
        self.assertIn('d', json.loads(inbox.accepted_path().read_text(encoding='utf-8')))

    def test_post_bad_json_does_not_crash(self):
        h = self.handler(body=b'{not json')
        with mock.patch.object(inbox, 'act') as act:
            h.do_POST()
        self.assertEqual(h.responses[0][0], 200)
        act.assert_called_once()

    # ---- GET /api/inbox ----
    def test_get_inbox_local_ok(self):
        self.pkg('d')
        h = self.handler(path='/api/inbox')
        with mock.patch.object(board_routes.board_page, 'render', return_value=None):
            h.do_GET()
        code, payload = h.responses[0]
        self.assertEqual(code, 200)
        self.assertEqual(payload['counts']['done'], 1)

    def test_get_inbox_rejects_non_local(self):
        h = self.handler(path='/api/inbox', client='192.168.1.9')
        with mock.patch.object(board_routes.board_page, 'render', return_value=None):
            h.do_GET()
        self.assertEqual(h.responses[0][0], 403)

    def test_handle_get_returns_inbox_shape(self):
        self.pkg('d')
        out = board_api.handle_get('/api/inbox', {})
        self.assertIn('items', out)
        self.assertIn('counts', out)
        self.assertEqual(out['counts']['done'], 1)

    def test_handle_get_unknown_path_still_none(self):
        self.assertIsNone(board_api.handle_get('/api/other', {}))

    def test_is_local_matrix(self):
        self.assertTrue(inbox.is_local(('127.0.0.1', 1)))
        self.assertTrue(inbox.is_local(('::1', 1)))
        self.assertTrue(inbox.is_local('127.0.0.1'))
        self.assertFalse(inbox.is_local(('10.0.0.5', 1)))
        self.assertFalse(inbox.is_local(('0.0.0.0', 1)))

    def test_make_handler_registers_roots(self):
        board_routes.make_handler([self.root])
        self.assertEqual([str(p) for p in inbox._ROOTS], [str(self.root.resolve())])


if __name__ == '__main__':
    unittest.main()
