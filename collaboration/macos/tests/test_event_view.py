"""Independent display contract tests for native harness events."""
import importlib.util
import pathlib
import tempfile
import unittest

PATH = pathlib.Path(__file__).resolve().parents[1] / 'event_view.py'
spec = importlib.util.spec_from_file_location('event_view', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
normalize = module.normalize_native_event


class NativeEventTests(unittest.TestCase):
    def test_opencode_native_tool_shape(self):
        event = {'type': 'tool_use', 'timestamp': 1770000000, 'sessionID': 'ses_synthetic', 'part': {'type': 'tool', 'tool': 'read', 'callID': 'call_synthetic', 'state': {'status': 'completed', 'input': {'filePath': 'public-brief.json'}, 'output': '{"nonce":"synthetic"}'}}}
        row, = normalize('opencode', event)
        self.assertEqual((row['kind'], row['provider'], row['tool'], row['state'], row['session_id']), ('tool', 'opencode', 'read', 'completed', 'ses_synthetic'))
        self.assertEqual(row['input'], {'filePath': 'public-brief.json'})
        self.assertEqual(row['output'], '{"nonce":"synthetic"}')
        self.assertNotIn('timestamp', row)

    def test_opencode_text_and_error(self):
        self.assertEqual(normalize('opencode', {'type': 'text', 'part': {'text': 'done'}, 'sessionID': 's'})[0]['text'], 'done')
        row, = normalize('opencode', {'type': 'error', 'error': {'data': {'message': 'unavailable'}}})
        self.assertEqual((row['kind'], row['text']), ('error', 'unavailable'))

    def test_dsh_event_shapes(self):
        self.assertEqual(normalize('dsh', {'type': 'session', 'sessionId': 's'})[0]['session_id'], 's')
        call, = normalize('dsh', {'type': 'tool_call', 'callId': 'c', 'tool': 'read_file', 'input': {'path': 'brief'}})
        self.assertEqual((call['kind'], call['call_id'], call['state']), ('tool', 'c', 'running'))
        result, = normalize('dsh', {'type': 'tool_result', 'callId': 'c', 'status': 'completed', 'result': {'ok': True}})
        self.assertEqual((result['call_id'], result['state'], result['output']), ('c', 'completed', {'ok': True}))
        self.assertEqual(normalize('dsh', {'type': 'final', 'text': 'ok'})[0]['kind'], 'response')
        self.assertEqual(normalize('dsh', {'type': 'error', 'text': 'bad'})[0]['kind'], 'error')

    def test_nested_secrets_redacted_without_mutation(self):
        keys = ['api_key', 'apiKey', 'token', 'access_token', 'refresh-token', 'password', 'authorization', 'secret', 'client_secret']
        payload = {'nested': [{key: 'SYNTHETIC_SECRET' for key in keys}], 'safe': 'hello'}
        result = normalize('dsh', {'type': 'tool_call', 'callId': 'c', 'tool': 'fixture', 'input': payload})[0]['input']
        self.assertEqual(result['nested'][0], {key: '[REDACTED]' for key in keys})
        self.assertEqual(payload['nested'][0]['apiKey'], 'SYNTHETIC_SECRET')
        self.assertEqual(result['safe'], 'hello')

    def test_all_retained_strings_bounded(self):
        value = '界' * 12001
        row, = normalize('dsh', {'type': 'tool_call', 'tool': value, 'callId': value, 'input': {'nested': [value]}})
        self.assertEqual(len(row['tool']), 12000)
        self.assertEqual(len(row['call_id']), 12000)
        self.assertEqual(len(row['input']['nested'][0]), 12000)
        sid = normalize('dsh', {'type': 'session', 'sessionId': value})[0]['session_id']
        self.assertEqual(len(sid), 12000)
        state = normalize('dsh', {'type': 'tool_result', 'callId': 'c', 'status': value})[0]['state']
        self.assertEqual(len(state), 12000)
        self.assertEqual(len(normalize('dsh', {'type': 'final', 'text': value})[0]['text']), 12000)
        self.assertEqual(normalize('dsh', {'type': 'final', 'text': 'x' * 12000})[0]['text'], 'x' * 12000)

    def test_adversarial_content_remains_inert(self):
        with tempfile.TemporaryDirectory() as folder:
            target = pathlib.Path(folder) / 'must-not-exist'
            text = f"__import__('pathlib').Path({str(target)!r}).write_text('bad'); $(touch {target})"
            self.assertEqual(normalize('dsh', {'type': 'final', 'text': text})[0]['text'], text)
            self.assertFalse(target.exists())

    def test_unknown_and_malformed(self):
        for provider, event in [('unknown', {'type': 'final'}), ('dsh', None), ('opencode', []), ('opencode', {'type': 'other'}), ('opencode', {'type': 'tool_use', 'part': None}), ('opencode', {'type': 'text', 'part': []})]:
            with self.subTest(provider=provider, event=event):
                self.assertEqual(normalize(provider, event), [])


if __name__ == '__main__':
    unittest.main()
