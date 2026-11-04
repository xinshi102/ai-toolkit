"""Extract an explicit remote SSH target from a task prompt.

The dashboard only sees the local control-plane cwd; many tasks actually run
against a remote host via SSH. This reader surfaces the target that is already
written in the prompt, without inventing one when absent.
"""
from __future__ import annotations

import re

_HOST_ROOT = re.compile(r'root@([A-Za-z0-9][A-Za-z0-9.-]*?)(?::(\d{2,5}))?')
_HOST_DOMAIN = re.compile(r'([A-Za-z0-9][A-Za-z0-9.-]*\.(?:woa\.com|com|cn|net|io|org))(?::(\d{2,5}))')
_PATH = re.compile(r'(/(?:data|home|opt|srv|var|workspace)/[^\s"\'`，。；]+)')
_KEYS = ('ssh', 'remote', '远端', '远程', '服务器')


def extract(text: str) -> dict | None:
    text = str(text or '')
    low = text.lower()
    if not any(key in low for key in _KEYS):
        return None
    host = port = path = ''
    match = _HOST_ROOT.search(text) or _HOST_DOMAIN.search(text)
    if match:
        host = match.group(1)
        port = match.group(2) or ''
    match = _PATH.search(text)
    if match:
        path = match.group(1).rstrip('.,;')
    if not host and not path:
        return None
    return {'host': host, 'port': port, 'path': path}


if __name__ == '__main__':
    import json
    import sys
    print(json.dumps(extract(sys.stdin.read()), ensure_ascii=False, indent=2))
