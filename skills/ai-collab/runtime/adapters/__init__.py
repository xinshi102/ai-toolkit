"""Uniform execution adapters for the ai-collab runtime.

One interface for all nine adapters -- ``name``, ``supported_permissions``,
``probe()``, ``build_command(spec)``, ``normalize`` and ``parse_result(...)`` --
and one registry (``adapters.registry``) that holds the only adapter roster.
``normalize`` is the M1 guard function itself, so stall detection keeps one
implementation.  Security boundaries, permission refusals, tool allowlists,
empty MCP configuration, disabled hooks, the no-redirect launch paths are unchanged.
"""
from adapters.base import Adapter, hidden_options
from adapters.registry import ADAPTERS, DEFAULT_ADAPTER, adapter_for, get_adapter, names

__all__ = ('ADAPTERS', 'DEFAULT_ADAPTER', 'Adapter', 'adapter_for', 'get_adapter',
           'hidden_options', 'names')
