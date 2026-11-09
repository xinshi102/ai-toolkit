"""One adapter contract for every execution path.

An adapter owns everything that used to be an ``if spec['adapter'] == ...``
branch in ``task_runner.py``:

    name                  registry key, unchanged from the manifest
    supported_permissions declared native permission profile
    probe(spec)           version and capability detection, returns preflight
    build_command(spec)   argv/stdin (and env/preflight evidence)
    normalize             M1 guard normalizer, never re-implemented here
    parse_result(...)     log verification, merged into the task receipt

The registry (``adapters.registry``) is the only place that lists adapter
names.  Permission gates, timeout bounds and stop conditions stay exactly as
they were; this module only gives them one address.

Security boundaries are unchanged.  ``probe``/``build_command`` may inspect the
installed program, but they never read credentials, global configuration, MCP
approval or live databases.
"""
from __future__ import annotations

import os
import subprocess


def hidden_options(detached=False):
    """Launch flags shared by every adapter and by the queue workers."""
    if os.name == "nt":
        flags = subprocess.CREATE_NO_WINDOW
        if detached:
            flags |= subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        return {"creationflags": flags}
    return {"start_new_session": True} if detached else {}


class Adapter:
    """Base class; subclasses set the data or override the hooks."""

    name = ''
    # Declared profiles.  ``supported_permissions`` is the documented answer to
    # "what may this adapter be asked to run"; the gates below keep the exact
    # historical rejection messages.
    supported_permissions = ()
    workspace_write = False          # accepts workspace-write
    workspace_write_only = False     # rejects every other permission
    native_permission_only = False   # explicit read/write only, no shell-read-only
    read_only_error = ''

    owned_process = False            # launch through OwnedProcess
    test_only = False                # local fixture engine, never a native AI
    shared_host = False              # a shared desktop host this queue cannot own
    shared_host_reason = ''
    shared_unknown_error = ''
    shared_failure_reason = ''

    timeout_bounds = None            # (min, max) seconds, or None
    timeout_default = 600
    timeout_label = 'native execution'

    # Log vocabulary for the shared post-processing steps.
    terminal_types = ('turn.completed', 'turn.failed', 'error')
    success_events = ('turn.completed',)

    #: Filled from guard.normalizer_for(name); ``None`` means the adapter is
    #: deliberately degraded to wall-clock/log-growth detection only.
    normalize = None

    def __repr__(self):
        return '<adapter %s>' % self.name

    # -- permission gate ---------------------------------------------------
    def permission_error(self, permission):
        """Return the historical rejection message, or None when allowed."""
        if permission == 'workspace-write' and not self.workspace_write:
            return 'workspace-write requires an explicit workspace adapter'
        if self.workspace_write_only and permission != 'workspace-write':
            return self.read_only_error or '%s requires workspace-write' % self.name
        if self.native_permission_only and permission not in ('workspace-write', 'read-only'):
            return 'workspace provider requires explicit native permission'
        if permission not in self.supported_permissions:
            return 'the %s adapter does not support %s' % (self.name, permission)
        return None

    def validate_adapter(self, spec, context):
        """Manifest checks that belong to one adapter, before generic checks."""
        problem = self.permission_error(spec['permission'])
        if problem:
            raise ValueError(problem)
        if self.timeout_bounds is not None:
            timeout = spec.get('timeout_seconds', self.timeout_default)
            low, high = self.timeout_bounds
            if type(timeout) not in (int, float) or not low <= timeout <= high:
                raise ValueError('%s timeout_seconds must be %d..%d'
                                 % (self.timeout_label, low, high))

    def validate_tail(self, spec, context):
        """Manifest checks that historically ran after the artifact checks."""

    # -- manifest preparation ---------------------------------------------
    def prepare_spec(self, spec):
        """Adapter-owned resources, added before the artifact checks."""
        return spec

    def prepare_enqueue(self, spec, lookup):
        """Session/continuation rules that need queue state.

        ``lookup(task_id)`` returns the stored row or None.
        """
        return spec

    def prepare_launch(self, spec, state, task):
        """Per-task launch files (for example a cancellation marker)."""

    def stop(self, process, spec):
        """Adapter-specific courtesy stop before the shared force stop."""

    def denial_monitor(self, log):
        """Return an incremental policy-denial monitor, or None."""
        return None

    # -- execution ---------------------------------------------------------
    def probe(self, spec):
        """Version and capability detection; returns preflight evidence."""
        raise NotImplementedError(self.name)

    def build_command(self, spec):
        """Return ``(argv, stdin_text)``.

        Implementations may also set ``spec['_preflight']`` and
        ``spec['_native_env']`` for the caller to record and apply.
        """
        raise NotImplementedError(self.name)

    def parse_result(self, lines, spec, result, cancelled):
        """Verify one log and return the fields to merge into the receipt.

        ``_force_unknown`` may be returned to make an unconfirmed termination
        explicit; the caller stops the task as ``unknown`` and keeps resources.
        """
        return {}

    def on_finish(self, state, task, spec, result, state_name):
        """Optional export of the finished task to the board or a workflow."""
