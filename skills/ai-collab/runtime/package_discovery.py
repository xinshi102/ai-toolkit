"""Scan-fallback discovery and root merging for the collab board.

Two complementary paths (the journal explains why both exist):
  * registration: runners append the package dir they just launched;
  * scanning: a background thread walks workspace roots looking for package
    dirs, so packages from projects that were never registered still appear.

The scan is bounded (depth, skipped dirs, wall-clock deadline) and runs off
the HTTP request thread. ``effective_roots`` merges --roots + registry +
last scan, deduplicated and filtered to existing directories.
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import package_registry

SKIP_DIRS = {'node_modules', '.git', '__pycache__', 'venv', '.venv',
             'dist', 'build', 'archive'}
MAX_DEPTH = 8
DEFAULT_SCAN_ROOT = Path(os.environ.get('AI_COLLAB_PROJECTS') or Path.home())
SCAN_INTERVAL = 300          # 5 minutes
SCAN_TIMEOUT = 10.0          # seconds per scan

# Filled by the background thread; read (under lock) by effective_roots.
_scan_cache = {'dirs': [], 'at': 0.0}
_lock = threading.Lock()


def scan_root_env():
    """Roots from AI_COLLAB_SCAN_ROOTS (comma separated), else the default.

    If none of the configured/default roots exist, fall back to the user home.
    """
    raw = os.environ.get('AI_COLLAB_SCAN_ROOTS', '')
    roots = [Path(part.strip()) for part in raw.split(',') if part.strip()] if raw else []
    if not roots:
        roots = [DEFAULT_SCAN_ROOT]
    existing = [r for r in roots if r.is_dir()]
    return existing or [Path.home()]


def _is_package(names) -> bool:
    """A package dir has spec.json/request.json AND stdout*.ndjson."""
    names = set(names)
    has_spec = 'spec.json' in names or 'request.json' in names
    has_stdout = any(n.startswith('stdout') and n.endswith('.ndjson') for n in names)
    return has_spec and has_stdout


def scan_packages(roots=None, max_depth=MAX_DEPTH, timeout=SCAN_TIMEOUT,
                  clock=time.monotonic) -> list:
    """Walk roots with a hard deadline; return found dirs (as str).

    ``clock`` is injectable so tests can force the timeout deterministically.
    """
    roots = list(roots) if roots is not None else scan_root_env()
    deadline = clock() + timeout
    found = []
    for root in roots:
        root = Path(root)
        if not root.is_dir():
            continue
        base = len(root.parts)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            depth = len(Path(dirpath).parts) - base
            if depth >= max_depth:
                dirnames[:] = []            # do not descend further
            if clock() >= deadline:
                return found                # keep whatever we found so far
            if _is_package(filenames):
                found.append(dirpath)
    return found


def _is_under(a, b) -> bool:
    try:
        return Path(a).resolve().is_relative_to(Path(b).resolve())
    except (OSError, ValueError):
        return False


def effective_roots(base_roots) -> list:
    """--roots + registry dirs + scanned dirs, deduped, existing only."""
    base = [Path(r) for r in base_roots]
    result, seen = [], set()

    def push(p):
        try:
            key = os.path.normcase(str(p.resolve()))
        except OSError:
            return
        if key in seen or not p.is_dir():
            return
        seen.add(key)
        result.append(p)

    for r in base:
        push(r)
    with _lock:
        scanned = list(_scan_cache['dirs'])
    for raw in package_registry.read_registered() + scanned:
        p = Path(raw)
        if not p.is_dir():
            continue                          # ignore vanished dirs
        if any(_is_under(p, b) for b in base):
            continue                          # already covered by a --root
        push(p)                               # dedupes by resolved path
    return result


def start_background(interval=SCAN_INTERVAL):
    """Daemon thread: scan once at startup, then every ``interval`` seconds."""
    def loop():
        while True:
            try:
                dirs = scan_packages()
                with _lock:
                    _scan_cache['dirs'] = dirs
                    _scan_cache['at'] = time.time()
            except Exception:
                pass                           # a failed scan must not kill the thread
            time.sleep(interval)
    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t
