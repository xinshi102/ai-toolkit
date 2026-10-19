"""Reusable DSH file-operation adapter (standard library only).

``request(spec)`` builds a fixed-argv, shell-free launch request for a real DSH
headless run against one absolute working directory.  ``parse_log(lines,
permission)`` verifies the transport and permission evidence in the merged
stdout/stderr stream.  It deliberately does not accept a model answer as
completed work:

* the caller must launch with ``cwd=spec["cwd"]``, the returned ``argv``, the
  returned ``stdin`` encoded as UTF-8, and ``env=os.environ | env_delta``;
* the caller must keep the process exit code and require both exit code 0 and
  ``transport_policy_passed`` before treating the run as transported;
* semantic acceptance of the final answer and any written artifacts remains a
  controller decision (``semantic_acceptance == "controller-required"``).

The adapter reuses this machine's installed DSH and native login.  It never
reads or writes the global credential/configuration files and does not create
an account.  The fixed one-shot patch layers restrict the effective sandbox and
approval policy, and the required-injection audit plugin fails startup if it is
missing.  The sandbox is DSH's application-level file boundary: model tool
dispatch is confined, but this is not a hard OS-wide isolation claim for the
whole Electron process, its startup work, or the host.

Guard audit records are written to stderr as ``DSH_WORKSPACE_AUDIT <json>``.
The caller therefore has to capture stderr together with stdout; the project
runner already redirects both to one log.  Records contain only session IDs,
tool names/call IDs and policy/error booleans, never prompts, tool arguments,
tool output, configuration dumps, credentials, or secret values.
"""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import subprocess
from patch_config import render_patch

# Runtime package location; installation roots are user configuration.
BASE = Path(os.path.abspath(__file__)).parent
_program_path = os.environ.get("XINSHI_DSH_PROGRAM", "").strip()
PROGRAM = Path(_program_path) if _program_path else None
BINARY = PROGRAM / "DeepSeek Harness.exe" if PROGRAM is not None else None
ARCHIVE = PROGRAM / "resources/app.asar" if PROGRAM is not None else None
ENTRY = ARCHIVE / "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" if PROGRAM is not None else None

AUDIT = BASE / "dsh-workspace-audit.mjs"
PATCH = {
    "workspace-write": BASE / "dsh-workspace.patch.yml",
    "read-only": BASE / "dsh-workspace-readonly.patch.yml",
}
PERMISSIONS = ("read-only", "workspace-write")
APPROVAL = "never"
AUDIT_PREFIX = "DSH_WORKSPACE_AUDIT "
MAX_PROMPT_BYTES = 64 * 1024
ASAR_PROBE_TIMEOUT = 20


def _no_window():
    """Keep the fixed probe hidden on Windows; no effect elsewhere."""
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _electron_asar_probe(cwd):
    """Return the fixed Electron filesystem probe result, without trusting it blindly.

    Electron's fs presents ``app.asar`` as a virtual directory, so
    ``fs.statSync(archive).isFile()`` is expected to be false even when the
    archive is a real OS file (observed on this machine: ``{"archive":false,
    "entry":true}``).  The container check therefore belongs to Python; this
    probe is only authoritative for the path *inside* the archive.  The raw
    shape is validated strictly; native diagnostics are withheld because they
    may contain installation details.
    """
    probe = (
        "const fs=require('node:fs');"
        "let a=false,e=false;"
        "try{a=fs.statSync(" + json.dumps(str(ARCHIVE)) + ").isFile()}catch{}"
        "try{e=fs.statSync(" + json.dumps(str(ENTRY)) + ").isFile()}catch{}"
        "process.stdout.write(JSON.stringify({archive:a,entry:e}));"
    )
    try:
        completed = subprocess.run(
            [str(BINARY), "-e", probe],
            cwd=str(cwd),
            env=dict(os.environ, ELECTRON_RUN_AS_NODE="1"),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=ASAR_PROBE_TIMEOUT,
            shell=False,
            **_no_window(),
        )
        if completed.returncode != 0:
            return None
        value = json.loads(completed.stdout)
        if not isinstance(value, dict) or set(value) != {"archive", "entry"}:
            return None
        if type(value["archive"]) is not bool or type(value["entry"]) is not bool:
            return None
        return value
    except (OSError, subprocess.SubprocessError, ValueError, RecursionError):
        return None


def _probe_asar_entry(cwd):
    """Verify the real archive container in Python and the internal entry in Electron.

    The archive must be a real OS file (Python ``is_file``), not whatever
    Electron's virtual asar filesystem reports.  The internal entry is still
    required to be exactly true from Electron, so a missing/unknown entry cannot
    pass as a weaker match.
    """
    if not ARCHIVE.is_file():
        return False
    value = _electron_asar_probe(cwd)
    if not isinstance(value, dict) or set(value) != {"archive", "entry"}:
        return False
    if type(value["archive"]) is not bool or type(value["entry"]) is not bool:
        return False
    return value["entry"] is True


def _absolute_directory(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("cwd must be a nonblank absolute path")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError("cwd must be an absolute path")
    try:
        path = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ValueError("cwd must exist") from error
    if not path.is_dir():
        raise ValueError("cwd must be a directory")
    return path


def request(spec):
    """Build the fixed DSH headless launch request for ``spec``.

    Required manifest fields: ``cwd`` (absolute existing directory), ``prompt``
    (UTF-8 string up to 64 KiB) and ``permission`` (``workspace-write`` or
    ``read-only``).  The returned mapping has exactly ``argv``, ``stdin`` and
    ``env_delta``.  No caller-supplied executable, extra argument, patch path,
    environment override or shell command is accepted.
    """
    if not isinstance(spec, dict):
        raise ValueError("spec must be an object")
    if PROGRAM is None or not PROGRAM.is_absolute() or not PROGRAM.is_dir():
        raise ValueError("set XINSHI_DSH_PROGRAM to the existing absolute DeepSeek Harness installation directory")
    try:
        cwd_raw = spec["cwd"]
        prompt = spec["prompt"]
        permission = spec["permission"]
    except KeyError as error:
        raise ValueError(f"missing spec field: {error.args[0]}") from error

    if permission not in PERMISSIONS:
        raise ValueError("permission must be read-only or workspace-write")
    cwd = _absolute_directory(cwd_raw)
    if not isinstance(prompt, str):
        raise ValueError("prompt must be a string")
    try:
        prompt_size = len(prompt.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise ValueError("prompt must be valid UTF-8") from error
    if prompt_size > MAX_PROMPT_BYTES:
        raise ValueError("prompt exceeds 64 KiB input bound")

    patch = PATCH[permission]
    required = (BINARY, ARCHIVE, AUDIT, patch)
    if not all(path.is_file() for path in required):
        raise ValueError("DSH executable, ASAR archive, or fixed protection files are missing")
    if not _probe_asar_entry(cwd):
        raise ValueError("fixed ASAR entry preflight failed; native diagnostics withheld")
    patch = render_patch(patch)

    # One fixed command line.  The workspace root is the caller-provided cwd;
    # DSH resolves it from the Popen working directory, so this adapter adds no
    # guessed --cwd flag.  The prompt travels separately on stdin.
    argv = [
        str(BINARY),
        str(ENTRY),
        "--profile", "headless",
        "--patch", str(patch),
        "--json", "-",
    ]
    return {
        "argv": argv,
        "stdin": prompt,
        "env_delta": {
            "ELECTRON_RUN_AS_NODE": "1",
            "DSH_PERMISSION_MODE": permission,
            "DSH_WORKSPACE_EXPECTED_PERMISSION": permission,
            "XINSHI_RUNTIME_DIR": str(BASE),
        },
    }


def _strict_json(text):
    """Parse the whole final text, rejecting non-finite/non-standard JSON."""
    def reject_constant(value):
        raise ValueError(f"non-finite JSON constant: {value}")

    def parse_float(value):
        parsed = float(value)
        if not math.isfinite(parsed):
            raise ValueError("non-finite JSON number")
        return parsed

    return json.loads(text, parse_constant=reject_constant, parse_float=parse_float)


def _record(value):
    return value if isinstance(value, str) and value else None


def parse_log(lines, permission):
    """Verify transport and permission evidence; never accept answer semantics.

    ``lines`` is the merged stdout/stderr log.  A pass requires exit-independent
    evidence only; the caller must still require process exit code 0 and review
    the final answer/artifacts.  Tool calls and native subagents are allowed,
    but every participating session must have a valid audited policy and every
    audited tool call must come from such a session.  Tool errors are retained;
    an error counts as recovered only when the same session and tool later
    reports a successful result during the same turn.  Unresolved errors make
    transport fail.
    """
    if permission not in PERMISSIONS:
        raise ValueError("permission must be read-only or workspace-write")
    if not isinstance(lines, list) or any(not isinstance(line, str) for line in lines):
        raise ValueError("lines must be a list of strings")

    audits, events, protocol_errors = [], [], []

    def fail(reason):
        if reason not in protocol_errors:
            protocol_errors.append(reason)

    for line in lines:
        if line.startswith(AUDIT_PREFIX):
            try:
                record = json.loads(line[len(AUDIT_PREFIX):])
            except (ValueError, RecursionError):
                fail("malformed guard audit")
                continue
            if not isinstance(record, dict):
                fail("malformed guard audit")
            else:
                audits.append(record)
            continue
        try:
            event = json.loads(line)
        except (ValueError, RecursionError):
            continue  # Native startup diagnostics and reasoning are not NDJSON.
        if isinstance(event, dict):
            events.append(event)

    ready = [item for item in audits if item.get("type") == "guard_ready"]
    guard_ready = (
        len(ready) == 1
        and ready[0].get("expected") == permission
        and ready[0].get("approval") == APPROVAL
    )
    if not guard_ready:
        fail("guard readiness is missing or does not match the requested permission")

    policies = []
    policy_verified = True
    for item in audits:
        if item.get("type") != "effective_policy":
            continue
        session = _record(item.get("sessionId"))
        sandbox = item.get("sandbox")
        approval = item.get("approval")
        valid = (
            session is not None
            and sandbox == permission
            and approval == APPROVAL
            and item.get("expected") == permission
            and item.get("valid") is True
        )
        if not valid:
            policy_verified = False
        policies.append({
            "session_id": session,
            "sandbox": sandbox if isinstance(sandbox, str) else None,
            "approval": approval if isinstance(approval, str) else None,
            "expected": item.get("expected") if isinstance(item.get("expected"), str) else None,
            "valid": item.get("valid") is True,
        })
    if not policies:
        policy_verified = False
    if not policy_verified:
        fail("effective policy is missing or not exactly the requested permission")

    sessions = [item for item in events if item.get("type") == "session"]
    session_id = None
    if len(sessions) == 1:
        session_id = _record(sessions[0].get("sessionId"))
    if session_id is None:
        fail("root session identity is missing or ambiguous")

    calls, results = [], []
    audited_calls = set()
    for order, item in enumerate(audits):
        if item.get("type") == "tool_call":
            session = _record(item.get("sessionId"))
            call_id = _record(item.get("callId"))
            name = _record(item.get("name"))
            if session is None or call_id is None or name is None:
                fail("malformed tool_call audit")
                continue
            if (session, call_id) in audited_calls:
                continue
            audited_calls.add((session, call_id))
            calls.append({"session_id": session, "call_id": call_id, "name": name})
        elif item.get("type") == "tool_result":
            session = _record(item.get("sessionId"))
            call_id = _record(item.get("callId"))
            name = _record(item.get("name"))
            error = item.get("error")
            if session is None or call_id is None or not isinstance(error, bool):
                fail("malformed tool_result audit")
                continue
            results.append({
                "order": order, "session_id": session, "call_id": call_id,
                "name": name, "error": error,
            })

    call_keys = {(call["session_id"], call["call_id"]) for call in calls}
    result_keys = {(result["session_id"], result["call_id"]) for result in results}
    if call_keys - result_keys:
        fail("a tool call has no result audit")
    if result_keys - call_keys:
        fail("a tool result has no call audit")

    tool_errors = []
    for index, item in enumerate(results):
        if not item["error"]:
            continue
        resolved = bool(item["name"]) and any(
            later["error"] is False
            and later["session_id"] == item["session_id"]
            and later["name"] == item["name"]
            for later in results[index + 1:]
        )
        tool_errors.append({
            "session_id": item["session_id"],
            "call_id": item["call_id"],
            "tool": item["name"],
            "recovered_by_later_success": resolved,
        })
    unresolved_errors = sum(not item["recovered_by_later_success"] for item in tool_errors)
    if unresolved_errors:
        fail("a tool error was not followed by a successful retry of the same tool")

    # Cross-check the root native projection against the guard's all-session
    # audit.  This detects dropped/missing guard records instead of trusting
    # whichever view is convenient.
    native_calls = 0
    for item in events:
        if item.get("type") == "tool_call":
            native_calls += 1
            call_id = _record(item.get("callId"))
            if call_id is None or (session_id, call_id) not in audited_calls:
                fail("native tool call is missing from the guard audit")
        elif item.get("type") == "tool_result" and item.get("status") == "error":
            call_id = _record(item.get("callId"))
            audited_error = any(
                result["session_id"] == session_id
                and result["call_id"] == call_id
                and result["error"]
                for result in results
            )
            if call_id is None or not audited_error:
                fail("native tool error is missing from the guard audit")

    participants = {call["session_id"] for call in calls}
    participants |= {result["session_id"] for result in results}
    if session_id is not None:
        participants.add(session_id)
    policy_sessions = {item["session_id"] for item in policies if item["session_id"]}
    if participants - policy_sessions:
        policy_verified = False
        fail("a participating session has no effective-policy audit")

    native_errors = [item for item in events if item.get("type") == "error"]
    if native_errors:
        fail("native error event")

    ends = [
        item for item in events
        if item.get("type") == "status" and item.get("phase") == "turn_end"
    ]
    completed = (
        len(ends) == 1
        and isinstance(ends[0].get("reason"), dict)
        and ends[0]["reason"].get("kind") == "completed"
    )
    if not completed:
        fail("the run did not report exactly one completed turn")

    finals = [item for item in events if item.get("type") == "final"]
    final_text = None
    if len(finals) == 1 and isinstance(finals[0].get("text"), str):
        final_text = finals[0]["text"]
    if final_text is None or not final_text.strip():
        fail("the final answer is missing, empty, or ambiguous")

    if native_errors:
        terminal_event = "turn.failed"
    elif len(ends) == 1:
        reason = ends[0].get("reason")
        kind = reason.get("kind") if isinstance(reason, dict) else None
        terminal_event = "turn.completed" if kind == "completed" else (
            f"turn.{kind}" if isinstance(kind, str) and kind else "turn.unknown"
        )
    elif len(ends) > 1:
        terminal_event = "turn.ambiguous"
    else:
        terminal_event = "turn.missing"

    passed = (
        guard_ready
        and policy_verified
        and session_id is not None
        and completed
        and final_text is not None
        and bool(final_text.strip())
        and not native_errors
        and unresolved_errors == 0
        and not protocol_errors
    )
    result = {
        "transport_policy_passed": passed,
        "final_text": final_text,
        "session_id": session_id,
        "tool_call_count": len(calls),
        "effective_policies": policies,
        "semantic_acceptance": "controller-required",
        "terminal_event": terminal_event,
        "guard_ready": guard_ready,
        "policy_verified": policy_verified,
        "tool_errors": tool_errors,
        "unresolved_tool_errors": unresolved_errors,
        "recovered_tool_errors": len(tool_errors) - unresolved_errors,
        "protocol_errors": protocol_errors,
        "native_tool_call_count": native_calls,
    }
    if isinstance(final_text, str):
        try:
            result["final_json"] = _strict_json(final_text)
        except (ValueError, TypeError, RecursionError):
            pass
    return result
