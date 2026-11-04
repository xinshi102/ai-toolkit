"""Adapter-independent stall detection built on a normalized event stream.

The guard never calls a model and never inspects credentials.  It reads the
adapter's log incrementally and turns it into a small common vocabulary:

    tool_start   {id, name, command}
    tool_end     {id, name, command, ok, error_text}
    file_change  {}
    result       {max_turns_hit}

Three stop conditions are shared by every execution path:
  * the same shell command fails with the same error STALL_REPEAT times in a row;
  * no progress for STALL_IDLE_SECONDS while no tool call is running
    (progress = write/edit or any successful tool result);
  * wall clock over timeout.
Thresholds are unchanged from run_package.py (5 / 1200 / 7200 / 3).

Adapters whose logs cannot expose tool events are deliberately degraded to
wall-clock plus "log file did not grow" only; see ADAPTERS below.  They are not
reported as supporting tool-level detection.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import time
from pathlib import Path

STALL_REPEAT = 5
STALL_IDLE_SECONDS = 1200
DEFAULT_TIMEOUT = 7200
DEFAULT_AUTO_CONTINUE = 3
CONTINUE_PROMPT = ('\u4e0a\u4e00\u8f6e\u56e0\u8f6e\u6570\u515c\u5e95\u4e0a\u9650\u4e2d\u65ad\u3002'
                   '\u7ee7\u7eed\u5b8c\u6210\u540c\u4e00\u5de5\u4f5c\u5305\u7684\u5269\u4f59\u90e8\u5206\uff0c'
                   '\u4e0d\u8981\u91cd\u8bfb\u5df2\u7ecf\u8bfb\u8fc7\u7684\u6587\u4ef6\uff0c\u4e0d\u8981\u91cd\u505a\u5df2\u5b8c\u6210\u7684\u90e8\u5206\uff1b'
                   '\u5b8c\u6210\u540e\u6309\u539f\u9a8c\u6536\u6807\u51c6\u6c47\u62a5\u3002')
EDIT_TOOLS = ('Write', 'Edit', 'MultiEdit', 'NotebookEdit')


def _text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                text = item.get('text')
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        if parts:
            return ''.join(parts)
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def _command(value):
    if isinstance(value, str) and value:
        return value[:500]
    return None


def _max_turns(text):
    return 'max turns' in str(text or '').lower() or 'max_turns' in str(text or '').lower()


# ---------------------------------------------------------------------------
# Normalizers: raw log event -> list of common events.
# Each is a pure function of one decoded JSON object.
# ---------------------------------------------------------------------------

def normalize_stream_json(event):
    """Claude-style stream-json (assistant tool_use, user tool_result)."""
    out = []
    kind = event.get('type')
    message = event.get('message')
    content = message.get('content', []) if isinstance(message, dict) else []
    if not isinstance(content, list):
        content = []
    if kind == 'assistant':
        for block in content:
            if not isinstance(block, dict) or block.get('type') != 'tool_use':
                continue
            name = block.get('name')
            out.append({'kind': 'tool_start', 'id': block.get('id'), 'name': name,
                        'command': _command((block.get('input') or {}).get('command'))})
            if name in EDIT_TOOLS:
                out.append({'kind': 'file_change'})
    elif kind == 'user':
        for block in content:
            if not isinstance(block, dict) or block.get('type') != 'tool_result':
                continue
            error = bool(block.get('is_error'))
            out.append({'kind': 'tool_end', 'id': block.get('tool_use_id'),
                        'command': None, 'ok': not error,
                        'error_text': _text(block.get('content')) if error else ''})
    elif kind == 'result':
        out.append({'kind': 'result', 'max_turns_hit': _max_turns(event.get('errors'))})
    return out






def normalize_dsh(event):
    """DSH workspace NDJSON: native tool_call / tool_result and turn_end status."""
    kind = event.get('type')
    if kind == 'tool_call':
        name = event.get('tool') if isinstance(event.get('tool'), str) else None
        args = event.get('input') if isinstance(event.get('input'), dict) else {}
        command = _command(args.get('command'))
        out = [{'kind': 'tool_start', 'id': event.get('callId'), 'name': name,
                'command': command}]
        if name in ('write', 'edit', 'Write', 'Edit'):
            out.append({'kind': 'file_change'})
        return out
    if kind == 'tool_result':
        status = event.get('status')
        error = status == 'error'
        return [{'kind': 'tool_end', 'id': event.get('callId'), 'command': None,
                 'ok': not error,
                 'error_text': _text(event.get('result')) if error else ''}]
    if kind == 'status' and event.get('phase') == 'turn_end':
        reason = event.get('reason')
        name = reason.get('kind') if isinstance(reason, dict) else None
        return [{'kind': 'result', 'max_turns_hit': name in DSH_MAX_REASONS}]
    return []





def normalize_codex(event):
    """Codex --json: item.started/item.completed with command_execution items."""
    kind = event.get('type')
    item = event.get('item') if isinstance(event.get('item'), dict) else {}
    item_type = item.get('type')
    if kind in ('item.started', 'item.completed') and item_type == 'command_execution':
        command = _command(item.get('command'))
        if kind == 'item.started':
            return [{'kind': 'tool_start', 'id': item.get('id'), 'name': 'Bash',
                     'command': command}]
        ok = item.get('status') == 'completed' and item.get('exit_code') == 0
        return [{'kind': 'tool_end', 'id': item.get('id'), 'command': command,
                 'ok': ok,
                 'error_text': '' if ok else _text(item.get('aggregated_output'))}]
    if kind in ('item.started', 'item.completed') and item_type in ('file_change', 'patch_apply'):
        return [{'kind': 'file_change'}]
    if kind == 'turn.failed' or kind == 'error':
        text = json.dumps(item or event, ensure_ascii=False)
        if _max_turns(text):
            return [{'kind': 'result', 'max_turns_hit': True}]
    return []


# Adapters with a tool-level normalizer.
NORMALIZERS = {
    'dsh-workspace': normalize_dsh,
    'codex': normalize_codex,
    'codex-workspace': normalize_codex,
}
# Deliberate degradation: these adapters have no verified tool-event schema in
# their logs (local-test emits one completion record; dsh-text denies every
# tool; native dsh is not launchable). They get wall-clock plus log-growth
# detection only, never fake tool-level support.
DEGRADED = frozenset(('local-test', 'dsh-text', 'dsh'))


def normalizer_for(adapter):
    return NORMALIZERS.get(adapter)


class StallMonitor:
    """Incremental, adapter-independent stall detector.

    The constructor signature is the historical run_package one; ``adapter``
    defaults to codex-workspace.
    """

    def __init__(self, path, repeat=STALL_REPEAT, idle=STALL_IDLE_SECONDS,
                 clock=time.monotonic, adapter='codex-workspace', timeout=None):
        self.path = Path(path)
        self.repeat, self.idle, self.clock = repeat, idle, clock
        self.adapter = adapter
        self.normalize = normalizer_for(adapter)
        self.timeout = timeout
        self.started = clock()
        self.offset = 0
        self.buf = ''
        self.pending = {}
        self.last_sig = None
        self.same = 0
        self.last_change = clock()
        self.last_growth = clock()
        self.running = set()
        self.max_turns_hit = False

    def _signal(self, command, error_text):
        payload = (command + '\0' + str(error_text)[-800:]).encode('utf-8', 'replace')
        return hashlib.sha1(payload).hexdigest()

    def _apply(self, event):
        kind = event.get('kind')
        now = self.clock()
        if kind == 'tool_start':
            call_id = event.get('id')
            if call_id is not None:
                self.running.add(call_id)
            command = event.get('command')
            if command:
                self.pending[call_id] = command
            return
        if kind == 'tool_end':
            call_id = event.get('id')
            self.running.discard(call_id)
            command = event.get('command') or self.pending.pop(call_id, None)
            self.pending.pop(call_id, None)
            if event.get('ok'):
                self.last_change = now
                self.same, self.last_sig = 0, None
                return
            if not command:
                return
            signature = self._signal(command, event.get('error_text'))
            self.same = self.same + 1 if signature == self.last_sig else 1
            self.last_sig = signature
            return
        if kind == 'file_change':
            self.last_change = now
            return
        if kind == 'result' and event.get('max_turns_hit'):
            self.max_turns_hit = True

    def _normalized(self, event):
        try:
            return self.normalize(event) or ()
        except (TypeError, ValueError, AttributeError, KeyError):
            # A malformed log line must not crash the guard; the next valid
            # event and the wall-clock backstop still apply.
            return ()

    def feed_event(self, event):
        """Feed one already-decoded adapter event; returns a stop dict or None."""
        if self.normalize is not None:
            for normalized in self._normalized(event):
                self._apply(normalized)
        return self.check()

    def check(self):
        if self.same >= self.repeat:
            return {'category': 'stall',
                    'reason': 'same command failed with same error %d times in a row' % self.same}
        if not self.running:
            if self.normalize is None:
                reference, message = self.last_growth, 'no log growth for %ds'
            else:
                reference, message = self.last_change, 'no file change for %ds'
            if self.clock() - reference > self.idle:
                return {'category': 'stall', 'reason': message % int(self.idle)}
        if self.timeout is not None and self.clock() - self.started > self.timeout:
            return {'category': 'timeout'}
        return None

    def poll(self):
        try:
            with self.path.open('r', encoding='utf-8', errors='replace') as stream:
                stream.seek(self.offset)
                chunk = stream.read()
                self.offset = stream.tell()
        except OSError:
            return self.check()
        if chunk:
            self.last_growth = self.clock()
        if self.normalize is None:
            return self.check()
        self.buf += chunk
        parts = self.buf.split('\n')
        self.buf = parts.pop()
        for line in parts:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            for normalized in self._normalized(event):
                self._apply(normalized)
        return self.check()


def stop_process(process, wait=10):
    """Terminate the owned process tree (or the direct child when unowned)."""
    tree = getattr(process, 'terminate_tree', None)
    if callable(tree):
        tree()
    else:
        try:
            process.terminate()
        except OSError:
            pass
    try:
        process.wait(timeout=wait)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except (OSError, AttributeError):
            pass


def should_continue(receipt, budget):
    """Same-session continuation policy for a turn-count backstop hit."""
    return bool(budget > 0 and receipt.get('max_turns_hit') and not receipt.get('stall')
                and receipt.get('process_tree_confirmed_stopped')
                and (receipt.get('parsed') or {}).get('session_id'))
