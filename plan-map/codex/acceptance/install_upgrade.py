"""Verify installation and rollback on a temporary copy of runtime files."""
from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile

package = Path(__file__).resolve().parents[2]
original = Path('E:/AI-Workspace/Projects/Shared/Plan-Map/codex')
manifest = json.loads((package/'manifest.json').read_text(encoding='utf-8'))
with tempfile.TemporaryDirectory(prefix='plan-map-install-') as temp:
    target=Path(temp)/'codex'
    (target/'node_modules/@modelcontextprotocol/sdk').mkdir(parents=True)
    for item in manifest['files']:
        if item['before'] is not None:
            dest=target/item['path'];dest.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(original/item['path'],dest)
    args=[sys.executable,str(package/'install.py'),'--target',str(target)]
    subprocess.run(args+['--apply'],check=True,capture_output=True)
    for item in manifest['files']:
        assert (target/item['path']).read_bytes()==(package/'codex'/item['path']).read_bytes()
    backup=next((target.parent/'.work').iterdir())
    subprocess.run(args+['--rollback',str(backup)],check=True,capture_output=True)
    for item in manifest['files']:
        if item['before'] is None:assert not (target/item['path']).exists()
        else:assert (target/item['path']).read_bytes()==(original/item['path']).read_bytes()
    (target/'server.js').write_text('user modification',encoding='utf-8')
    assert subprocess.run(args+['--apply'],capture_output=True).returncode != 0
    assert (target/'server.js').read_text()=='user modification'
print('PASS: install, byte-exact rollback, reject changed target')
