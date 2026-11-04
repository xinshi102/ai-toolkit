"""The single adapter roster.

Every name, permission profile, timeout bound and log parser is bound here
exactly once.  ``task_runner.py`` resolves an adapter through this registry and
never branches on an adapter name.
"""
from __future__ import annotations

from adapters.base import Adapter
from adapters.codex import CodexAdapter, CodexWorkspaceAdapter
from adapters.dsh import DshAdapter
from adapters.dsh_text import DshTextAdapter
from adapters.dsh_workspace import DshWorkspaceAdapter
from adapters.local_test import LocalTestAdapter

DEFAULT_ADAPTER = 'codex'

ENTRIES = (
    CodexAdapter(),
    CodexWorkspaceAdapter(),
    DshAdapter(),
    DshTextAdapter(),
    DshWorkspaceAdapter(),
    LocalTestAdapter(),
)

ADAPTERS = {adapter.name: adapter for adapter in ENTRIES}
if len(ADAPTERS) != len(ENTRIES):
    raise RuntimeError('duplicate adapter name in registry')


def names():
    """Registered adapter names, in registry order."""
    return tuple(ADAPTERS)


def get_adapter(name):
    try:
        return ADAPTERS[name]
    except KeyError:
        raise ValueError('unknown adapter') from None


def adapter_for(spec):
    """Resolve the adapter of a manifest; ``codex`` is the historical default."""
    return get_adapter(spec.get('adapter', DEFAULT_ADAPTER))


__all__ = ('ADAPTERS', 'DEFAULT_ADAPTER', 'Adapter', 'adapter_for', 'get_adapter', 'names')
