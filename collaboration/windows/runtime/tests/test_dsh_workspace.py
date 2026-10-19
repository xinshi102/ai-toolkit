"""Focused tests for the reusable DSH workspace adapter.

Run from the project root:
    python -B -W error::ResourceWarning -m unittest -v runtime.tests.test_dsh_workspace

The request tests use temporary fake installation files and a mocked Electron
ASAR probe, so no model call, real installation or external process is needed.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

RUNTIME = Path(__file__).resolve().parents[1]
if str(RUNTIME) not in sys.path:
    sys.path.insert(0, str(RUNTIME))

import dsh_workspace  # noqa: E402


def audit(**fields):
    return "DSH_WORKSPACE_AUDIT " + json.dumps(fields, ensure_ascii=False)


def event(**fields):
    return json.dumps(fields, ensure_ascii=False)


def base_log(permission="workspace-write", final='{"ok": true}', tool=True):
    lines = [
        audit(type="guard_ready", expected=permission, approval="never"),
        event(type="session", sessionId="session-root", cwd="E:/project"),
        audit(type="effective_policy", sessionId="session-root", sandbox=permission,
              approval="never", expected=permission, valid=True),
    ]
    if tool:
        lines += [
            event(type="tool_call", callId="call-1", tool="read", input={"path": "a.txt"}),
            audit(type="tool_call", sessionId="session-root", callId="call-1", name="read"),
            event(type="tool_result", callId="call-1", status="completed", result="a"),
            audit(type="tool_result", sessionId="session-root", callId="call-1",
                  name="read", error=False),
        ]
    lines += [
        event(type="status", phase="turn_end", reason={"kind": "completed"}),
        event(type="final", text=final),
    ]
    return lines


class RequestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = Path(self.tmp.name)
        program = self.cwd / 'fake-dsh'
        program.mkdir()
        archive = program / 'app.asar'
        binary = program / 'DeepSeek Harness.exe'
        archive.touch()
        binary.touch()
        for key, value in {'PROGRAM': program, 'BINARY': binary, 'ARCHIVE': archive,
                           'ENTRY': archive / 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'}.items():
            installed = mock.patch.object(dsh_workspace, key, value)
            installed.start()
            self.addCleanup(installed.stop)
        patcher = mock.patch.object(
            dsh_workspace, "_electron_asar_probe",
            return_value={"archive": False, "entry": True},
        )
        self.electron_probe = patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.tmp.cleanup()

    def test_workspace_request_is_fixed_and_permission_matched(self):
        request = dsh_workspace.request({
            "cwd": str(self.cwd), "prompt": "write a file",
            "permission": "workspace-write",
        })
        self.assertEqual(set(request), {"argv", "stdin", "env_delta"})
        self.assertEqual(request["argv"], [
            str(dsh_workspace.BINARY), str(dsh_workspace.ENTRY),
            "--profile", "headless", "--patch",
            str(dsh_workspace.render_patch(dsh_workspace.PATCH["workspace-write"])), "--json", "-",
        ])
        self.assertEqual(request["stdin"], "write a file")
        self.assertEqual(request["env_delta"], {
            "ELECTRON_RUN_AS_NODE": "1",
            "DSH_PERMISSION_MODE": "workspace-write",
            "DSH_WORKSPACE_EXPECTED_PERMISSION": "workspace-write",
            "XINSHI_RUNTIME_DIR": str(dsh_workspace.BASE),
        })
        self.electron_probe.assert_called_once()

    def test_read_only_request_uses_the_read_only_patch(self):
        request = dsh_workspace.request({
            "cwd": str(self.cwd), "prompt": "inspect", "permission": "read-only",
        })
        self.assertIn(str(dsh_workspace.render_patch(dsh_workspace.PATCH["read-only"])), request["argv"])
        self.assertNotIn(str(dsh_workspace.PATCH["workspace-write"]), request["argv"])
        self.assertEqual(request["env_delta"]["DSH_PERMISSION_MODE"], "read-only")
        self.assertEqual(request["env_delta"]["DSH_WORKSPACE_EXPECTED_PERMISSION"], "read-only")

    def test_preflight_failure_is_closed_and_hides_native_output(self):
        self.electron_probe.return_value = {"archive": False, "entry": False}
        with self.assertRaises(ValueError) as caught:
            dsh_workspace.request({
                "cwd": str(self.cwd), "prompt": "inspect", "permission": "read-only",
            })
        self.assertIn("withheld", str(caught.exception))

    def test_real_electron_virtual_asar_container_result_is_accepted(self):
        # Exact observed result on this machine: Electron fs presents app.asar
        # as a virtual directory, so archive=false is expected.  Python already
        # verified the archive is a real OS file; only the internal entry is
        # authoritative in the Electron probe.
        self.assertEqual(
            self.electron_probe.return_value,
            {"archive": False, "entry": True},
        )
        request = dsh_workspace.request({
            "cwd": str(self.cwd), "prompt": "inspect", "permission": "read-only",
        })
        self.assertEqual(request["argv"][-2:], ["--json", "-"])

    def test_container_check_is_python_not_electron_virtual_fs(self):
        with mock.patch.object(
            dsh_workspace, "_electron_asar_probe",
            return_value={"archive": False, "entry": True},
        ):
            self.assertTrue(dsh_workspace._probe_asar_entry(self.cwd))
        with mock.patch.object(dsh_workspace, "ARCHIVE",
                               self.cwd / "missing-app.asar"):
            self.assertFalse(dsh_workspace._probe_asar_entry(self.cwd))

    def test_internal_entry_preflight_rejects_unknown_or_weakened_results(self):
        for raw in (
            None,
            {"archive": False, "entry": False},
            {"archive": True, "entry": "true"},
            {"entry": True},
            {"archive": False, "entry": True, "extra": 1},
        ):
            with self.subTest(raw=raw):
                self.electron_probe.return_value = raw
                self.assertFalse(dsh_workspace._probe_asar_entry(self.cwd))

    def test_rejects_unknown_permission_instead_of_mislabelling(self):
        for permission in ("danger-full-access", "shell-read-only", "", None, 1):
            with self.subTest(permission=permission):
                with self.assertRaises(ValueError):
                    dsh_workspace.request({
                        "cwd": str(self.cwd), "prompt": "x", "permission": permission,
                    })

    def test_cwd_must_be_absolute_existing_directory(self):
        file_path = self.cwd / "file.txt"
        file_path.write_text("x", encoding="utf-8")
        for cwd in ("relative/dir", str(self.cwd / "missing"), str(file_path), "", None):
            with self.subTest(cwd=cwd):
                with self.assertRaises(ValueError):
                    dsh_workspace.request({
                        "cwd": cwd, "prompt": "x", "permission": "read-only",
                    })

    def test_prompt_is_a_bounded_string(self):
        for prompt in (None, 1, b"bytes", "x" * (dsh_workspace.MAX_PROMPT_BYTES + 1)):
            with self.subTest(prompt=type(prompt).__name__):
                with self.assertRaises(ValueError):
                    dsh_workspace.request({
                        "cwd": str(self.cwd), "prompt": prompt, "permission": "read-only",
                    })

    def test_spec_must_be_object_with_required_fields(self):
        with self.assertRaises(ValueError):
            dsh_workspace.request([])
        with self.assertRaises(ValueError):
            dsh_workspace.request({"cwd": str(self.cwd), "permission": "read-only"})

    def test_patch_files_are_adjacent_pinned_and_require_the_audit_plugin(self):
        for permission, patch in dsh_workspace.PATCH.items():
            with self.subTest(permission=permission):
                text = patch.read_text(encoding="utf-8")
                self.assertIn("__XINSHI_PLUGIN_PATH__", text)
                self.assertIn("headless-runner", text)
                self.assertIn("runtimeDshWorkspaceAudit", text)
                self.assertIn(f"defaultPreset: {permission}", text)
                self.assertNotIn("sandbox: danger-full-access", text)
        self.assertTrue(dsh_workspace.AUDIT.is_file())


class ParseTests(unittest.TestCase):
    def parse(self, lines, permission="workspace-write"):
        return dsh_workspace.parse_log(lines, permission)

    def test_valid_run_passes_with_tools_and_strict_json(self):
        result = self.parse(base_log())
        self.assertTrue(result["transport_policy_passed"])
        self.assertEqual(result["session_id"], "session-root")
        self.assertEqual(result["final_text"], '{"ok": true}')
        self.assertEqual(result["final_json"], {"ok": True})
        self.assertEqual(result["tool_call_count"], 1)
        self.assertEqual(result["native_tool_call_count"], 1)
        self.assertEqual(result["semantic_acceptance"], "controller-required")
        self.assertEqual(result["terminal_event"], "turn.completed")
        self.assertEqual(result["protocol_errors"], [])
        self.assertEqual(result["effective_policies"], [{
            "session_id": "session-root", "sandbox": "workspace-write",
            "approval": "never", "expected": "workspace-write", "valid": True,
        }])

    def test_read_only_run_passes_only_with_read_only_policy(self):
        self.assertTrue(self.parse(base_log("read-only"), "read-only")["transport_policy_passed"])
        mismatched = self.parse(base_log("workspace-write"), "read-only")
        self.assertFalse(mismatched["transport_policy_passed"])
        self.assertFalse(mismatched["policy_verified"])

    def test_read_only_label_cannot_hide_workspace_policy(self):
        lines = base_log("workspace-write")
        lines[2] = audit(type="effective_policy", sessionId="session-root",
                         sandbox="workspace-write", approval="never",
                         expected="workspace-write", valid=True)
        result = self.parse(lines, "read-only")
        self.assertFalse(result["transport_policy_passed"])

    def test_guard_readiness_is_required_and_unique(self):
        self.assertFalse(self.parse(base_log()[1:])["transport_policy_passed"])
        lines = base_log()
        lines.insert(0, audit(type="guard_ready", expected="workspace-write", approval="never"))
        self.assertFalse(self.parse(lines)["transport_policy_passed"])
        wrong = base_log()
        wrong[0] = audit(type="guard_ready", expected="read-only", approval="never")
        self.assertFalse(self.parse(wrong)["transport_policy_passed"])

    def test_missing_or_invalid_policy_fails(self):
        missing = base_log()
        missing.pop(2)
        result = self.parse(missing)
        self.assertFalse(result["transport_policy_passed"])
        self.assertFalse(result["policy_verified"])

        invalid = base_log()
        invalid[2] = audit(type="effective_policy", sessionId="session-root",
                           sandbox="workspace-write", approval="never",
                           expected="workspace-write", valid=False)
        self.assertFalse(self.parse(invalid)["transport_policy_passed"])

        asking = base_log()
        asking[2] = audit(type="effective_policy", sessionId="session-root",
                          sandbox="workspace-write", approval="ask",
                          expected="workspace-write", valid=True)
        self.assertFalse(self.parse(asking)["transport_policy_passed"])

    def test_subagent_is_allowed_but_its_policy_must_be_audited(self):
        # A native child's tool events are not projected onto the CLI's root
        # NDJSON, so only the guard's all-session audit proves them.
        child = [
            audit(type="effective_policy", sessionId="session-child",
                  sandbox="workspace-write", approval="never",
                  expected="workspace-write", valid=True),
            audit(type="tool_call", sessionId="session-child", callId="call-child", name="grep"),
            audit(type="tool_result", sessionId="session-child", callId="call-child",
                  name="grep", error=False),
        ]
        lines = base_log()
        lines[2:2] = child
        result = self.parse(lines)
        self.assertTrue(result["transport_policy_passed"])
        self.assertEqual(result["tool_call_count"], 2)
        self.assertEqual(result["native_tool_call_count"], 1)
        self.assertEqual(len(result["effective_policies"]), 2)

        unverified = base_log()
        unverified[2:2] = child[1:]
        result = self.parse(unverified)
        self.assertFalse(result["transport_policy_passed"])
        self.assertIn("a participating session has no effective-policy audit",
                      result["protocol_errors"])

    def test_malformed_guard_audit_fails_closed(self):
        lines = base_log()
        lines.append("DSH_WORKSPACE_AUDIT {not json")
        result = self.parse(lines)
        self.assertFalse(result["transport_policy_passed"])
        self.assertIn("malformed guard audit", result["protocol_errors"])

    def test_native_error_and_failed_turn_are_not_success(self):
        lines = base_log()
        lines.insert(-2, event(type="error", message="native failure"))
        result = self.parse(lines)
        self.assertFalse(result["transport_policy_passed"])
        self.assertEqual(result["terminal_event"], "turn.failed")

        failed = base_log(final="")
        failed[-2] = event(type="status", phase="turn_end", reason={"kind": "error"})
        result = self.parse(failed)
        self.assertFalse(result["transport_policy_passed"])
        self.assertEqual(result["terminal_event"], "turn.error")

    def test_exit_zero_is_not_represented_as_completion(self):
        # parse_log has no exit-code input; a completed turn with a final is
        # still only transport evidence and semantics stay controller-required.
        result = self.parse(base_log(final="I did it"))
        self.assertTrue(result["transport_policy_passed"])
        self.assertEqual(result["semantic_acceptance"], "controller-required")

    def test_requires_exactly_one_session_and_one_final(self):
        two_sessions = base_log()
        two_sessions.insert(2, event(type="session", sessionId="session-root"))
        self.assertFalse(self.parse(two_sessions)["transport_policy_passed"])

        two_finals = base_log()
        two_finals.append(event(type="final", text="duplicate"))
        result = self.parse(two_finals)
        self.assertFalse(result["transport_policy_passed"])
        self.assertIsNone(result["final_text"])

        empty_final = base_log(final="   ")
        self.assertFalse(self.parse(empty_final)["transport_policy_passed"])

    def test_requires_exactly_one_completed_turn(self):
        no_end = [line for line in base_log()
                  if not (line.startswith("{") and json.loads(line).get("phase") == "turn_end")]
        result = self.parse(no_end)
        self.assertFalse(result["transport_policy_passed"])
        self.assertEqual(result["terminal_event"], "turn.missing")

        two_ends = base_log()
        two_ends.insert(-1, event(type="status", phase="turn_end",
                                  reason={"kind": "completed"}))
        result = self.parse(two_ends)
        self.assertFalse(result["transport_policy_passed"])
        self.assertEqual(result["terminal_event"], "turn.ambiguous")

    def test_tool_error_followed_by_same_tool_success_is_reported_as_recovered(self):
        lines = base_log()
        lines[3] = event(type="tool_call", callId="call-1", tool="read", input={})
        lines[4] = audit(type="tool_call", sessionId="session-root", callId="call-1", name="read")
        lines[5] = event(type="tool_result", callId="call-1", status="error", result="denied")
        lines[6] = audit(type="tool_result", sessionId="session-root", callId="call-1",
                         name="read", error=True)
        lines[7:7] = [
            event(type="tool_call", callId="call-2", tool="read", input={}),
            audit(type="tool_call", sessionId="session-root", callId="call-2", name="read"),
            event(type="tool_result", callId="call-2", status="completed", result="ok"),
            audit(type="tool_result", sessionId="session-root", callId="call-2",
                  name="read", error=False),
        ]
        result = self.parse(lines)
        self.assertTrue(result["transport_policy_passed"])
        self.assertEqual(result["recovered_tool_errors"], 1)
        self.assertEqual(result["unresolved_tool_errors"], 0)
        self.assertTrue(result["tool_errors"][0]["recovered_by_later_success"])

    def test_final_tool_error_is_not_ignored(self):
        lines = base_log()
        lines[5] = event(type="tool_result", callId="call-1", status="error", result="denied")
        lines[6] = audit(type="tool_result", sessionId="session-root", callId="call-1",
                         name="read", error=True)
        result = self.parse(lines)
        self.assertFalse(result["transport_policy_passed"])
        self.assertEqual(result["unresolved_tool_errors"], 1)
        self.assertIn("a tool error was not followed by a successful retry of the same tool",
                      result["protocol_errors"])

    def test_every_audited_call_and_result_must_pair(self):
        no_result = base_log()
        no_result.pop(6)  # guard tool_result audit
        result = self.parse(no_result)
        self.assertFalse(result["transport_policy_passed"])
        self.assertIn("a tool call has no result audit", result["protocol_errors"])

        no_call = base_log()
        no_call.pop(4)  # guard tool_call audit
        result = self.parse(no_call)
        self.assertFalse(result["transport_policy_passed"])
        self.assertIn("a tool result has no call audit", result["protocol_errors"])

    def test_native_tool_events_must_be_present_in_the_guard_audit(self):
        missing_call = base_log()
        missing_call[3] = event(type="tool_call", callId="native-only", tool="read", input={})
        result = self.parse(missing_call)
        self.assertFalse(result["transport_policy_passed"])
        self.assertIn("native tool call is missing from the guard audit",
                      result["protocol_errors"])

        missing_error = base_log()
        missing_error[5] = event(type="tool_result", callId="call-1",
                                 status="error", result="denied")
        result = self.parse(missing_error)
        self.assertFalse(result["transport_policy_passed"])
        self.assertIn("native tool error is missing from the guard audit",
                      result["protocol_errors"])

    def test_final_json_is_only_present_when_strictly_parseable(self):
        result = self.parse(base_log(final='{"n": NaN}'))
        self.assertNotIn("final_json", result)
        result = self.parse(base_log(final='{"n": 1e400}'))
        self.assertNotIn("final_json", result)
        result = self.parse(base_log(final="not json"))
        self.assertNotIn("final_json", result)
        result = self.parse(base_log(final='["ok", 1]'))
        self.assertEqual(result["final_json"], ["ok", 1])

    def test_input_shape_and_permission_are_validated(self):
        with self.assertRaises(ValueError):
            dsh_workspace.parse_log(["x"], "danger-full-access")
        with self.assertRaises(ValueError):
            dsh_workspace.parse_log("not a list", "read-only")
        with self.assertRaises(ValueError):
            dsh_workspace.parse_log([1, 2], "read-only")

    def test_native_startup_noise_is_ignored_but_protocol_errors_are_not(self):
        lines = ["dsh: reasoning: thinking", "not json"] + base_log()
        self.assertTrue(self.parse(lines)["transport_policy_passed"])


if __name__ == "__main__":
    unittest.main()
