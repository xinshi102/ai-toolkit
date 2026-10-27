"""Dispatch-boundary checks and scoped work-package admission.

Rules:
  * New root task: no identity, continuation record or prior session is
    required. Any agent is allowed unless `assigned` or an optional project
    policy pins one.
  * Branch (`branch`): a sub-task may use another agent; the parent's legacy
    task-group contract is not applied.
  * Explicit continuation (`continuation_of`): if this installation still has
    a legacy task-group contract, its recorded executor is expected unless
    `allow_switch` is set. A missing/UNKNOWN contract is not a refusal; a task
    id alone is not treated as a continuation.
  * `admit` enforces only limits the caller declares in `spec['limits']`.
    There is no universal prompt/turn/test-run number. The 64 KiB transport
    bound belongs to the native adapters.

`dispatch_contracts.json` is a legacy executor/session record, not an
authoritative session store. It does not prove that a native session still
exists, that resume succeeded, or that concurrent runs cannot overlap.
Workflow history and native resume are the authority; this module does not
implement session persistence or concurrency control.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import task_groups

DEFAULT_POLICY = Path(__file__).with_name('dispatch_policy.json')
DEFAULT_CONTRACTS = Path(__file__).with_name('dispatch_contracts.json')
ALIASES = {
    'execa': 'ExecA', 'execa-workspace': 'ExecA', 'execa-code': 'ExecA',
    'execb': 'ExecB', 'execb-workspace': 'ExecB', 'execb-desktop': 'ExecB',
    'dsh': 'DSH', 'dsh-workspace': 'DSH', 'codex': 'Codex', 'codex-workspace': 'Codex',
    'cursor': 'Cursor', 'cursor-workspace': 'Cursor',
}
LIMIT_KEYS = ('prompt_chars', 'max_turns', 'max_test_runs')


class DispatchRefused(RuntimeError):
    pass


class WorkPackageRejected(DispatchRefused):
    pass


def normalize_agent(value) -> str:
    value = str(value or '').strip()
    return ALIASES.get(value.lower(), value)


def normalize_path(value) -> str:
    try:
        return str(Path(value).resolve()).replace('\\', '/').rstrip('/').lower()
    except Exception:
        return str(value or '').replace('\\', '/').rstrip('/').lower()


def _load(path, default=None):
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else (default or {})
    except Exception:
        return default or {}


def _save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=str(path.parent))
    with open(fd, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2, sort_keys=True)
    Path(tmp).replace(path)


def expected_from_policy(cwd, task='', policy=None) -> str:
    policy = policy if isinstance(policy, dict) else _load(DEFAULT_POLICY)
    task = str(task or '')
    tasks = policy.get('tasks') or {}
    if task and task in tasks:
        return normalize_agent(tasks[task])
    for key, value in tasks.items():
        if task.startswith(str(key)):
            return normalize_agent(value)
    target = normalize_path(cwd)
    best = ''
    selected = ''
    for key, value in (policy.get('projects') or {}).items():
        prefix = normalize_path(key)
        if target == prefix or target.startswith(prefix + '/'):
            if len(prefix) > len(best):
                best, selected = prefix, normalize_agent(value)
    return selected


def check(cwd, task='', agent='', assigned='', continuation_of='', branch='',
          session_id='', allow_switch=False, reason='', policy=None,
          contracts_path=DEFAULT_CONTRACTS) -> dict:
    """Check dispatch identity and executor continuity.

    `session_id` is accepted for legacy callers but does not gate a run: a
    value in the legacy JSON file is not proof that the native session exists
    or was resumed. Workflow history/native resume own that decision.
    """
    agent = normalize_agent(agent)
    assigned = normalize_agent(assigned)
    if assigned and agent and agent != assigned:
        raise DispatchRefused(f'assigned executor is {assigned}, got {agent}')
    policy_expected = expected_from_policy(cwd, task, policy)
    if policy_expected and agent and agent != policy_expected:
        raise DispatchRefused(f'project policy requires {policy_expected}, got {agent}')

    continuation = str(continuation_of or '').strip()
    identity = continuation or str(task or '').strip()
    group = task_groups.group_for(identity) if identity else ''
    if branch:
        return {'cwd': str(cwd or ''), 'task': str(task or ''), 'group': group,
                'agent': agent, 'expected': '', 'ok': True, 'branch': branch}

    contract = None
    if continuation and group and group.upper() != 'UNKNOWN':
        contract = _load(contracts_path).get(group)
        if not isinstance(contract, dict):
            contract = {}
    if contract and not allow_switch:
        expected = normalize_agent(contract.get('executor'))
        if expected and agent and agent != expected:
            raise DispatchRefused(
                f'executor changed for continued task {group}: legacy contract expects '
                f'{expected}, got {agent}; mark a branch or pass explicit allow_switch with a reason')
    return {'cwd': str(cwd or ''), 'task': str(task or ''), 'group': group,
            'agent': agent, 'expected': normalize_agent((contract or {}).get('executor')),
            'ok': True, 'branch': '', 'allowed_switch': bool(allow_switch), 'reason': reason}


def _declared_limits(spec) -> dict:
    raw = spec.get('limits')
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise WorkPackageRejected('limits must be an object')
    limits = {}
    for key, value in raw.items():
        if key not in LIMIT_KEYS:
            raise WorkPackageRejected(f'unknown limits key: {key}')
        if type(value) is not int or value < 1:
            raise WorkPackageRejected(f'limits.{key} must be a positive integer')
        limits[key] = value
    return limits


def _declared_test_runs(spec):
    test_policy = spec.get('test_policy')
    if test_policy is None:
        return None
    if not isinstance(test_policy, dict):
        raise WorkPackageRejected('test_policy must be an object')
    max_runs = test_policy.get('max_runs')
    if max_runs is not None and (type(max_runs) is not int or max_runs < 0):
        raise WorkPackageRejected('test_policy.max_runs must be a non-negative integer')
    return max_runs


def admit(spec, agent, require_acceptance=False) -> dict:
    """Validate one work package against limits the caller explicitly declared.

    `spec['limits']` may declare positive integer `prompt_chars`, `max_turns`
    and `max_test_runs`. `max_test_runs` only caps a declared
    `test_policy.max_runs`; this function cannot count actual test executions.
    Native adapters remain responsible for the 64 KiB transport bound and
    their own native turn range.
    """
    if not isinstance(spec, dict):
        raise WorkPackageRejected('spec must be an object')
    agent_name = normalize_agent(agent)
    prompt = spec.get('prompt', '')
    if prompt is None:
        prompt = ''
    if not isinstance(prompt, str):
        raise WorkPackageRejected('prompt must be text')
    turns = spec.get('max_turns')
    if turns is not None and (type(turns) is not int or turns < 1):
        raise WorkPackageRejected('max_turns must be a positive integer')
    limits = _declared_limits(spec)
    prompt_limit = limits.get('prompt_chars')
    if prompt_limit is not None and len(prompt) > prompt_limit:
        raise WorkPackageRejected(
            f'{agent_name} prompt is {len(prompt)} chars > declared limits.prompt_chars {prompt_limit}')
    turn_limit = limits.get('max_turns')
    if turn_limit is not None and turns is not None and turns > turn_limit:
        raise WorkPackageRejected(
            f'{agent_name} max_turns is {turns} > declared limits.max_turns {turn_limit}')
    phase = str(spec.get('phase') or '').lower()
    if phase == 'diagnose' and spec.get('permission') == 'workspace-write':
        raise WorkPackageRejected('diagnose phase must be read-only; switch phase to fix before writing')
    acceptance = spec.get('acceptance') or spec.get('checks') or spec.get('verification')
    if require_acceptance and not acceptance:
        raise WorkPackageRejected('work package requires acceptance (command + expected result, or checks)')
    max_test_runs = _declared_test_runs(spec)
    test_limit = limits.get('max_test_runs')
    if test_limit is not None and max_test_runs is not None and max_test_runs > test_limit:
        raise WorkPackageRejected(
            f'{agent_name} declared test_policy.max_runs {max_test_runs} > '
            f'task limits.max_test_runs {test_limit}')
    warnings = []
    if not acceptance:
        warnings.append('no explicit acceptance; add one before treating the run as complete')
    if phase and phase not in ('diagnose', 'fix', 'verify'):
        warnings.append(f'unknown phase {phase!r}')
    if turn_limit is not None and turns is None:
        warnings.append('limits.max_turns is declared but max_turns is absent; '
                        'the adapter default is not checked here')
    if test_limit is not None and max_test_runs is None:
        warnings.append('limits.max_test_runs is declared but test_policy.max_runs is absent; '
                        'actual test executions are not counted here')
    return {'ok': True, 'agent': agent_name, 'phase': phase,
            'prompt_chars': len(prompt), 'max_turns': turns,
            'max_test_runs': max_test_runs, 'warnings': warnings}


def contract_for(task, contracts_path=DEFAULT_CONTRACTS) -> dict:
    """Return the legacy task-group record, if any (compatibility lookup)."""
    group = task_groups.group_for(task)
    contract = _load(contracts_path).get(group)
    return contract if isinstance(contract, dict) else {}


def record(task, agent, session_id='', contracts_path=DEFAULT_CONTRACTS) -> dict:
    """Write the legacy executor/session record; not authoritative session storage."""
    group = task_groups.group_for(task)
    contracts = _load(contracts_path)
    contracts[group] = {'executor': normalize_agent(agent), 'session_id': str(session_id or '')}
    _save(contracts_path, contracts)
    return {'group': group, **contracts[group]}


def _cli():
    import argparse
    ap = argparse.ArgumentParser(description='xinshi executor continuity guard')
    ap.add_argument('--cwd', required=True)
    ap.add_argument('--task', default='')
    ap.add_argument('--agent', required=True)
    ap.add_argument('--assigned', default='')
    ap.add_argument('--continuation-of', default='')
    ap.add_argument('--branch', default='')
    ap.add_argument('--session-id', default='')
    ap.add_argument('--allow-switch', action='store_true')
    ap.add_argument('--reason', default='')
    ap.add_argument('--record', action='store_true')
    args = ap.parse_args()
    try:
        result = check(args.cwd, args.task, args.agent, args.assigned,
                       args.continuation_of, args.branch, args.session_id,
                       args.allow_switch, args.reason)
        if args.record and not args.branch:
            result['recorded'] = record(args.task or args.continuation_of, args.agent, args.session_id)
    except DispatchRefused as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(_cli())
