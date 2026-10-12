# Hermes Task Contract

Use this structure for every delegated run. Remove irrelevant optional sections, but never omit scope, write boundaries, validation, or stopping conditions.

```markdown
# Task: <short name>

## Outcome
<One observable end state.>

## Context and decisions already made by Codex
- <Decision Hermes must implement, not reconsider.>

## Execution lane
- Provider: `<provider id or isolated-profile default>`
- Model: `<model id or isolated-profile default>`
- Cost/usage boundary: `<call, token, time, or retry limit>`
- Do not fall back to another provider without a new Codex decision.

## Inputs and allowed reads
- <Absolute paths or explicitly approved sources.>

## Allowed writes
- <Exact files or directories.>
- Update `<project>/ITERATIONS.md` with the iteration result.

## Forbidden actions
- Do not access secrets, accounts, unrelated local files, or external systems.
- Do not publish, deploy, delete, or change network configuration unless explicitly authorized.
- Do not expand scope or redesign decisions made by Codex.

## Stages
1. <Stage with a durable intermediate artifact.>
2. <Next stage.>
3. Run validation and inspect the resulting artifact.

## Validation Hermes must run
- `<exact command or deterministic check>`
- <Content, file-scope, or visual checklist.>

## Acceptance criteria for Codex
- <Observable requirement.>
- <Expected tests and outputs.>
- <No changes outside allowed writes.>

## Stop conditions
- On a material ambiguity, write a blocked checkpoint and stop.
- After two failed attempts on the same issue, report the root-cause evidence and stop guessing.
- Never claim completion without the requested artifact and passing validation.
```
