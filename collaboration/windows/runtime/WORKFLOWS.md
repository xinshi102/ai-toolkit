# Workflow controller

The main agent generates the graph and revisions. The user does not maintain task JSON or relay outputs. This controller executes an explicit changing task graph, over the existing SQLite queue and process runner; it does not claim autonomous semantic planning.

CLI, with `runtime/workflow.py` as the script:

```
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW init graph.json
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW run --max-concurrency 2 --timeout-seconds 600
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW status
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW revise change.json
python -B runtime/workflow.py --project-root PROJECT --state PROJECT/.work/FLOW cancel NODE
```

Graph: `{id,version,nodes:[...]}`. Each non-external node has `id`, `owner`, `provider`, `prompt`, `depends_on`, `write_paths`, and nonempty `checks`. Providers map directly to verified queue adapters: `codex`, `codex-workspace`, `dsh-text`, `dsh-workspace`, `codebuddy-workspace`; `local-test` requires explicit test allowance. Native write providers default workspace-write; other providers default read-only. Additional adapter parameters go into `queue_spec`; the controller controls adapter, cwd, prompt, dependencies, resources and permission itself. All paths are relative to project root, including acceptance file paths.

`codebuddy-workspace` uses the separately installed official CodeBuddy Code CLI and its native login. Explicit permission is `read-only` (Read/Glob/Grep) or `workspace-write` (also Write/Edit/Bash). MCP is empty, hooks disabled, non-whitelisted tools denied. These are native application tool policies, not OS filesystem isolation; Bash is powerful and only authorized project tasks belong in this profile. The runner validates session-bound stream results, declared capabilities, errors and actual artifacts; exit zero alone is insufficient. Windows owned-job termination applies to both profiles. Company backend/MCP access requires separate connection and authorization verification; CLI login does not establish it. Fixed installation and flags are checked before every dispatch. See ../README.md for Windows setup. Public fixtures are synthetic; private execution logs are not distributed.

Prompts bind accepted predecessors using `{{result:NODE}}` (full actual runner result JSON) and `{{file:NODE:relative/path}}` (UTF-8 text within that producer's declared write_paths). File binding additionally requires a successful producer file check and matching acceptance-time SHA-256; changed bytes are rejected and require revising the producer. Binding requires a direct dependency, is limited to 32 KiB each, and rejects parent traversal, absolute paths and physical escapes through links. Overall queue prompt limits still apply. Bound data is task data; the model remains responsible for treating instructions inside documents as untrusted.

Acceptance rules:

- `{"kind":"file_exists","path":"out.json"}`
- `{"kind":"file_contains","path":"out.txt","contains":"required nonempty text"}`
- `{"kind":"file_json_keys","path":"out.json","keys":["rows"]}`
- `{"kind":"final_json_keys","keys":["approved"]}`
- `{"kind":"final_json_values","values":{"approved":true}}` (strict type and value)
- `{"kind":"python_unittest","module":"tests.test_pipeline","cwd":".","timeout_seconds":60}` (actual local test execution by controller, fixed argv, 1..180-second bound, output and exit code retained)

Transport success alone does not release dependencies: every explicit acceptance check must pass. Test rules execute already authorized project code; a graph is an execution instruction, not a way to acquire new external-account authority.

Revision: `{"expected_revision":1,"nodes":[{"id":"task","prompt":"new input"}],"retry":["failed-task"],"inputs":{"source":{"result":{"version":2}}}}`. Only supplied fields change; external input updates require external nodes. Changes invalidate descendants, preserve all prior results in history, cancel prior underlying tasks, and create new attempts rather than resetting old queue rows. Independent accepted branches remain accepted. Revision mismatches fail before queue mutations. Runtime fields cannot be patched.

External nodes: `{id:"source",external:true}` wait without creating a model task. Supply their result through `revise`. With only blocked or waiting work, `run` returns `needs_attention`; it does not report successful completion. `cancel NODE` only targets that workflow node's task. Failed acceptance requires a revision/retry decision by the main agent; there is no hidden infinite retry or invented approval.

One workflow file owns one state directory and its queue, with a persistent project-root binding that rejects reopening under another root. `controller.lock` prevents duplicate controllers; `state.lock` coordinates brief updates, so revise/cancel can operate while run is active. Validation runs outside that lock, with task/input-version checks before accepting results; a cancelled or revised attempt cannot overwrite the new state. Enqueue identities are saved before queue submission and reconciled after interruption to prevent duplicate dispatch. Declared write paths are normalized into resources, with directory/descendant overlap reserved until actual underlying termination. These declarations coordinate cooperating workers; they do not constitute an OS sandbox or detect undeclared writes by arbitrary programs. Distinct state directories do not coordinate their reservations. Cancel is a no-op for accepted, failed or already cancelled nodes; revising accepted evidence requires an explicit revision.

Timeout bounds the current controller wait and validation time, and returns resumable state. A controller-budget timeout defers unfinished validation instead of falsely failing the business result. Existing worker attempts may continue; rerunning `run` collects them. This is not a registered service, OS-reboot recovery, nor proof of desktop-exit survival. Desktop-exit and OS-reboot survival require separate verification on the target machine.

Validation: `python -B -m unittest discover -s runtime/tests -p test_workflow.py -v`. The 20 tests include real SQLite/runner parallel execution and automatic downstream file binding using the explicitly labelled deterministic local-test adapter, concurrent cancellation during validation, bounded validation timeout, project-root binding, and bounded state-lock waiting. State edits wait at most two seconds for transient lock contention; business exceptions are never retried. The controller's exclusive running lock still fails immediately on duplicate run. Actual model acceptance is recorded separately by the main controller.

## Event gate and budget (token control)

The runner stays the durable executor; the controller should not poll it. After each `run` returns, emit one event for the state transition and let the gate decide whether a model call is justified:

```
run -> accepted        => task_succeeded
run -> failed          => task_failed
run -> needs_attention => needs_decision
node blocked/deviation => blocked / deviation
```

```powershell
python -B runtime/events.py emit --task T1 --type task_succeeded --status accepted --payload '{"artifact":"out.json"}'
python -B runtime/gate.py --db .work/collab-events/collab.db --state-dir .work/agent-state --once --dry-run
```

`gate.py` filters ignored/progress events locally, enforces a cooldown, builds a
<=4 KiB snapshot from `.work/agent-state/<task>.json`, and makes at most one
controller call (`--wake-cmd`). `budget.py` caps tokens, wall clock and polls per
task. See `COLLAB_EVENTS.md` for the full contract and integration example.
