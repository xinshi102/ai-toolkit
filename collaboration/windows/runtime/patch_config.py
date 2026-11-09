"""Render only bundled DSH overlays; never change host configuration."""
import hashlib
import json
import os
from pathlib import Path
import tempfile

BASE = Path(__file__).resolve().parent
PLUGINS = {'dsh-text.patch.yml': 'dsh-text-guard.mjs',
           'dsh-workspace.patch.yml': 'dsh-workspace-audit.mjs',
           'dsh-workspace-readonly.patch.yml': 'dsh-workspace-audit.mjs'}
TOKEN = '__XINSHI_PLUGIN_PATH__'


def render_patch(template):
    template = Path(template).resolve()
    if template.parent != BASE or template.name not in PLUGINS:
        raise ValueError('only bundled DSH overlay templates are supported')
    plugin = BASE / PLUGINS[template.name]
    if not plugin.is_file():
        raise ValueError('required bundled DSH protection plugin missing')
    source = template.read_text(encoding='utf-8')
    if source.count(TOKEN) != 1:
        raise ValueError('invalid bundled DSH overlay placeholder')
    rendered = source.replace(TOKEN, json.dumps(str(plugin), ensure_ascii=True))
    digest = hashlib.sha256(rendered.encode('utf-8')).hexdigest()
    directory = BASE.parent / '.work/generated-overlays'
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / (digest + '.patch.yml')
    if target.is_file() and target.read_text(encoding='utf-8') == rendered:
        return target
    descriptor, temporary = tempfile.mkstemp(dir=directory, suffix='.tmp')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            output.write(rendered)
        os.replace(temporary, target)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()
    return target
