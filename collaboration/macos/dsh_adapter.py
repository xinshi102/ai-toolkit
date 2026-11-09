"""Bounded DSH CLI transport. Artifact semantics always require controller review."""
from __future__ import annotations
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE.parent / 'windows/runtime'))
sys.path.insert(0, str(BASE))
from opencode_adapter import SHARED_LOADER
import launch_guard


def filename(value):
    if not isinstance(value, str) or not value or value in ('.', '..') or Path(value).name != value or '\\' in value:
        raise ValueError('Only a plain filename is permitted')
    return value


def run(directory: Path, brief_filename: str, output_filename: str, timeout=180, shared=True, on_command=None, resume_session=None, evidence_dir=None) -> dict:
    if resume_session is not None and (not isinstance(resume_session,str) or not re.fullmatch(r'session-[A-Za-z0-9-]{1,96}',resume_session)):
        raise ValueError('Invalid DSH session identifier')
    directory = directory.resolve(strict=True)
    brief_filename, output_filename = filename(brief_filename), filename(output_filename)
    # Launch-path gate: direct adapter use must not bypass the coordinator's rules.
    launch_guard.check('dsh', model='DeepSeek-Flash', timeout=timeout, directory=directory,
                       brief=brief_filename, output=output_filename)
    evidence_dir = directory if evidence_dir is None else evidence_dir.resolve(strict=True)
    target = directory / output_filename
    briefpath = directory / brief_filename
    if target.exists() or target.is_symlink():
        raise FileExistsError('Refusing to overwrite evidence')
    if briefpath.is_symlink():
        raise ValueError('Symlink brief forbidden')
    brief = json.loads(briefpath.read_text())
    expected = brief['nonce']
    if not isinstance(expected, str) or not expected:
        raise ValueError('nonce required')
    required = brief['required_keys']
    if not isinstance(required, list) or not all(isinstance(key, str) for key in required):
        raise ValueError('required_keys must be strings')
    events_path = evidence_dir / (target.stem + '-native.jsonl')
    receipt_path = evidence_dir / (target.stem + '-receipt.json')
    if events_path.exists() or receipt_path.exists():
        raise FileExistsError('Refusing to overwrite evidence')
    os.environ.setdefault('XINSHI_DSH_PROGRAM', '/Applications/DeepSeek Harness.app')
    import dsh_workspace
    prompt = (f'Read ONLY {brief_filename} with a file-reading tool. Follow its public synthetic task, '
              f'write ONLY {output_filename} as JSON with all required_keys and nonce exactly preserved. '
              'Then read back that output file and verify it. Do not read parent directories, configuration, '
              'credentials or any other files. Do not use network, terminal commands or spawn agents. '
              f'Use DeepSeek Flash. Final response is a short JSON containing nonce, path and verified true.')
    request = dsh_workspace.request({'cwd': str(directory), 'prompt': prompt, 'permission': 'workspace-write'})
    model_patch = evidence_dir / (target.stem + '-model.patch.yml')
    with model_patch.open('x') as patch:
        patch.write('- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n')
    request['argv'][6:6] = ['--patch', str(model_patch)]
    if resume_session:
        request['argv'][-2:-2] = ['--session-id', resume_session]
    env = os.environ | request['env_delta']
    env['XINSHI_OPENCODE_TIMEOUT'] = str(timeout)
    argv = request['argv']
    if on_command:
        on_command({'argv': argv, 'cwd': str(directory), 'stdin': prompt})
    launch = [sys.executable, '-c', SHARED_LOADER, *argv] if shared else argv
    timed_out = False
    with events_path.open('x') as log:
        proc = subprocess.Popen(launch, cwd=directory, env=env, stdin=subprocess.PIPE, stdout=log,
                                stderr=subprocess.STDOUT, text=True, start_new_session=True)
        try:
            proc.communicate(request['stdin'], timeout=timeout + (10 if shared else 0))
            timed_out = proc.returncode == 124
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        # Also clear descendants if the scoped loader timed out and exited first.
        if timed_out:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    lines = events_path.read_text().splitlines()
    receipt = dsh_workspace.parse_log(lines, 'workspace-write')
    prelaunch_mismatch = False
    if resume_session and proc.returncode == 1 and not receipt.get('session_id'):
        for line in lines:
            try: event=json.loads(line)
            except ValueError: continue
            msg=event.get('message') if isinstance(event,dict) else None
            if isinstance(event,dict) and event.get('type')=='error' and isinstance(msg,str) and msg.startswith(f'session {json.dumps(resume_session)} was recorded in '):
                prelaunch_mismatch=True
    try:
        artifact = json.loads(target.read_text()) if not target.is_symlink() else None
        verified = isinstance(artifact, dict) and artifact.get('nonce') == expected and all(k in artifact for k in required)
    except (OSError, ValueError):
        verified = False
    same_session = resume_session is None or receipt.get('session_id') == resume_session
    receipt.update(resume_session_id=resume_session, same_session_verified=same_session if resume_session else None,
                   prelaunch_failure='session_workspace_mismatch' if prelaunch_mismatch else None,
                   command_argv=argv, command_cwd=str(directory), command_stdin=prompt, model='DeepSeek-Flash',
                   auth_route='shared-scoped-env' if shared else 'stored-or-inherited', persistent_auth_changed=False,
                   artifact_verified=verified, exit_code=proc.returncode, timed_out=timed_out,
                   events_path=str(events_path), output_path=str(target), receipt_path=str(receipt_path),
                   accepted=bool(same_session and verified and receipt['transport_policy_passed'] and proc.returncode == 0 and not timed_out),
                   cleanup_boundary='Process-group cleanup is best effort; workspace policy is application-level, not OS isolation.')
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    return receipt
