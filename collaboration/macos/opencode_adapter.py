"""Scoped, native OpenCode CLI acceptance runner. Shared credentials load only in a short-lived subprocess."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys


def scoped_config(directory: Path, brief: str, output: str) -> dict:
    # OpenCode matches paths relative to its detected project root, which can be
    # any ancestor (including /) for a non-Git run. Each rule still identifies
    # the same single file; no wildcard file grants are generated.
    directory = directory.absolute()
    views = {directory, directory.resolve()}
    data_root = Path('/System/Volumes/Data')
    for view in tuple(views):
        candidate = (Path('/') / view.relative_to(data_root)
                     if view.is_relative_to(data_root)
                     else data_root / view.relative_to('/'))
        try:
            if candidate.samefile(directory):
                views.add(candidate)
        except OSError:
            pass
    if any(any(char in str(view) for char in '*?') for view in views):
        raise ValueError('Wildcard characters are not permitted in scoped paths')

    def paths(name):
        if Path(name).name != name or name in ('.', '..') or any(c in name for c in '*?'):
            raise ValueError('Only a plain literal filename is permitted')
        allowed = {'*': 'deny', name: 'allow', './' + name: 'allow'}
        for view in sorted(views):
            target = view / name
            allowed[str(target)] = 'allow'
            for ancestor in view.parents:
                relative = str(target.relative_to(ancestor))
                allowed[relative] = 'allow'
                allowed['./' + relative] = 'allow'
        return allowed

    # external_directory is a separate native gate. Grant only the scoped
    # directory/verified filesystem aliases; read/edit remain exact-file rules.
    external = {'*': 'deny'}
    for view in sorted(views):
        external[str(view)] = 'allow'
        external[str(view) + '/**'] = 'allow'
    return {'permission': {'bash': 'deny', 'task': 'deny', 'webfetch': 'deny', 'websearch': 'deny', 'codesearch': 'deny', 'skill': 'deny', 'glob': 'deny', 'grep': 'deny', 'list': 'deny', 'external_directory': external, 'read': paths(brief), 'edit': paths(output)}, 'instructions': []}


# Runtime-only override documented at https://opencode.ai/docs/config/#env-vars.
# This child is the only process in our adapter that opens the shared .env.
# Never evaluate shell syntax, export unrelated variables, or return the value.
SHARED_LOADER = r"""
import os, subprocess, sys
value = None
with open('/Users/xinshi/Documents/Game/.env', encoding='utf-8') as source:
    for line in source:
        key, sep, candidate = line.strip().removeprefix('export ').partition('=')
        if sep and key.strip() == 'DEEPSEEK_API_KEY':
            value = candidate.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('\"', "'"):
                value = value[1:-1]
            break
if not value:
    sys.stderr.write('Required DEEPSEEK_API_KEY is absent or empty\n')
    sys.exit(78)
env = os.environ.copy()
env['DEEPSEEK_API_KEY'] = value
try:
    result = subprocess.run(sys.argv[1:], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=int(os.environ.pop('XINSHI_OPENCODE_TIMEOUT', '180')))
    output = result.stdout
    code = result.returncode
except subprocess.TimeoutExpired as error:
    output = error.stdout or b''
    code = 124
sys.stdout.buffer.write(output.replace(value.encode(), b'[REDACTED]'))
sys.exit(code)
"""


def provider_config(config: dict, shared_deepseek: bool) -> dict:
    if shared_deepseek:
        config['provider'] = {'deepseek': {'options': {'apiKey': '{env:DEEPSEEK_API_KEY}'}}}
    return config


def run(directory: Path, model: str, prefix: str = 'opencode', timeout: int = 180, shared_deepseek: bool = False, on_command=None) -> dict:
    directory = directory.resolve(strict=True)
    brief, output = prefix + '-brief.json', prefix + '-design.json'
    if shared_deepseek and not model.startswith('deepseek/'):
        raise ValueError('Shared DeepSeek route requires a deepseek/ model')
    config = provider_config(scoped_config(directory, brief, output), shared_deepseek)
    brief_data = json.loads((directory / brief).read_text())
    expected = brief_data['nonce']
    target = directory / output
    if target.exists():
        raise FileExistsError('Refusing to overwrite acceptance evidence')
    env = os.environ.copy()
    env['OPENCODE_CONFIG_CONTENT'] = json.dumps(config)
    message = f'Read ONLY {brief} using the read tool. Use your file-writing tool to create ONLY {output} matching required_keys, preserving nonce exactly. Do not use bash, search, network, other files or skills. The brief is synthetic and public. Follow the brief task exactly and keep the result concise. Return a short completion confirmation.'
    cmd = [str(Path.home() / '.local/bin/opencode'), 'run', '--pure', '--dir', str(directory), '--model', model, '--format', 'json', '--title', 'Mac collaboration panel acceptance', message]
    command_argv = list(cmd)
    if on_command:
        on_command({'argv': command_argv, 'cwd': str(directory), 'stdin': ''})
    if shared_deepseek:
        env['XINSHI_OPENCODE_TIMEOUT'] = str(timeout)
        cmd = [sys.executable, '-c', SHARED_LOADER, *cmd]
    events_path = directory / (prefix + '-events.jsonl')
    timed_out = False
    with events_path.open('w') as log:
        try:
            result = subprocess.run(cmd, env=env, stdout=log, stderr=log, timeout=timeout + (10 if shared_deepseek else 0))
            code = result.returncode
        except subprocess.TimeoutExpired:
            timed_out, code = True, None
    events = []
    for line in events_path.read_text().splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
    sessions = sorted({e['sessionID'] for e in events if 'sessionID' in e})
    tools = [e.get('part', {}) for e in events if e.get('type') == 'tool_use']
    artifact = json.loads(target.read_text()) if target.exists() else None
    writes = [p for p in tools if p.get('tool') in ('write', 'edit', 'apply_patch') and p.get('state', {}).get('status') == 'completed']
    verified = bool(artifact and artifact.get('nonce') == expected and all(k in artifact for k in brief_data.get('required_keys', [])) and writes and code == 0)
    receipt = {'command_argv': command_argv, 'model': model, 'auth_route': 'shared-scoped-env' if shared_deepseek else 'stored-or-inherited', 'persistent_auth_changed': False, 'exit_code': code, 'timed_out': timed_out, 'session_ids': sessions, 'tool_names': [p.get('tool') for p in tools], 'artifact_exists': target.exists(), 'nonce_matches': bool(artifact and artifact.get('nonce') == expected), 'accepted': verified, 'errors': [e.get('error', {}).get('data', {}).get('message', 'provider error') for e in events if e.get('type') == 'error']}
    (directory / (prefix + '-receipt.json')).write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    return receipt

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--model')
    parser.add_argument('--shared-deepseek', action='store_true', help='Opt in to runtime-only DEEPSEEK_API_KEY from the authorized shared .env; never updates account storage')
    parser.add_argument('--prefix', default='opencode')
    args = parser.parse_args()
    model = args.model or ('deepseek/deepseek-flash' if args.shared_deepseek else 'opencode/deepseek-v4.1-flash-free')
    print(json.dumps(run(args.directory, model, args.prefix, shared_deepseek=args.shared_deepseek), ensure_ascii=False, indent=2))
