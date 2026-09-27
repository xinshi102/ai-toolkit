# Cross-harness task handoff

Use this when Codex and DSH work on the same objective. The canonical schema is maintained at:

`/Users/xinshi/Documents/deepseek/work/dshworkspace/docs/cross-harness-task-contract.md`

Read that file before creating or changing a bridge message contract. Keep the durable task card and progress file in the shared project/workspace; the bridge carries a task ID and concise work packet, not a second copy of the entire task history.

## Minimum handoff

Include a stable `taskId`, a resolvable `taskCardRef`, current status, workspace reference, goal, relevant context, one bounded action, explicit boundary, expected return artifact/evidence, and a reply reference when responding. Never include credentials or a bulk personal knowledge dump.

## Status and proof

Track the receiver’s acknowledgment (`read`, `processing`, `completed`, or `failed`) separately from sender-side persistence/delivery. `completed` is the receiver’s claim; the task owner still inspects the artifact and runs the required acceptance. A missing receiver acknowledgment means delivery is unverified.

## Path portability

Prefer paths relative to the shared workspace and include a stable task ID. If harnesses do not share a filesystem, attach or inline only the minimum approved artifact and identify its version/hash where practical. Do not assume a local absolute path resolves on the other machine.
