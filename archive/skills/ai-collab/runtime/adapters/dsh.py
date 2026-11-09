"""Native DSH adapter (headless ``--json``).

The command line for this provider has never been verified on this machine, so
the adapter stays disabled exactly as before: enqueueing is allowed for
read-only work, execution refuses with an explicit reason.  The stall guard
treats it as degraded (wall clock and log growth only).
"""
from __future__ import annotations

from adapters.base import Adapter


class DshAdapter(Adapter):
    name = 'dsh'
    supported_permissions = ('read-only', 'shell-read-only')
    timeout_default = 600
    # No verified tool-event schema: guard degrades this adapter on purpose.
    normalize = None
    disabled_reason = 'dsh native read-only CLI flags not verified; adapter disabled pending verification'

    def probe(self, spec):
        raise ValueError(self.disabled_reason)

    def build_command(self, spec):
        raise ValueError(self.disabled_reason)
