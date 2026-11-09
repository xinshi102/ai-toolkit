#!/usr/bin/env python3
"""Manual, reversible Codex HTTP streaming compatibility setting. Never handles auth."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import tomllib

PROVIDER = 'openai-http'
SETTINGS = {
    'name': 'OpenAI HTTP streaming',
    'base_url': 'https://chatgpt.com/backend-api/codex',
    'wire_api': 'responses',
    'requires_openai_auth': True,
    'supports_websockets': False,
    'supports_standalone_web_search': True,
}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def atomic_write(path, data):
    fd, name = tempfile.mkstemp(prefix='.http-transport-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def summary(path):
    config = tomllib.loads(path.read_text())
    selected = config.get('model_provider', 'openai')
    provider = config.get('model_providers', {}).get(PROVIDER, {})
    return {'model': config.get('model'), 'modelProvider': selected,
            'httpStreamingSelected': selected == PROVIDER and provider == SETTINGS,
            'authUnchanged': True}

def apply(path):
    raw = path.read_bytes()
    config = tomllib.loads(raw.decode())
    if summary(path)['httpStreamingSelected']:
        return {'changed': False, **summary(path)}
    if config.get('model_provider', 'openai') not in ('openai', PROVIDER):
        raise ValueError('Existing custom provider requires an explicit migration')
    if PROVIDER in config.get('model_providers', {}):
        raise ValueError('Existing openai-http provider differs; refusing overwrite')
    # Replace only a root-level assignment; append a separately named provider.
    text = raw.decode()
    first_table = re.search(r'^\s*\[', text, re.M)
    boundary = first_table.start() if first_table else len(text)
    root, rest = text[:boundary], text[boundary:]
    if re.search(r'^model_provider\s*=', root, re.M):
        root = re.sub(r'^model_provider\s*=.*$', 'model_provider = "openai-http"', root, count=1, flags=re.M)
    else:
        root = 'model_provider = "openai-http"\n' + root
    block = '\n\n# HTTP streaming compatibility: preserves native ChatGPT authentication.\n[model_providers.openai-http]\n'
    for key, value in SETTINGS.items():
        block += key + ' = ' + (str(value).lower() if isinstance(value, bool) else json.dumps(value)) + '\n'
    updated = (root + rest + block).encode()
    parsed = tomllib.loads(updated.decode())
    expected = dict(config)
    expected['model_provider'] = PROVIDER
    expected['model_providers'] = dict(config.get('model_providers', {}), **{PROVIDER: SETTINGS})
    if parsed != expected:
        raise ValueError('Unexpected unrelated configuration change')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = path.parent / 'backups' / ('http-transport-' + stamp)
    backup.mkdir(parents=True, mode=0o700)
    atomic_write(backup / 'config.toml', raw)
    receipt = {'configPath': str(path), 'originalSha256': digest(raw),
               'appliedSha256': digest(updated), 'createdAt': stamp,
               'backupPath': str(backup / 'config.toml')}
    atomic_write(backup / 'receipt.json', (json.dumps(receipt, indent=2) + '\n').encode())
    # Check for a concurrent edit immediately before replacing.
    if path.read_bytes() != raw:
        raise ValueError('Configuration changed concurrently; no overwrite performed')
    atomic_write(path, updated)
    return {'changed': True, 'receiptPath': str(backup / 'receipt.json'), **summary(path)}

def rollback(path, receipt_path):
    receipt = json.loads(receipt_path.read_text())
    if str(path) != receipt['configPath'] or digest(path.read_bytes()) != receipt['appliedSha256']:
        raise ValueError('Current configuration differs; refusing to discard newer edits')
    original = Path(receipt['backupPath']).read_bytes()
    if digest(original) != receipt['originalSha256']:
        raise ValueError('Backup integrity check failed')
    atomic_write(path, original)
    return {'restored': True, **summary(path)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'apply', 'rollback'])
    parser.add_argument('--config', type=Path, default=Path.home() / '.codex/config.toml')
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    if args.action == 'apply':
        result = apply(args.config)
    elif args.action == 'rollback':
        if not args.receipt:
            parser.error('rollback requires --receipt')
        result = rollback(args.config, args.receipt)
    else:
        result = summary(args.config)
    print(json.dumps(result, ensure_ascii=False))
