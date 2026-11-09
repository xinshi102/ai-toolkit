"""One-shot CLI dispatch and evidence journal; planning and acceptance stay in Codex.

This is not another scheduler. Long dependency graphs still use workflow.py.
No account store or credential value is read by this controller.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import uuid

import launch_guard

HOME = Path.home() / 'Library/Application Support/xinshi-collaboration'
PLAN_HOME = Path.home() / '.codex/plan-map'
FREE_MODEL = 'opencode/deepseek-v4.1-flash-free'
POLICY = {
    'coordinator': 'Codex',
    'routine': {'harness': 'opencode', 'model': FREE_MODEL},
    'substantial': {'harness': 'dsh', 'model': 'deepseek-official/deepseek-flash'},
    'kimi': 'not-default',
    'transport': 'cli-only',
    'paidFallback': False,
    'acceptance': 'Codex',
}
ID = re.compile(r'^[A-Za-z0-9_-]{1,80}$')


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError('invalid task, plan or run identifier')
    return value


def read_json(path):
    path = Path(path)
    if path.stat().st_size > 2_000_000:
        raise ValueError('JSON exceeds size limit')
    return json.loads(path.read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


def append_event(directory, kind, **fields):
    import fcntl
    event = {'at': now(), 'kind': kind, **fields}
    path = Path(directory) / 'events.jsonl'
    with path.open('a', encoding='utf-8') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        stream.write(json.dumps(event, ensure_ascii=False) + '\n')
    path.chmod(0o600)


def bind_plan(home, plan_id, plan_home=PLAN_HOME):
    plan_id = identifier(plan_id)
    plan_home = Path(plan_home).resolve(strict=True)
    source = plan_home / (plan_id + '.json')
    if source.is_symlink() or source.resolve().parent != plan_home:
        raise ValueError('plan source must be a regular file inside plan home')
    raw = read_json(source)
    if raw.get('planId') != plan_id:
        raise ValueError('plan identity differs')
    config_path = Path(home) / 'control.json'
    config = read_json(config_path) if config_path.exists() else {}
    if config and config.get('planMapHome') != str(plan_home):
        raise ValueError('registered plan home differs')
    config.update(schemaVersion=1, activePlanId=plan_id, planMapHome=str(plan_home),
                  allowedPlanIds=sorted(set(config.get('allowedPlanIds', []) + [plan_id])),
                  policy=POLICY, updatedAt=now())
    write_json(config_path, config)
    return config


def validate_task(home, task):
    for key in ('taskId', 'planId', 'nodeId'):
        identifier(task.get(key))
    config = read_json(Path(home) / 'control.json')
    if task['planId'] not in config.get('allowedPlanIds', []):
        raise ValueError('bind the master plan before dispatch')
    raw = read_json(Path(config['planMapHome']) / (task['planId'] + '.json'))
    if task['nodeId'] not in raw.get('state', {}).get('nodes', {}):
        raise ValueError('master plan node does not exist')
    if task.get('dataClass') not in ('public', 'synthetic'):
        raise ValueError('only explicitly public or synthetic task packages are supported')
    if task.get('harness') not in ('opencode', 'dsh'):
        raise ValueError('only OpenCode and DSH are enabled; no silent fallback')
    model = task.get('model', FREE_MODEL if task['harness'] == 'opencode' else 'DeepSeek-Flash')
    launch_guard.check_model(task['harness'], model)
    if not isinstance(task.get('title'), str) or not task['title'].strip():
        raise ValueError('task title is required')
    brief = task.get('brief')
    if not isinstance(brief, dict) or not isinstance(brief.get('nonce'), str) or not brief['nonce']:
        raise ValueError('brief with a nonempty nonce is required')
    if not isinstance(brief.get('required_keys'), list) or not brief['required_keys'] or not all(isinstance(key, str) for key in brief['required_keys']):
        raise ValueError('explicit artifact keys are required')
    if len(json.dumps(brief, ensure_ascii=False)) > 24000:
        raise ValueError('task input exceeds bound')
    launch_guard.check_timeout(task.get('timeoutSeconds', 180))
    return task


def begin_run(home, task, *, run_id=None, binding=None):
    task = validate_task(home, task)
    run_id = identifier(run_id) if run_id is not None else task['taskId'][:45] + '-' + uuid.uuid4().hex[:12]
    directory = Path(home) / 'runs' / run_id
    directory.mkdir(parents=True, mode=0o700)
    value = {key: task[key] for key in ('taskId', 'planId', 'nodeId', 'title', 'harness')}
    value.update(runId=run_id, model=task.get('model', FREE_MODEL if task['harness'] == 'opencode' else 'Flash selection pending'),
                 status='running', command={}, input=task['brief'], response='',
                 receipt={}, acceptance={'status': 'pending'}, createdAt=now(), updatedAt=now())
    if binding:
        value.update(binding)
    write_json(directory / 'run.json', value)
    append_event(directory, 'dispatch', text=task['title'], input=task['brief'],
                 planId=task['planId'], nodeId=task['nodeId'], harness=task['harness'], model=value['model'])
    return directory, value


def collect_native(directory, log_path, harness):
    from event_view import normalize_native_event
    log_path = Path(log_path)
    if not log_path.exists():
        return
    if log_path.stat().st_size > 8_000_000:
        append_event(directory, 'error', text='Native transcript exceeded display bound; inspect local evidence separately.')
        return
    for line in log_path.read_text(encoding='utf-8', errors='replace').splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # Do not expose arbitrary native diagnostic/configuration dumps.
        if isinstance(event, dict):
            for shown in normalize_native_event(harness, event):
                fields = dict(shown)
                kind = fields.pop('kind')
                append_event(directory, kind, **fields)


def finish_run(directory, value, receipt, artifact, log_path):
    command = {'argv': receipt.get('command_argv', []), 'cwd': receipt.get('command_cwd', str(Path(artifact).parent.resolve())),
               'stdin': receipt.get('command_stdin', '')}
    value['command'] = command
    append_event(directory, 'command', **command)
    collect_native(directory, log_path, value['harness'])
    value['receipt'] = receipt
    value['model'] = receipt.get('actual_model') or receipt.get('model') or value['model']
    value['response'] = receipt.get('final_text', '')
    if Path(artifact).is_symlink():
        raise ValueError('symlink artifact is not accepted')
    if not value['response'] and Path(artifact).is_file():
        value['response'] = Path(artifact).read_text(encoding='utf-8')[:24000]
    passed = receipt.get('accepted', receipt.get('artifact_verified', False)) is True and receipt.get('exit_code') == 0
    value['status'] = 'awaiting_acceptance' if passed else 'failed'
    value['artifact'] = str(Path(artifact))
    if Path(artifact).is_file():
        value['artifactSha256'] = hashlib.sha256(Path(artifact).read_bytes()).hexdigest()
    value['updatedAt'] = now()
    write_json(directory / 'run.json', value)
    append_event(directory, 'awaiting_acceptance' if passed else 'failed',
                 text='模型与文件回执已返回，等待 Codex 独立验收。' if passed else '执行未通过；未切换其他模型或重试。')
    return value


def run_task(home, task, *, run_id=None, binding=None, resume_session=None, resume_workspace=None):
    directory, value = begin_run(home, task, run_id=run_id, binding=binding)
    prefix = 'task'
    brief_name, output_name = prefix + '-brief.json', prefix + '-design.json'
    write_json(directory / brief_name, task['brief'])
    def on_command(command):
        value['command'] = command
        value['updatedAt'] = now()
        write_json(directory / 'run.json', value)
        append_event(directory, 'command_started', **command)
    try:
        if task['harness'] == 'opencode':
            from opencode_adapter import run
            receipt = run(directory, FREE_MODEL, prefix, task.get('timeoutSeconds', 180), on_command=on_command)
            log_path = directory / (prefix + '-events.jsonl')
        else:
            from dsh_adapter import run
            workspace = directory
            native_brief, native_output = brief_name, output_name
            if resume_workspace is not None:
                workspace = Path(resume_workspace).resolve(strict=True)
                native_brief = value['runId'] + '-brief.json'
                native_output = value['runId'] + '-design.json'
                with (workspace / native_brief).open('xb') as f:
                    f.write((directory / brief_name).read_bytes())
            receipt = run(workspace, native_brief, native_output, timeout=task.get('timeoutSeconds', 180),
                          shared=True, on_command=on_command, resume_session=resume_session, evidence_dir=directory)
            if workspace != directory and receipt['artifact_verified']:
                shutil.copyfile(workspace / native_output, directory / output_name)
            log_path = Path(receipt['events_path'])
        return finish_run(directory, value, receipt, directory / output_name, log_path)
    except Exception as error:
        value.update(status='failed', updatedAt=now(), receipt={'error': type(error).__name__})
        write_json(directory / 'run.json', value)
        append_event(directory, 'failed', text='Dispatch or evidence collection failed: ' + type(error).__name__)
        raise


def import_run(home, task, receipt_path, artifact, log_path):
    """Import explicit existing CLI evidence, labelled with provenance, never fake dispatch."""
    directory, value = begin_run(home, task)
    value['imported'] = True
    value['sourceReceipt'] = str(Path(receipt_path).resolve())
    append_event(directory, 'import', text='已存在的真实 CLI 回执，由 Codex 导入；没有再次派发。')
    return finish_run(directory, value, read_json(receipt_path), artifact, log_path)


def accept_run(home, run_id, evidence, passed=True):
    identifier(run_id)
    root = (Path(home) / 'runs').resolve()
    directory = root / run_id
    if directory.is_symlink() or directory.resolve().parent != root:
        raise ValueError('run directory escapes registered root')
    value = read_json(directory / 'run.json')
    if value.get('status') != 'awaiting_acceptance':
        raise ValueError('only an unaccepted successful attempt can be accepted or rejected')
    if not isinstance(evidence, str) or not evidence.strip() or len(evidence) > 4000:
        raise ValueError('independent acceptance evidence is required')
    artifact = Path(value['artifact'])
    if passed and (artifact.is_symlink() or not artifact.is_file() or hashlib.sha256(artifact.read_bytes()).hexdigest() != value['artifactSha256']):
        raise ValueError('artifact changed since model completion')
    value['acceptance'] = {'status': 'passed' if passed else 'failed', 'by': 'Codex', 'evidence': evidence, 'at': now()}
    value.update(status='accepted' if passed else 'rejected', updatedAt=now())
    write_json(directory / 'run.json', value)
    append_event(directory, 'acceptance', **value['acceptance'])
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=HOME)
    sub = parser.add_subparsers(dest='action', required=True)
    bind = sub.add_parser('bind-plan'); bind.add_argument('plan_id'); bind.add_argument('--plan-home', type=Path, default=PLAN_HOME)
    run = sub.add_parser('run'); run.add_argument('manifest', type=Path)
    accept = sub.add_parser('accept'); accept.add_argument('run_id'); accept.add_argument('--evidence', required=True); accept.add_argument('--reject', action='store_true')
    show = sub.add_parser('show'); show.add_argument('run_id')
    args = parser.parse_args()
    if args.action == 'bind-plan': result = bind_plan(args.home, args.plan_id, args.plan_home)
    elif args.action == 'run': result = run_task(args.home, read_json(args.manifest))
    elif args.action == 'accept': result = accept_run(args.home, args.run_id, args.evidence, not args.reject)
    else: result = read_json(args.home / 'runs' / identifier(args.run_id) / 'run.json')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
