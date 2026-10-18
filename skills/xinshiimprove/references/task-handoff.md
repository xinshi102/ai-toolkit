# Cross-harness task handoff

Use this when harnesses work on the same objective. Read the active shared project's existing task/bridge contract before creating or changing a bridge message contract. For the common handoff packet, use `E:/AI-Workspace/Projects/Shared/Agent-Conventions/handoff_prompt_template.md`. The old macOS contract is not present on this machine; do not invent a bridge endpoint or claim that a bridge has been configured. Keep the durable task card and progress file in the shared project/workspace; the bridge carries a task ID and concise work packet, not a second copy of the entire task history.

## Minimum handoff

Include a stable `taskId`, a resolvable `taskCardRef`, current status, workspace reference, goal, relevant context, one bounded action, explicit boundary, expected return artifact/evidence, and a reply reference when responding. Never include credentials or a bulk personal knowledge dump.

## Status and proof

Track the receiver’s acknowledgment (`read`, `processing`, `completed`, or `failed`) separately from sender-side persistence/delivery. `completed` is the receiver’s claim; the task owner still inspects the artifact and runs the required acceptance. A missing receiver acknowledgment means delivery is unverified.

## Path portability

Prefer paths relative to the shared workspace and include a stable task ID. If harnesses do not share a filesystem, attach or inline only the minimum approved artifact and identify its version/hash where practical. Do not assume a local absolute path resolves on the other machine.
