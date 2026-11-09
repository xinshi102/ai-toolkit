"""One writable directory for ai-collab user data.

Default location: ``~/.ai-collab``; override with ``AI_COLLAB_DATA``.
The installation directory is treated as read-only: runtime data is never
created there.  On first use legacy files that still live next to the
installed runtime are copied into the data directory.  The old file is kept
as ``<name>.bak`` when the installation is writable, and left untouched when
it is read-only, so migration never loses the source.

Only the standard library is used.  Migration is idempotent: an existing
target is never overwritten and a second run performs no copy.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import threading
from pathlib import Path

APP_DIR = '.ai-collab'
ENV = 'AI_COLLAB_DATA'

RUNTIME_DIR = Path(__file__).resolve().parent
INSTALL_DIR = RUNTIME_DIR.parent

JSON_NAMES = (
    'task_archive.json',
    'task_groups.json',
    'task_taxonomy.json',
    'dispatch_policy.json',
    'dispatch_contracts.json',
)
DB_NAMES = (
    'tasks.sqlite',
    'collab.sqlite',
    'controller-usage.sqlite',
)
ARTIFACTS = JSON_NAMES + DB_NAMES

_lock = threading.Lock()
_warmed = set()
_install_override = None


def install_dir() -> Path:
    """Directory that represents the installed skill (read-only source)."""
    return Path(_install_override).resolve() if _install_override else INSTALL_DIR


def set_install_dir(path) -> None:
    """Point legacy lookups at another installation copy (tests/spotcheck)."""
    global _install_override
    _install_override = Path(path).resolve() if path else None
    with _lock:
        _warmed.clear()


def data_dir() -> Path:
    """Writable user data root; not created by this call."""
    override = os.environ.get(ENV)
    if override:
        return Path(override).expanduser().resolve()
    return (Path.home() / APP_DIR).resolve()


def path(name: str) -> Path:
    """Target path for a managed artifact."""
    if name not in ARTIFACTS:
        raise ValueError('unknown user data artifact: %s' % name)
    return data_dir() / name


def legacy_paths(name: str) -> list:
    """Old locations, most specific first, relative to the installation."""
    if name not in ARTIFACTS:
        raise ValueError('unknown user data artifact: %s' % name)
    install = install_dir()
    runtime = install / 'runtime'
    if name in JSON_NAMES:
        return [runtime / name]
    return [install / '.work' / name, runtime / name]


def db_path(name: str, state=None) -> Path:
    """Resolve a SQLite file's location.

    ``state`` is a per-project / per-flow durable state directory.  A caller
    that supplies one has explicitly chosen where its database lives, so it
    always stays project-local: this keeps per-project databases separate (no
    merge into one file) and preserves the queue's ``project_root`` binding.
    Only a call without ``state`` uses the unified default in the writable
    user data directory, so the read-only installation is never written to.
    """
    if name not in DB_NAMES:
        raise ValueError('unknown database: %s' % name)
    if state is not None:
        return Path(state).absolute() / name
    ensure_all()
    return path(name)


def _copy_sqlite(source: Path, target: Path) -> None:
    """Consistent copy including committed WAL pages."""
    src = sqlite3.connect('file:%s?mode=ro' % source.as_posix(), uri=True, timeout=5)
    try:
        dst = sqlite3.connect(str(target), timeout=5)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _retire(source: Path):
    """Keep the legacy file as ``.bak`` when the installation allows it."""
    backup = source.with_name(source.name + '.bak')
    if backup.exists():
        return None
    try:
        source.replace(backup)
    except OSError:
        return None
    return str(backup)


def _migrate_one(name: str, target_root: Path, install: Path) -> dict:
    target = target_root / name
    if target.exists():
        return {'name': name, 'status': 'kept', 'path': str(target)}
    source = next((p for p in legacy_paths_at(name, install) if p.is_file()), None)
    if source is None:
        return {'name': name, 'status': 'absent', 'path': str(target)}
    target_root.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + '.migrating')
    try:
        if name in DB_NAMES:
            _copy_sqlite(source, temporary)
        else:
            shutil.copy2(source, temporary)
        os.replace(temporary, target)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return {'name': name, 'status': 'migrated', 'source': str(source),
            'path': str(target), 'backup': _retire(source)}


def legacy_paths_at(name: str, install: Path) -> list:
    install = Path(install)
    runtime = install / 'runtime'
    if name in JSON_NAMES:
        return [runtime / name]
    return [install / '.work' / name, runtime / name]


def _is_checkout(install: Path) -> bool:
    """A git checkout is a development copy, not an installed skill."""
    return (install / '.git').exists() or (install.parent / '.git').exists()


def migrate(install=None, target=None) -> list:
    """Copy legacy artifacts into ``target`` (default: data dir).

    Never overwrites an existing target and never deletes the source.
    """
    install = Path(install).resolve() if install is not None else install_dir()
    target_root = Path(target).resolve() if target is not None else data_dir()
    with _lock:
        return [_migrate_one(name, target_root, install) for name in ARTIFACTS]


def ensure_all() -> list:
    """Run migration once per (data dir, installation) pair.

    Automatic migration is skipped for a source checkout so running tests or
    a development copy never rewrites tracked files.  An installed copy has
    no ``.git`` and migrates on first runtime start.
    """
    if _is_checkout(install_dir()):
        return []
    key = (str(data_dir()), str(install_dir()))
    with _lock:
        if key in _warmed:
            return []
        _warmed.add(key)
    try:
        return migrate()
    except Exception:
        with _lock:
            _warmed.discard(key)
        raise


def ensure(name: str) -> None:
    """Make a managed artifact available before a write-heavy default use."""
    ensure_all()
