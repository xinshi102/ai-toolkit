"""Fixed native CodeBuddy CLI adapter, using its existing native login.

Tool lists are application policy, NOT OS isolation. In particular Bash can
operate outside cwd. The controller owns authorization, file ownership and
semantic acceptance. No credentials, global configuration or live databases
are read directly. A process exit code of zero is insufficient: callers must
also require parse_log()['transport_policy_passed'] and inspect artifacts.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import subprocess

_node_path = os.environ.get('XINSHI_NODE_EXE') or shutil.which('node.exe')
NODE = Path(_node_path) if _node_path else None
_entry_path = os.environ.get('XINSHI_CODEBUDDY_ENTRY', '').strip()
ENTRY = Path(_entry_path) if _entry_path else None
TOOLS = {
    'read-only': ('Read', 'Glob', 'Grep'),
    'workspace-write': ('Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'),
}
# Native 2.169.0 init lists a catalog, not the --tools whitelist. Its init
# interceptor does filter exact disallowedTools rules. Keep an explicit deny
# list in addition to --tools, then reject any unfamiliar init capability.
KNOWN_TOOLS = tuple('Agent Read Write Edit Bash PowerShell Glob Grep EnterPlanMode ExitPlanMode TaskCreate TaskGet TaskUpdate TaskList WebFetch WebSearch TaskStop TaskOutput Skill Component Mods AskUserQuestion AskUserForStructuredInput StructuredOutput ToolSearch DeferExecuteTool SendMessage SendUserMessage TeamCreate TeamDelete NotebookEdit LSP ImageGen LibraryUpload ImageEdit Artifact ArtifactControl VideoGen AudioTranscribe EnterWorktree LeaveWorktree CronCreate CronDelete CronList WeChatReply WeComReply PushNotification ReportFindings ComputerUse ListMcpResources ReadMcpResource WaitForMcpServers Workflow Monitor REPL A2AGetAgentCard A2ASendMessage A2AGetTask A2ACancelTask MessageColleague SpeakInChannel ChannelTasks CreateColleague CreateChannel ListColleagues'.split())
MAX_PROMPT_BYTES = 64 * 1024
# Native 2.169.0 can add this tool when resuming an existing session. Keep it
# denied in both profiles; recognizing a catalog name does not authorize it.
KNOWN_TOOLS += ('SkillManage',)
AUDITED_VERSION = '2.169.0'


def _json(text):
    def constant(_):
        raise ValueError('non-finite JSON')
    def number(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError('non-finite JSON')
        return result
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError('duplicate JSON field')
            result[key] = value
        return result
    return json.loads(text, parse_constant=constant, parse_float=number,
                      object_pairs_hook=pairs)


def _probe(argv, cwd):
    kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    try:
        result = subprocess.run(argv, cwd=str(cwd), shell=False,
                                env=dict(os.environ, CODEBUDDY_DISABLE_COMPILE_CACHE='1'),
                                capture_output=True, text=True, encoding='utf-8',
                                errors='replace', timeout=30, **kwargs)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError('CodeBuddy native preflight unavailable') from error
    if result.returncode:
        raise ValueError('CodeBuddy native preflight failed; diagnostics withheld')
    return result.stdout.strip()


def request(spec):
    """Return argv/stdin/env_delta/preflight; caller launches with spec cwd.

    Max turns is a strict integer in 1..50, default 20. Prompts stay on stdin.
    Existing login is used by the native program. Tools and empty MCP are
    verified again from its init event rather than trusting argv alone.
    """
    if not isinstance(spec, dict):
        raise ValueError('spec must be an object')
    permission = spec.get('permission')
    if permission not in TOOLS:
        raise ValueError('permission must be read-only or workspace-write')
    cwd_raw = spec.get('cwd')
    if not isinstance(cwd_raw, str) or not cwd_raw:
        raise ValueError('cwd must be an absolute existing directory')
    cwd = Path(cwd_raw)
    if not cwd.is_absolute() or not cwd.is_dir():
        raise ValueError('cwd must be an absolute existing directory')
    prompt = spec.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('prompt must be nonempty text')
    try:
        size = len(prompt.encode('utf-8'))
    except UnicodeEncodeError as error:
        raise ValueError('prompt must be UTF-8') from error
    if size > MAX_PROMPT_BYTES:
        raise ValueError('prompt exceeds 64 KiB')
    turns = spec.get('max_turns', 20)
    if type(turns) is not int or not 1 <= turns <= 50:
        raise ValueError('max_turns must be integer 1..50')
    if any(key in spec for key in ('argv', 'executable', 'env', 'env_delta', 'shell', 'extra_args')):
        raise ValueError('custom launch overrides are unsupported')
    if NODE is None or not NODE.is_absolute() or not NODE.is_file():
        raise ValueError('set XINSHI_NODE_EXE to an existing absolute node.exe path, or add node.exe to PATH')
    if ENTRY is None or not ENTRY.is_absolute() or not ENTRY.is_file():
        raise ValueError('set XINSHI_CODEBUDDY_ENTRY to the existing absolute CodeBuddy JavaScript CLI entry')
    version = _probe([str(NODE), str(ENTRY), '--version'], cwd)
    if not version or len(version) > 80 or any(c not in '0123456789.-+abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ ' for c in version):
        raise ValueError('unexpected CodeBuddy version response')
    if version != AUDITED_VERSION:
        raise ValueError('CodeBuddy version differs from audited tool policy; re-audit required')
    help_text = _probe([str(NODE), str(ENTRY), '--help'], cwd)
    required = ('--tools', '--strict-mcp-config', '--mcp-config', '--no-session-persistence',
                '--output-format', '--max-turns', '--settings')
    if any(flag not in help_text for flag in required):
        raise ValueError('installed CodeBuddy lacks required profile flags')
    settings = {'disableAllHooks': True, 'enabledPlugins': {}}
    return {
        'argv': [str(NODE), str(ENTRY), '--print', '--output-format', 'stream-json',
                 '--verbose', '--max-turns', str(turns), '--no-session-persistence',
                 '--tools', ','.join(TOOLS[permission]),
                 # Unlike --tools, native permission rule arrays do not split
                 # commas. Commander <tools...> needs separate argv entries.
                 '--disallowedTools', *[t for t in KNOWN_TOOLS if t not in TOOLS[permission]],
                 '--strict-mcp-config',
                 '--mcp-config', '{"mcpServers":{}}', '--settings', json.dumps(settings), '-y'],
        'stdin': prompt,
        'env_delta': {'CODEBUDDY_DISABLE_COMPILE_CACHE': '1'},
        'preflight': {'adapter': 'codebuddy-workspace', 'version': version,
                      'required_flags_verified': True, 'permission': permission,
                      'allowed_tools': list(TOOLS[permission]), 'mcp_servers': [],
                      'policy_evidence': 'native-init-and-tool-call-audit',
                      'boundary': 'model-tool-policy-not-os-isolation',
                      'company_product_access': 'not-verified'},
    }


def parse_log(lines, permission):
    """Validate one native NDJSON session, independently of process exit code.

    Identical repeated init records occur in the real native authentication
    failure trace. They are allowed only when policy and session stay equal.
    A successful result must be unique and bound to the init session. Native
    stream delivery can append an identical init after it (timestamp differs);
    only that exact replay is accepted after a terminal result.
    Provider errors are categorized without preserving potentially secret URLs.
    """
    if permission not in TOOLS:
        raise ValueError('unknown permission')
    if not isinstance(lines, list) or any(not isinstance(line, str) for line in lines):
        raise ValueError('lines must be a list of strings')
    failures = []
    def fail(reason):
        if reason not in failures:
            failures.append(reason)
    session = None
    effective = None
    terminal = None
    final_text = ''
    calls = 0
    init_count = 0
    result_count = 0
    errors = []
    known_calls = set()
    initial_record = None
    for line in lines:
        line = line.strip().lstrip('\ufeff')
        if not line:
            continue
        try:
            event = _json(line)
        except (ValueError, TypeError):
            # Native startup warnings can accompany merged stderr; malformed
            # protocol records cannot be silently discarded.
            if line[:1] in '{[':
                fail('malformed_event')
            continue
        if not isinstance(event, dict):
            fail('malformed_event')
            continue
        normalized = {key: value for key, value in event.items() if key != '__timestamp'}
        if terminal is not None:
            # Observed in native 2.169.0 successful stdout: StreamJsonView's
            # delayed init delivery replays the same record after result.
            # It is not a new turn, stats channel or arbitrary system event.
            if (event.get('type') == 'system' and event.get('subtype') == 'init'
                    and initial_record is not None and normalized == initial_record):
                continue
            fail('event_after_result')
        kind = event.get('type')
        if kind in ('error', 'error_result') or event.get('is_error') is True:
            fail('native_error_event')
        sid = event.get('session_id')
        if not isinstance(sid, str) or not sid:
            fail('missing_session')
        elif session is None:
            session = sid
        elif sid != session:
            fail('session_mismatch')
        if kind == 'system' and event.get('subtype') == 'init':
            init_count += 1
            if initial_record is None:
                initial_record = normalized
            tools = event.get('tools')
            if not isinstance(tools, list) or any(not isinstance(t, str) for t in tools) or len(set(tools)) != len(tools):
                fail('invalid_tools')
            else:
                if effective is not None and tools != effective:
                    fail('init_policy_changed')
                effective = tools
                if not set(tools).issubset(TOOLS[permission]):
                    fail('unexpected_tool_capability')
            if event.get('mcp_servers') != [] or event.get('mcp_servers_unavailable'):
                fail('mcp_not_empty_or_unverified')
        elif not init_count:
            fail('event_before_init')
        if kind in ('assistant', 'user'):
            message = event.get('message')
            blocks = message.get('content') if isinstance(message, dict) else None
            if not isinstance(blocks, list):
                fail('malformed_message')
            else:
                for block in blocks:
                    if not isinstance(block, dict):
                        fail('malformed_message')
                    elif block.get('type') == 'tool_use':
                        call_id = block.get('id')
                        if kind != 'assistant' or not isinstance(call_id, str) or not call_id or call_id in known_calls:
                            fail('invalid_tool_call')
                        known_calls.add(call_id if isinstance(call_id, str) else '')
                        calls += 1
                        if block.get('name') not in TOOLS[permission] or effective is None or block.get('name') not in effective:
                            fail('unauthorized_tool_call')
                    elif block.get('type') == 'tool_result' and block.get('is_error') is True:
                        fail('tool_error')
        if event.get('permission_denials') not in (None, []):
            fail('permission_denied')
        if kind == 'result':
            result_count += 1
            terminal = event
            if event.get('subtype') != 'success' or event.get('is_error') is not False:
                fail('native_result_failed')
            if event.get('permission_denials') not in (None, []):
                fail('permission_denied')
            native_errors = event.get('errors')
            if native_errors:
                fail('native_error_reported')
                text = str(native_errors).lower()
                errors.append('authentication-required' if 'authentication required' in text else
                              'permission-denied' if 'permission' in text else 'provider-or-execution-error')
            value = event.get('result')
            if not isinstance(value, str) or not value.strip():
                fail('missing_final_text')
            else:
                final_text = value
    if not init_count:
        fail('missing_init')
    if result_count != 1:
        fail('missing_or_multiple_result')
    final_json = None
    if final_text:
        try:
            final_json = _json(final_text)
        except (ValueError, TypeError):
            pass  # Plain text is valid transport; JSON semantics are optional.
    return {'transport_policy_passed': not failures, 'final_text': final_text,
            'final_json': final_json, 'session_id': session,
            'effective_tools': effective or [], 'tool_call_count': calls,
            'terminal_event': ({'type': 'result', 'subtype': terminal.get('subtype'),
                                'is_error': terminal.get('is_error')} if terminal else None),
            'semantic_acceptance': 'controller-required', 'failures': failures,
            'error_summary': errors, 'local_profile_verified': not failures,
            'boundary': 'model-tool-policy-not-os-isolation'}
