# Event gate and budget (token control)

The runner already persists tasks and validates artifacts. This layer controls
**when the controller model is called at all**. It exists because the expensive
failure mode is not execution, it is the controller polling a running task:
every status check carries the full conversation and is billed as input.

```
executor / runner ──emit──> events.db ──local rules──> gate ──one call──> controller
                                                   │
                                                   └─ verdict + snapshot -> gates.db
```

Everything before the controller call is deterministic and free. The gate never
reads a transcript, never stays resident, and never polls a model.

## 1. Event bus — `events.py`

SQLite, append-only. Default DB: `.work/collab-events/collab.db` (local, Git-ignored).

```powershell
python -B runtime/events.py --db .work/collab-events/collab.db emit --task T1 `
  --type task_succeeded --status ok --payload '{"artifact":"out/report.md"}'
python -B runtime/events.py --db .work/collab-events/collab.db list --unconsumed
python -B runtime/events.py --db .work/collab-events/collab.db wait --since 0 --timeout 30
```

Event fields: `id, task_id, type, status, severity, payload, created_at, consumed_at`.
Payload is a JSON object capped at 8 KiB; oversized payloads are replaced by a
`_truncated` marker rather than copied.

Recommended types:

| type | meaning | gate |
|---|---|---|
| `task_succeeded` | executor finished, artifacts ready | Gate 2 |
| `task_failed` | failed / tests failed | Gate 2 |
| `gate1_requested` | plan slice ready for pre-execution review | Gate 1 |
| `plan_locked` | requirements locked, plan frozen | Gate 1 |
| `deviation` | executor left the plan | Gate 1 |
| `needs_decision` | branch/blocking decision required | escalation |
| `blocked` | cannot continue | escalation |
| `budget_exceeded` | circuit breaker fired | escalation |
| `task_started`, `progress`, `heartbeat`, `tool_call`, `artifact` | noise for the gate | ignored |

## 2. State — `state.py`

The plan is authoritative here, not in chat history. One JSON file per task:
`.work/agent-state/<task>.json`.

```json
{
  "task_id": "T1",
  "phase": "executing",
  "plan_version": 2,
  "plan_hash": "sha256...",
  "plan": "phase 1 ...; phase 2 ...",
  "decisions": ["use SQLite, no server"],
  "progress": ["phase 1 accepted"],
  "deviations": [],
  "artifacts": ["out/report.md"],
  "acceptance": {"file_exists": "out/report.md"},
  "budget": {"tokens": 12000, "polls": 3}
}
```

`state.snapshot()` builds a <=4 KiB slice: task identity, plan excerpt, last
5 decisions/progress/deviations, acceptance, budget, artifact names, and the
event payload with `stdout/stderr/transcript` removed. This is what the
controller sees; never the full transcript.

## 3. Gate — `gate.py`

```powershell
# Build prompts and record DRY_RUN, no model call.
python -B runtime/gate.py --db .work/collab-events/collab.db --state-dir .work/agent-state --once --dry-run

# One paid controller call per event, prompt on stdin.
python -B runtime/gate.py --db .work/collab-events/collab.db --state-dir .work/agent-state --once `
  --wake-cmd "codex exec -s read-only -C . --skip-git-repo-check --color never -"
```

Rules (first match wins):

1. `severity` is `error`/`critical` -> wake (escalation unless typed).
2. type in the table above -> wake its gate.
3. payload contains `error`, `failed`, `blocked`, `timeout` -> escalation.
4. same `task + type` inside `--cooldown` (default 60 s) -> ignored.
5. everything else -> consumed silently.

Ignore/consume events are marked consumed too, so the queue does not grow.
`gates.db` records `task_id, event_id, gate_type, verdict, reason, snapshot`.

The prompt asks for exactly:

```
VERDICT: PASS|FAIL
REASON: one short sentence
FIX: ...        (only on FAIL)
```

This is Gate 1 (before execution), Gate 2 (after delivery), or escalation
(plan-external branch / irreversible action / repeated failure / budget).
Small, low-risk tasks can skip Gate 1; do not wake the controller per phase.

## 4. Budget — `budget.py`

```powershell
python -B runtime/budget.py --db .work/collab-events/collab.db start --task T1 --tokens 200000 --seconds 1800 --polls 120
python -B runtime/budget.py --db .work/collab-events/collab.db charge --task T1 --tokens 12000
python -B runtime/budget.py --db .work/collab-events/collab.db poll --task T1
python -B runtime/budget.py --db .work/collab-events/collab.db status --task T1
```

Charges: every controller call (`--tokens`), every status poll (`poll`), wall
clock from `start`. On the first crossing the task becomes `blocked` and one
`budget_exceeded` event is emitted; further charges do not emit duplicates.
Defaults: 200k tokens / 1800 s / 120 polls per task.

## 5. Integration with the workflow runner

Do not put a model in the polling loop. After each `workflow.py run` returns,
emit one event and let the gate decide:

```text
run -> accepted     => task_succeeded
run -> failed       => task_failed
run -> needs_attention => needs_decision
node deviation      => deviation
```

Example wrapper (pseudo):

```python
from runtime import events, gate
result = run_workflow()                      # existing runner
task = result['node']
kind = {'accepted': 'task_succeeded', 'failed': 'task_failed'}.get(result['state'])
if kind:
    events.emit('.work/collab-events/events.db', task, kind, result['state'], payload=result['summary'])
gate.run_once('.work/collab-events/gate.db', Path('.work/agent-state'), wake_cmd=CMD)
```

The runner itself already has resumable state, dependency binding and
acceptance checks. This layer only replaces "controller polls every N seconds"
with "controller wakes on a state transition".

## 6. Tuning

- Poll interval if you must keep a fallback: 30–60 s, with a max poll count.
  Near the provider cache TTL a poll can degrade into a fresh prefix write; an
  event is always cheaper.
- Budget per task, not per project. A 200k cap stops a runaway loop before it
  burns the day.
- Gate 1 only for irreversible, cross-module, or ambiguous work. Gate 2 once at
  delivery. Escalation only for plan-external branches.
- Keep the state file small: decisions and progress are one line each, not logs.
- The same-harness session can be resumed (`--resume`); a new CLI process with
  a full history is the expensive path this layer is meant to avoid.

## 7. Boundaries

- Event rules are deterministic; false negatives are possible. Keep a manual
  `emit` path for anything important.
- The gate does not sandbox tools or grant permissions; that stays with the
  adapter and the task authorization.
- `--wake-cmd` is operator-controlled (`shell=True` for Windows portability).
  Do not build it from untrusted task text.
- SQLite is local and single-machine. Cross-machine coordination needs a real
  broker (NATS, Redis Streams) later; the event schema stays the same.
