"""Run one work package (any registered adapter) and block until it finishes.

Usage (from the project root):
    python -X utf8 <ai-collab>/runtime/run_package.py <spec.json>

spec.adapter selects the executor (default dsh-workspace).

The controller calls this once and waits silently (Codex: write_stdin with
empty chars and max yield). Do not read stdout.ndjson while it runs. Prints ONE
JSON line at the end.

Guards (2026-10-26, user decision): turn count is only a backstop, because
cheap models take many small steps. Real protection is local, model-free
stall detection:
  - the same Bash command fails with the same error STALL_REPEAT times in a row
  - no progress for STALL_IDLE_SECONDS while no tool call is running
    (progress = Write/Edit or any successful tool result; a long-running
    command such as a migration rehearsal is covered by timeout_seconds only)
  - wall clock over timeout_seconds (default 7200)
On a stall the process tree is stopped and receipt.stall explains why.

Optional spec field auto_continue (default 3): how many times to resume the
SAME session when only the turn backstop was hit. Stalls are never resumed.
Outputs next to spec.json; attempt N>1 uses suffix .cN.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import adapters  # noqa: E402
from owned_process import OwnedProcess  # noqa: E402
from guard import (DEFAULT_AUTO_CONTINUE, DEFAULT_TIMEOUT, STALL_IDLE_SECONDS,  # noqa: E402
                   STALL_REPEAT, StallMonitor, should_continue, stop_process,
                   CONTINUE_PROMPT)


def _attempt(spec, out, suffix):
    ad = adapters.get_adapter(spec.get('adapter') or 'dsh-workspace')
    req = ad.build_command(dict(spec))
    (out / ('preflight%s.json' % suffix)).write_text(json.dumps(req['preflight'], indent=2), encoding='utf-8')
    log = out / ('stdout%s.ndjson' % suffix)
    if log.exists():
        raise ValueError('%s exists; use a new package directory' % log)
    stop = None
    env = dict(os.environ, **(req.get('env_delta') or {}))
    env['PYTHONIOENCODING'] = 'utf-8'
    with log.open('w', encoding='utf-8') as fo, (out / ('stderr%s.txt' % suffix)).open('w', encoding='utf-8') as fe:
        proc = OwnedProcess(req['argv'], cwd=spec['cwd'], stdin=subprocess.PIPE, stdout=fo, stderr=fe,
                            text=True, encoding='utf-8', env=env)
        (out / ('process%s.json' % suffix)).write_text(json.dumps({'pid': proc.pid}), encoding='utf-8')
        proc.stdin.write(req['stdin'])
        proc.stdin.close()
        denial = ad.denial_monitor(log)
        stall = StallMonitor(log, adapter=ad.name,
                             timeout=spec.get('timeout_seconds', DEFAULT_TIMEOUT))
        while proc.poll() is None:
            stop = (denial.poll() if denial else None) or stall.poll()
            if stop:
                stop_process(proc)
                break
            time.sleep(2)
        proc.wait(timeout=10)
        code = proc.returncode
        stopped = proc.close(timeout=5)
    lines = log.read_text(encoding='utf-8').splitlines()
    parsed = ad.parse_log(lines, spec['permission'])
    max_turns_hit = any('Max turns' in str(e) for e in _result_errors(lines))
    receipt = {'exit_code': code, 'parsed': parsed, 'process_tree_confirmed_stopped': stopped,
               'same_session_verified': bool(spec.get('session_id')) and parsed.get('session_id') == spec.get('session_id'),
               'stop_evidence': stop, 'max_turns_hit': max_turns_hit,
               'stall': stop if stop and stop.get('category') == 'stall' else None}
    (out / ('receipt%s.json' % suffix)).write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
    (out / ('reply%s.md' % suffix)).write_text(parsed.get('final_text', ''), encoding='utf-8')
    return receipt


def _result_errors(lines):
    for line in reversed(lines):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get('type') == 'result':
            return event.get('errors') or []
    return []


def main(path):
    spec_path = Path(path).resolve()
    out = spec_path.parent
    spec = json.loads(spec_path.read_text(encoding='utf-8-sig'))
    spec.setdefault('max_turns', ad.DEFAULT_MAX_TURNS)
    spec.setdefault('timeout_seconds', DEFAULT_TIMEOUT)
    spec.setdefault('persist_session', True)
    budget = int(spec.pop('auto_continue', DEFAULT_AUTO_CONTINUE))
    attempt, suffix = 1, ''
    receipt = _attempt(spec, out, suffix)
    while should_continue(receipt, budget):
        sid = receipt['parsed'].get('session_id')
        budget -= 1
        attempt += 1
        suffix = '.c%d' % attempt
        spec = dict(spec, prompt=CONTINUE_PROMPT, resume=True, session_id=sid)
        receipt = _attempt(spec, out, suffix)
    ok = bool(receipt['parsed']['transport_policy_passed']) and not receipt['max_turns_hit'] and not receipt['stop_evidence']
    summary = {'task_id': spec.get('task_id'), 'attempts': attempt, 'ok': ok,
               'max_turns_hit': receipt['max_turns_hit'], 'stall': receipt['stall'],
               'stopped': receipt['process_tree_confirmed_stopped'],
               'stop': receipt['stop_evidence'], 'session_id': receipt['parsed'].get('session_id'),
               'failures': receipt['parsed'].get('failures'),
               'reply': str(out / ('reply%s.md' % suffix))}
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    try:
        sys.exit(main(sys.argv[1]))
    except (ValueError, OSError, KeyError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(2)
