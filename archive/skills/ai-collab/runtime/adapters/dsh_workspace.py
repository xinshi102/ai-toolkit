"""DSH workspace-write adapter: fixed profile plus the audit plugin."""
from __future__ import annotations

import dsh_workspace
import guard
from adapters.base import Adapter


class DshWorkspaceAdapter(Adapter):
    name = 'dsh-workspace'
    supported_permissions = ('read-only', 'workspace-write')
    workspace_write = True
    native_permission_only = True
    owned_process = True
    timeout_bounds = (10, 3600)
    normalize = staticmethod(guard.normalize_dsh)

    def probe(self, spec):
        request = dsh_workspace.request(spec)
        return request.get('preflight', {'permission': spec['permission']})

    def build_command(self, spec):
        request = dsh_workspace.request(spec)
        spec['_native_env'] = request['env_delta']
        spec['_preflight'] = request.get('preflight', {'permission': spec['permission']})
        return request['argv'], request['stdin']

    def parse_result(self, lines, spec, result, cancelled):
        return dsh_workspace.parse_log(lines, spec['permission'])
