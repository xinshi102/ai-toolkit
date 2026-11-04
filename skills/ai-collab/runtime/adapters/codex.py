"""Codex CLI adapter: ``codex`` (read-only) and ``codex-workspace``.

The launch request is auditable only; execution permission comes from the
native sandbox flag plus the audited feature/MCP disables verified here.  No
credentials, global configuration or live databases are read.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess

import guard
from adapters.base import Adapter, hidden_options

# Features and integrations that must be verifiably off for a single run.
DISABLED_FEATURES = ("hooks", "plugins", "remote_plugin", "apps", "computer_use", "browser_use",
                     "browser_use_external", "image_generation", "multi_agent", "workspace_dependencies")


def native_request(spec, sandbox):
    """Fixed argv for one one-shot native Codex turn."""
    binary = shutil.which("codex.exe" if os.name == "nt" else "codex")
    if not binary:
        raise ValueError("native harness executable not available")
    # Batch launchers would implicitly introduce cmd.exe parsing. Require a native executable.
    if os.name == "nt" and Path(binary).suffix.lower() not in (".exe", ".com"):
        raise ValueError("native .exe harness required; batch launchers are not accepted")
    return {"argv": [binary, "--no-daemon", "-a", "never", "--cd", spec["cwd"],
                     "exec", "--ephemeral", "--skip-git-repo-check", "--json",
                     "--sandbox", sandbox, "-"], "stdin": spec.get("prompt", ""),
            "cwd": spec["cwd"], "env_delta": {}}


def restricted_codex_request(spec, sandbox):
    """Verify feature/MCP disables, then return the launch request."""
    request = native_request(spec, sandbox)
    binary = request["argv"][0]

    def probe(argv):
        completed = subprocess.run(argv, cwd=spec["cwd"], capture_output=True, text=True,
                                   encoding="utf-8", errors="replace", timeout=20, shell=False,
                                   **hidden_options())
        if completed.returncode:
            raise ValueError("native permission preflight failed (raw configuration output withheld)")
        return completed.stdout

    def mcp_summary(output):
        value = json.loads(output)
        if not isinstance(value, list):
            raise ValueError("unrecognized MCP list schema")
        summary = []
        for item in value:
            name, enabled = item.get("name"), item.get("enabled")
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name) or type(enabled) is not bool:
                raise ValueError("unverifiable MCP identity or state")
            summary.append({"name": name, "enabled": enabled})
        return summary

    discovered = mcp_summary(probe([binary, "--no-daemon", "mcp", "list", "--json"]))
    options = ["-c", "notify=[]"]
    for feature in DISABLED_FEATURES:
        options += ["--disable", feature]
    for item in discovered:
        options += ["-c", f"mcp_servers.{item['name']}.enabled=false"]
    prefix = [binary, "--no-daemon", *options]
    features = {}
    for line in probe([*prefix, "features", "list"]).splitlines():
        cells = line.split()
        if len(cells) >= 3 and cells[-1] in ("true", "false"):
            features[cells[0]] = cells[-1] == "true"
    if any(features.get(feature) is not False for feature in DISABLED_FEATURES):
        raise ValueError("required capability disable could not be verified")
    effective = mcp_summary(probe([*prefix, "mcp", "list", "--json"]))
    if {v["name"] for v in effective} != {v["name"] for v in discovered} or any(v["enabled"] for v in effective):
        raise ValueError("effective MCP disable verification failed")
    request["argv"] = [binary, *options, *request["argv"][1:]]
    request["preflight"] = {"features": {f: False for f in DISABLED_FEATURES}, "mcp": effective,
                            "scope": "single-invocation audited feature/MCP disables plus native shell sandbox",
                            "sandbox": sandbox}
    return request


class _CodexAdapter(Adapter):
    timeout_bounds = (10, 3600)
    normalize = staticmethod(guard.normalize_codex)
    sandbox = 'read-only'

    def probe(self, spec):
        return restricted_codex_request(spec, self.sandbox)['preflight']

    def build_command(self, spec):
        request = restricted_codex_request(spec, self.sandbox)
        spec['_preflight'] = request['preflight']
        return request['argv'], request['stdin']

    def parse_result(self, lines, spec, result, cancelled):
        native_events = []
        for line in lines:
            try:
                event = json.loads(line)
                if isinstance(event, dict):
                    native_events.append(event)
            except ValueError:
                pass
        finals = [e['item']['text'] for e in native_events if e.get('type') == 'item.completed'
                  and e.get('item', {}).get('type') == 'agent_message'
                  and isinstance(e['item'].get('text'), str)]
        merged = {}
        if finals:
            merged['final_text'] = finals[-1]
            try:
                merged['final_json'] = json.loads(finals[-1])
            except ValueError:
                pass
        merged['transport_policy_passed'] = bool(
            finals and result.get('terminal_event') == 'turn.completed'
            and not any(e.get('type') in ('error', 'turn.failed') for e in native_events))
        merged['semantic_acceptance'] = 'controller-required'
        return merged


class CodexAdapter(_CodexAdapter):
    name = 'codex'
    supported_permissions = ('read-only', 'shell-read-only')
    sandbox = 'read-only'


class CodexWorkspaceAdapter(_CodexAdapter):
    name = 'codex-workspace'
    supported_permissions = ('workspace-write',)
    workspace_write = True
    workspace_write_only = True
    owned_process = True
    sandbox = 'workspace-write'
