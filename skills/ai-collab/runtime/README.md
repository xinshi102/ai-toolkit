# xinshi local collaboration runtime



The agent in the main chat chooses and maintains the collaboration; users give goals in ordinary language. The runtime now has a project-scoped workflow layer over the existing durable queue. It supports actual Codex and DeepSeek file work, automatic predecessor-result/file binding, explicit acceptance checks, partial invalidation on revision, and resumable progress. Keep ordinary one-agent/native-subagent work on the native path when that is sufficient.

## Workflow entry (2026-10-19)

Use `workflow.py --project-root ABSOLUTE_CANONICAL_PROJECT --state PROJECT_INTERNAL_STATE init graph.json`, then `run --max-concurrency 2`. The main agent generates the graph and checks; the user does not maintain it. `status`, `revise change.json` with `expected_revision`, and `cancel NODE_ID` use the same state. Full schema and examples: [WORKFLOWS.md](WORKFLOWS.md).


State is bound to one project root and cannot be silently reopened under a different parent project. The coordinator reserves overlapping write paths, including directory/descendant overlap, within its shared workflow. This is cooperation scheduling, not global OS file exclusion against other applications. Use one authoritative state for work sharing these resources.

Windows workspace workers launch suspended, join a dedicated kill-on-close Job, then resume. On cancellation, timeout, exceptions, or normal completion, their owned descendants are stopped and verified before resources are released. Unconfirmed cleanup remains `unknown` with reservations retained. Only processes created by this runtime are targeted. This lifecycle control does not provide a universal filesystem sandbox or prove survival of closing the desktop app.

The current machine's DSH native file tools have been used for implementation. Some native DSH workspace-shell commands returned `0xC0000142`; the controller can assign the file work to DeepSeek and run required tests through a working Codex/main-controller environment. Check current capabilities before choosing roles. Actual-model demonstrations are under `outputs/2026-10-19-agent-flow/`.

## Underlying queue

Python 3.12 standard library; no service registration or package installation. Entry: `runtime/task_runner.py`. SQLite stores task manifests, durable state, cancellation flags, resource ownership, and audit events. One OS file lock allows one worker per state directory; each executor has its own OS lock. The scheduler starts independent executors concurrently, with `--max-concurrency 2` by default (range 1..16). Dependency checks and resource reservations are transactional; resource conflicts block only affected tasks. Already-running orphan executors count toward the concurrency bound.

## CLI

All examples run from PowerShell. `$runner` and `$state` below are task-specific variables, not changes to client configuration.

```powershell
python -B $runner --state $state status
python -B $runner --state $state events
python -B $runner --state $state run --idle-timeout 3 --max-concurrency 2
python -B $runner --state $state launch --idle-timeout 3 --max-concurrency 2
python -B $runner --state $state cancel TASK_ID
python -B $runner --state $state recover
python -B $runner --state $state recover --retry
python -B $runner --state $state resolve-unknown TASK_ID --confirm-no-process-running
python -B $runner --state $state shutdown
```

`enqueue` prints a task ID; `status` and `events` print JSON. Expected CLI validation/lock failures exit 2 with JSON error on stderr. Task failures are durable task results; a worker that successfully drains ready tasks can exit 0 even if some tasks failed. Inspect status for task outcome.

`launch` starts one detached hidden worker on Windows (new session on POSIX), prints its PID and exits. This proves process creation, not readiness; inspect status/events. A second worker cannot acquire the same state directory's lock. `shutdown` gracefully stops a worker after its current task; `cancel` separately requests termination of a running task. Idle workers automatically exit within the configured timeout (0..3600 seconds). No scheduled task, auto-restart, port, or resident daemon is installed. A completed launcher/worker is not killed or managed by a later unrelated chat.

## Manifest and permissions

```json
{
  "adapter": "codex",
  "permission": "read-only",
  "prompt": "Inspect README.md and report findings. Do not change files.",
  "depends_on": [],
  "resources": ["project-review"],
  "artifacts": []
}
```

`cwd` and `permission` are mandatory. `read-only` Codex execution requires the verified single-invocation profile described below: native shell read-only sandbox plus disabled known external tool surfaces. Preflight failure prevents execution. It does not claim an OS hard sandbox for every conceivable capability or automatically grant external-operation authority. The controlling agent still judges the task and loaded capabilities against existing user authorization.

The explicit weaker label `shell-read-only` is also accepted only with `external_tools: existing-user-authorization`; it grants no new external-operation authority. In this version it still uses the same restrictive Codex preflight, rather than re-enabling external tools. No dangerous external operation is automatically authorized by enqueueing.


Paths are physically resolved for safety checks, then persisted under the selected stable canonical project entry. Existing junction targets such as the old Desktop path are not persisted as task bindings. This separates the canonical path from the present physical target; it does not itself migrate any files.

Dependencies must already exist at enqueue time, so ordinary manifest creation cannot introduce dependency cycles. Only succeeded prerequisites release dependents. Failed/cancelled/blocked prerequisites propagate a terminal `blocked` state and `dependency_blocked` audit event to descendants; they do not wait forever in queued. Interrupted/unknown dependencies wait for an explicit recovery decision. After correcting failed work, enqueue new dependent work rather than silently resetting a terminal blocked task. Independent tasks still progress. Resource names represent shared logical resources; they are transactionally exclusive within one queue/state directory, not global machine locks. Use one state directory for tasks sharing resources. Multiple different state directories do not share resource ownership.

## Adapters

`native_request(spec)` builds an auditable request containing an argv array, separate stdin, cwd, and environment delta. It does not grant execution permission. Codex's proposed native request resolves a real executable from PATH and uses the fixed argument array:

```text
codex --no-daemon -a never --cd CWD exec --ephemeral --skip-git-repo-check --json --sandbox read-only -
```

Native Codex is enabled only after its per-execution preflight passes. The runtime enumerates current MCP names in memory, accepts only `[A-Za-z0-9_-]+`, appends `-c mcp_servers.NAME.enabled=false` for every one, and adds `-c notify=[]`. It also appends `--disable` for each of: hooks, plugins, remote_plugin, apps, computer_use, browser_use, browser_use_external, image_generation, multi_agent, workspace_dependencies. It probes the resulting `features list` and `mcp list --json` and verifies all required flags are false and the exact same MCP names are disabled. Only names/enabled and the required feature booleans are retained; raw configuration responses and credentials are never logged. Failed/unrecognized schema, unsafe names, missing required flags or changed MCP discovery fail closed. These are one-shot command-line overrides; no global config/auth file is edited or directly read by this runtime.

The adapter preflight was actually run on this machine without inference: all ten feature flags and cua_repl/jk-launcher/node_repl/plan-map were false. This is a verified boundary for those audited surfaces plus the native shell sandbox, not a universal isolation claim. Real inference evidence is recorded separately from engine tests. General `dsh` remains disabled; the distinct prompt-only `dsh-text` adapter is described below.

For enabled adapters, prompts are delivered asynchronously through stdin, limited to 64 KiB; a 10-second stdin delivery timeout prevents a non-reading CLI from blocking cancellation indefinitely. Windows `.cmd`/`.bat` launchers are rejected because they introduce shell parsing. No real model inference has been run during engine testing. Exit 0 plus final `turn.completed` is required for a native Codex result; final `turn.failed`/`error` prevents success. JSONL output is saved in the state directory; it can contain task-sensitive content, so retain this directory privately.

The legacy dsh identifier remains disabled. Use the explicit dsh-workspace adapter for actual authorized project file operations, or dsh-text for supplied-text analysis. The verified invocation is `--profile headless --patch FIXED_PATCH --json -`, with cwd supplied by Popen. Permission and protocol receipts are validated by the respective adapter, and task content is checked by the workflow controller.

### Prompt-only DeepSeek (`dsh-text`, 2026-10-19)

`dsh-text` is a separate limited adapter for analysis/review of text already supplied by the controller. It never offers the model file access, shell execution or subagents. The manifest must use `permission: read-only` and no `external_tools`; `timeout_seconds` is optional (10..600, default 180). Example:

```json
{
  "adapter": "dsh-text",
  "permission": "read-only",
  "prompt": "Analyze only this supplied content. Do not call tools. Return JSON: ...",
  "timeout_seconds": 180,
  "resources": ["deepseek-review"],
  "depends_on": [],
  "artifacts": []
}
```

The fixed local executable loads the existing native login through its normal operation. This runtime does not directly inspect, copy or edit global credentials/configuration. One per-invocation patch `dsh-text.patch.yml` sets all permission presets to read-only/never and mounts exactly one all-tools-denied guard. The headless runner requires the guard's provided service, so missing plugin activation cannot silently proceed as an accepted protected run. The guard also throws if the effective turn policy differs. Environment changes apply only to the child (`ELECTRON_RUN_AS_NODE=1`, `DSH_PERMISSION_MODE=read-only`); argv is fixed and prompt is separate stdin, `shell=False`.

A successful task requires exit 0, exactly one session matching every audited policy, one guard-ready record, effective read-only/never/allToolsDenied, a completed turn and one nonempty final text. Any tool attempt (even blocked), native error, malformed guard audit or missing proof fails. Results expose `final_text`, optional strictly parsed `final_json`, `session_id`, policy records and `transport_policy_passed`; semantic correctness is explicitly `controller-required`. `artifacts_verified: null` still proves no delivery. Engine fixtures are not actual DeepSeek acceptance; native run receipts belong in the dated acceptance output folder.

The tools guard restricts model tool dispatch, not every startup/plugin/network/cache operation of the installed harness. DSH may write its ordinary session/cache state and use the existing model account. This adapter provides no general filesystem executor, universal process sandbox, persistent daemon, or descendant termination guarantee. Closing a desktop client remains a separate acceptance condition.

`timeout_seconds` bounds the model phase. Before that phase, a fixed Electron filesystem probe verifies the ASAR entry with a separate 20-second bound; cancellation during that probe waits for it to return. This is not a strict whole-task deadline. The controller reads predecessor results and supplies the next prompt; dependencies do not automatically inject result content.

`local-test` is a deterministic engine adapter, never a cross-harness acceptance test. Enqueue requires `--allow-test-adapter`, and cwd must resolve under `.work/full-acceptance-20261016/runtime-tests`. It can sleep (`delay`, 0..60 seconds), emit a fixed JSON terminal event, return an `exit_code`, and create declared artifacts with optional `content` solely within its validated test cwd. `test_ignore_stdin: true` selects a fixed non-reading subprocess to exercise cancellation under pipe backpressure. Its test writes are explicitly distinct from the read-only policy used for real harnesses. No user-selected executable or command is run.

## Recovery, cancellation, and evidence

State transitions: queued → running → succeeded/failed/cancelled; impossible failed dependencies → blocked; safely identified missing execution → interrupted (or cancelled if requested); uncertain launch/termination → unknown. Cancel queued/interrupted work immediately. Running cancellation is observed by its executor. Workspace adapters verify their owned process tree stopped; older read-only/test adapters terminate only their directly owned Popen process. Finished tasks are never reset or retried.

The worker launches an independent hidden executor which saves task results to SQLite. If the worker dies, an executor can still finish and persist results. `recover` requires the worker lock and skips executors with an active task lock. Each claim atomically clears old PID/result and creates a new attempt_id. A launch intent tied to that attempt is committed before Popen; process identity confirmation is persisted with the current attempt afterward. A crash before confirmation becomes `unknown` regardless of any stale PID and retains resources; `recover --retry` cannot queue it. An apparently live PID without an executor also becomes unknown, making a possibly reused PID an explicit operator-verification condition rather than silently waiting forever or killing an unrelated process. An unconfirmed termination/cleanup timeout likewise becomes unknown and retains resources.

`resolve-unknown TASK --confirm-no-process-running` records the operator's explicit process verification, requires both worker/task locks, rejects a still-live recorded PID, and converts the task to interrupted/cancelled while releasing resources. Do not use it without actual process verification. Once a known recorded process has exited, ordinary recover can mark that task interrupted. `recover --retry` explicitly queues interrupted read-only work again; crash effects are not claimed to be exactly-once. Without `--retry`, interrupted work is not silently rerun. Cancel plus recover can close safely interrupted work without executing it again. Cancelling unknown work sets a cancellation request but retains its uncertain execution/resources until resolution.

Results record `exit_code`, recognized `terminal_event`, artifact policy, each declared file's existence/hash verification, and `artifacts_verified` separately. No artifacts declared gives `artifacts_verified: null`, not proof of a deliverable. File verification proves present bytes and optional expected hash, not freshness or semantic correctness of an existing artifact. Application-specific acceptance still requires appropriate checks.

## Verified limits

Engine tests exercise actual Python subprocesses, durable SQLite state, cancellation, lock conflicts, crash recovery, and launcher-exit survival. They do not prove native Codex/DSH interoperability, correctness of generated work, survival of closing Codex Desktop, OS reboot survival, global machine resource isolation, descendant-process-tree termination, or unattended scheduling after every host shutdown. Windows process detachment can still be constrained by an enclosing job object; test that explicitly in the intended deployment before promising host-exit survival. A cancelled real harness may leave descendants; no process-tree-wide kill is attempted.

Run the engine checks from `.work/full-acceptance-20261016/runtime-tests`:

```powershell
python -B -W error::ResourceWarning -m unittest -v test_runtime
```

Tests retain isolated `case-*` directories for audit; they only terminate the worker processes they create.
