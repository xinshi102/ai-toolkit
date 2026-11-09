"""Prompt-only DSH adapter (``dsh-text``).

The fixed one-shot patch plus the required-injection guard plugin deny every
tool before execution, so the run can only transport text.  The guard files are
fixed next to the runtime; nothing is read from credentials or global config.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

from adapters.base import Adapter, hidden_options

#: Runtime directory that owns the patch and its guard plugin.
RUNTIME = Path(os.path.abspath(__file__)).parent.parent
PROGRAM = Path(os.environ.get('DSH_PROGRAM') or Path(os.environ.get('LOCALAPPDATA', '')) / 'Programs' / 'DSH')


def restricted_dsh_text_request(spec):
    """Prompt-only DSH; the required plugin denies every tool before execution."""
    binary = PROGRAM / "DeepSeek Harness.exe"
    archive = PROGRAM / "resources/app.asar"
    script = archive / "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
    patch, guard = RUNTIME / "dsh-text.patch.yml", RUNTIME / "dsh-text-guard.mjs"
    # app.asar is one OS file: only Electron's fs can stat its virtual contents.
    if not all(path.is_file() for path in (binary, archive, patch, guard)):
        raise ValueError("dsh-text executable or required protection files missing")
    probe_script = ("const fs=require('node:fs');process.stdout.write(JSON.stringify({entry_file:"
                    "fs.statSync(" + json.dumps(str(script)) + ").isFile()}));")
    probe = subprocess.run([str(binary), "-e", probe_script], cwd=spec["cwd"],
        env=dict(os.environ, ELECTRON_RUN_AS_NODE="1"), capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=20, shell=False, **hidden_options())
    try:
        entry_verified = probe.returncode == 0 and json.loads(probe.stdout) == {"entry_file": True}
    except ValueError:
        entry_verified = False
    if not entry_verified:
        raise ValueError("dsh-text fixed ASAR entry preflight failed; native diagnostic output withheld")
    return {"argv": [str(binary), str(script), "--profile", "headless", "--patch",
                     str(patch), "--json", "-"],
            "stdin": spec.get("prompt", ""), "cwd": spec["cwd"],
            "env_delta": {"ELECTRON_RUN_AS_NODE": "1", "DSH_PERMISSION_MODE": "read-only"}}


def parse_dsh_text_log(lines):
    """Transport/policy proof only. The controller must accept answer semantics."""
    audits, events, errors = [], [], []
    for line in lines:
        if line.startswith("DSH_TEXT_AUDIT "):
            try:
                audit = json.loads(line[len("DSH_TEXT_AUDIT "):])
                if not isinstance(audit, dict):
                    raise ValueError("not an object")
                audits.append(audit)
            except ValueError:
                errors.append("malformed guard audit")
        else:
            try:
                event = json.loads(line)
                if isinstance(event, dict):
                    events.append(event)
            except ValueError:
                pass  # Native startup diagnostics are not NDJSON events.
    ready = [a for a in audits if a.get("type") == "guard_ready"]
    sessions = [e for e in events if e.get("type") == "session"]
    session_id = sessions[0].get("sessionId") if len(sessions) == 1 else None
    policies = [a for a in audits if a.get("type") == "effective_policy"]
    policy_ok = bool(session_id and policies) and all(
        p.get("sessionId") == session_id and p.get("sandbox") == "read-only"
        and p.get("approval") == "never" and p.get("allToolsDenied") is True
        and p.get("valid") is True for p in policies)
    blocked = sum(a.get("type") == "blocked_tool" for a in audits)
    tools = sum(e.get("type") in ("tool_call", "tool_result") for e in events)
    ends = [e for e in events if e.get("type") == "status" and e.get("phase") == "turn_end"]
    completed = len(ends) == 1 and ends[0].get("reason", {}).get("kind") == "completed"
    finals = [e for e in events if e.get("type") == "final"]
    final = finals[0].get("text") if len(finals) == 1 else None
    guard_ok = len(ready) == 1 and ready[0].get("allToolsDenied") is True
    if any(e.get("type") == "error" for e in events):
        errors.append("native error event")
    passed = bool(guard_ok and policy_ok and completed and isinstance(final, str)
                  and final.strip() and not blocked and not tools and not errors)
    result = {"guard_ready": guard_ok, "session_id": session_id,
              "effective_policies": policies, "blocked_tool_count": blocked,
              "tool_event_count": tools, "policy_verified": policy_ok,
              "protocol_errors": errors, "transport_policy_passed": passed,
              "terminal_event": "turn.completed" if passed else "dsh-text.rejected",
              "final_text": final, "semantic_acceptance": "controller-required"}
    if isinstance(final, str):
        try:
            result["final_json"] = json.loads(final)
        except ValueError:
            pass
    return result


class DshTextAdapter(Adapter):
    name = 'dsh-text'
    supported_permissions = ('read-only',)
    timeout_bounds = (10, 600)
    timeout_default = 180
    timeout_label = 'dsh-text'
    # No tool events by design: every tool is denied before execution.
    normalize = None

    def validate_adapter(self, spec, context):
        if spec['permission'] == 'workspace-write':
            # Keep the historical refusal order: workspace-write is rejected as
            # "needs a workspace adapter" before this adapter's own message.
            super().validate_adapter(spec, context)
        if spec['permission'] != 'read-only' or spec.get('external_tools'):
            raise ValueError('dsh-text accepts read-only with no external tools only')
        super().validate_adapter(spec, context)

    def probe(self, spec):
        restricted_dsh_text_request(spec)
        return {'adapter': 'dsh-text', 'fixed_asar_entry_verified': True,
                'scope': 'Electron filesystem stat only; no model inference'}

    def build_command(self, spec):
        request = restricted_dsh_text_request(spec)
        spec['_native_env'] = request['env_delta']
        spec['_preflight'] = {'fixed_asar_entry_verified': True,
                              'scope': 'Electron filesystem stat only; no model inference'}
        return request['argv'], request['stdin']

    def parse_result(self, lines, spec, result, cancelled):
        return parse_dsh_text_log(lines)
