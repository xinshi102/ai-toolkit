"""Contract failures that matter for native CLI transport, without inference."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).parents[1] / 'codebuddy_workspace.py'
spec = importlib.util.spec_from_file_location('codebuddy_workspace', SOURCE)
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def init(sid='session-a', tools=None, mcp=None):
    return {'type': 'system', 'subtype': 'init', 'session_id': sid,
            'tools': list(adapter.TOOLS['read-only']) if tools is None else tools,
            'mcp_servers': [] if mcp is None else mcp}


def result(sid='session-a', text='{"answer":42}'):
    return {'type': 'result', 'subtype': 'success', 'is_error': False,
            'session_id': sid, 'permission_denials': [], 'result': text}


def parsed(*events, permission='read-only'):
    return adapter.parse_log([json.dumps(e) for e in events], permission)


class NativeTransport(unittest.TestCase):
    def test_one_session_completed_result_with_repeated_identical_init(self):
        value = parsed(init(), init(), result())
        self.assertTrue(value['transport_policy_passed'])
        self.assertEqual(value['final_json'], {'answer': 42})
        self.assertEqual(value['semantic_acceptance'], 'controller-required')

    def test_synthetic_authentication_failure_exit_zero_is_not_success(self):
        fixture = Path(__file__).parent / 'fixtures/auth-failure.ndjson'
        value = adapter.parse_log(fixture.read_text(encoding='utf-8-sig').splitlines(), 'read-only')
        self.assertFalse(value['transport_policy_passed'])
        self.assertIn('authentication-required', value['error_summary'])
        self.assertNotIn('Please use', str(value))

    def test_synthetic_success_tail_is_exact_init_replay_not_new_turn(self):
        fixture = Path(__file__).parent / 'fixtures/init-replay.ndjson'
        events = [json.loads(line) for line in fixture.read_text(encoding='utf-8-sig').splitlines() if line.strip()]
        value = adapter.parse_log([json.dumps(e) for e in events], 'read-only')
        self.assertNotIn('event_after_result', value['failures'])
        # This synthetic init still advertises an unauthorized tool. Do
        # not turn a protocol compatibility test into a readonly policy pass.
        self.assertIn('unexpected_tool_capability', value['failures'])
        self.assertEqual(value['terminal_event']['subtype'], 'success')
        self.assertIsInstance(value['final_json'], dict)
        first = dict(init(), __timestamp='first')
        replay = dict(first, __timestamp='later')
        self.assertTrue(parsed(first, result(), replay)['transport_policy_passed'])
        for changed in (dict(replay, model='different'), dict(replay, session_id='different'),
                        {'type': 'system', 'subtype': 'status', 'session_id': 'session-a', 'status': None}):
            self.assertFalse(parsed(first, result(), changed)['transport_policy_passed'])

    def test_external_capability_or_mcp_invalidates_local_profile(self):
        for event in (init(tools=['Read', 'ComputerUse']), init(mcp=[{'name': 'company', 'status': 'connected'}])):
            with self.subTest(event=event):
                self.assertFalse(parsed(event, result())['transport_policy_passed'])

    def test_session_mismatch_or_terminal_replay_is_rejected(self):
        for events in ((init(), result('different')), (init(), result(), result()), (result(),)):
            with self.subTest(events=events):
                self.assertFalse(parsed(*events)['transport_policy_passed'])

    def test_missing_malformed_error_or_denied_completion_is_rejected(self):
        for events in ((init(),), (init(), dict(result(), is_error=True)),
                       (init(), dict(result(), permission_denials=[{'tool_name': 'Write'}]))):
            self.assertFalse(parsed(*events)['transport_policy_passed'])
        self.assertFalse(adapter.parse_log([json.dumps(init()), '{broken', json.dumps(result())], 'read-only')['transport_policy_passed'])
        self.assertFalse(parsed(init(), {'type': 'error', 'session_id': 'session-a'}, result())['transport_policy_passed'])

    def test_tool_calls_counted_and_readonly_write_rejected(self):
        tool = {'type': 'assistant', 'session_id': 'session-a', 'message': {'content': [
            {'type': 'tool_use', 'id': 'call-1', 'name': 'Read', 'input': {'file_path': 'sample'}}]}}
        good = parsed(init(), tool, result())
        self.assertTrue(good['transport_policy_passed'])
        self.assertEqual(good['tool_call_count'], 1)
        tool['message']['content'][0]['name'] = 'Write'
        self.assertFalse(parsed(init(), tool, result())['transport_policy_passed'])

    def test_final_json_requires_whole_strict_document(self):
        for text in ('```json\n{}\n```', '{"a":1,"a":2}', '{"x":NaN}', '{"x":1e999}'):
            value = parsed(init(), result(text=text))
            self.assertTrue(value['transport_policy_passed'])
            self.assertIsNone(value['final_json'])

    def test_error_summary_does_not_copy_url_secrets(self):
        failure = dict(result(), subtype='error_during_execution', is_error=True,
                       errors=['Provider request failed https://host.invalid/?token=SECRET'])
        value = parsed(init(), failure)
        self.assertEqual(value['error_summary'], ['provider-or-execution-error'])
        self.assertNotIn('SECRET', str(value))


class RequestContract(unittest.TestCase):
    def build(self, **changes):
        with tempfile.TemporaryDirectory() as tmp:
            spec = {'cwd': tmp, 'prompt': 'analyze $(literal) `literal`', 'permission': 'read-only'}
            spec.update(changes)
            with patch.object(adapter, 'NODE', Path(tmp)/'node.exe'), patch.object(adapter, 'ENTRY', Path(tmp)/'codebuddy.js'), patch.object(Path, 'is_file', return_value=True), patch.object(adapter, '_probe', side_effect=['2.169.0', '--tools --strict-mcp-config --mcp-config --no-session-persistence --output-format --max-turns --settings']):
                return adapter.request(spec)

    def test_fixed_argv_stdin_and_denies_are_separate(self):
        value = self.build()
        self.assertNotIn(value['stdin'], value['argv'])
        self.assertIn('-y', value['argv'])
        self.assertNotIn('CODEBUDDY_IS_SANDBOX', value['env_delta'])
        denied = value['argv'][value['argv'].index('--disallowedTools') + 1:value['argv'].index('--strict-mcp-config')]
        self.assertIn('Write', denied)
        self.assertIn('MessageColleague', denied)
        self.assertIn('SkillManage', denied)
        self.assertNotIn('Read', denied)
        self.assertTrue(all(',' not in rule for rule in denied))

    def test_resume_only_tool_is_denied_in_both_profiles(self):
        for permission in ('read-only', 'workspace-write'):
            value = self.build(permission=permission)
            argv = value['argv']
            denied = argv[argv.index('--disallowedTools') + 1:argv.index('--strict-mcp-config')]
            self.assertIn('SkillManage', denied)
            self.assertNotIn('SkillManage', argv[argv.index('--tools') + 1].split(','))
            self.assertNotIn('SkillManage', value['preflight']['allowed_tools'])

    def test_synthetic_resume_capability_failure_is_still_rejected(self):
        fixture = Path(__file__).parent / 'fixtures/resume-extra-tool.ndjson'
        value = adapter.parse_log(fixture.read_text(encoding='utf-8').splitlines(), 'workspace-write')
        self.assertFalse(value['transport_policy_passed'])
        self.assertIn('SkillManage', value['effective_tools'])
        self.assertIn('unexpected_tool_capability', value['failures'])

    def test_invalid_input_or_launch_override_never_runs_preflight(self):
        for changes in ({'prompt': ''}, {'prompt': '   '}, {'prompt': 'x'*65537},
                        {'max_turns': True}, {'max_turns': 51}, {'max_turns': 0},
                        {'permission': 'danger-full-access'}, {'cwd': 'relative'},
                        {'env': {'SECRET': 'x'}}):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    self.build(**changes)

    def test_unknown_native_version_fails_before_loading_policy_or_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(adapter, 'NODE', Path(tmp)/'node.exe'), patch.object(adapter, 'ENTRY', Path(tmp)/'codebuddy.js'), patch.object(Path, 'is_file', return_value=True), patch.object(adapter, '_probe', return_value='2.170.0') as probe:
                with self.assertRaisesRegex(ValueError, 're-audit required'):
                    adapter.request({'cwd': tmp, 'prompt': 'valid', 'permission': 'read-only'})
                self.assertEqual(probe.call_count, 1)


if __name__ == '__main__':
    unittest.main()
