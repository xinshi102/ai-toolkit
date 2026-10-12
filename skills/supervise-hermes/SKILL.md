---
name: supervise-hermes
description: Delegate suitable local work to the user's isolated Hermes worker, optionally selecting DeepSeek or another explicit inference provider, while Codex remains the planner, supervisor, tester, and final acceptance owner. Use when the user asks to hand work to Hermes or DeepSeek, asks Codex to supervise them, wants to save Codex quota on straightforward execution, or when Codex identifies a bounded, reversible, testable subtask that an external worker can perform. Applies to coding, structured writing, file organization, batch edits, research over approved non-sensitive local sources, and other tasks with explicit inputs and acceptance criteria. Do not use it to delegate secrets, account operations, private material without informed approval, irreversible actions, external publishing, high-stakes decisions, or final product judgment.
---

# Supervise Hermes

Remain accountable for the result. Use Hermes as a local execution worker, never as the planner or final authority.

## Choose the execution mode

Inspect the current files and constraints before delegating.

- Delegate to Hermes when the work is bounded, reversible, low-risk, and independently testable.
- Use a hybrid mode when Codex must make product, architecture, scope, or quality decisions but Hermes can implement a clearly bounded portion.
- For local image generation, also follow `$generate-images-with-comfyui`: Hermes may run batches, but Codex must define the visual brief, inspect every candidate, and accept the image in its rendered context.
- Keep the work in Codex when it involves ambiguous strategy, secrets or accounts, sensitive/private sources, destructive operations, external state changes, high-stakes advice, or primarily visual/product judgment.
- Honor an explicit user request to use Hermes only when the task is safe to delegate. Explain briefly when retaining a task or a decision in Codex.

Never send credentials, tokens, account data, contact details, or unrelated local context to Hermes. Hermes uses an external inference provider. For private or sensitive source material, obtain informed user approval before delegation or use sanitized/synthetic inputs.

## Select the inference provider

Choose the execution lane before writing the task contract:

- Keep planning, architecture, ambiguous debugging, high-impact judgment, and final acceptance in Codex.
- Prefer DeepSeek for simple, low-risk, reversible work with deterministic validation when project instructions permit it.
- Honor an explicit safe provider/model request. Otherwise use the project policy, then the isolated profile default.
- For DeepSeek, default to provider `deepseek` and model `deepseek-chat` unless the task requires a different model and its compatibility has been verified.
- Never switch providers silently after an authentication, protocol, quota, or quality failure. Return control to Codex with the evidence.

Before a paid run, verify only that the required credential variable exists and is non-empty. Never print, copy, log, persist in the task contract, or inspect its value. Record the selected provider and model names in the task contract and run status.

## Own the plan

Before launching Hermes:

1. Define the desired outcome and inspect relevant existing artifacts.
2. Make all material scope and design decisions in Codex.
3. Split the work into ordered, verifiable stages.
4. Decide what evidence will prove completion.
5. Create a task contract from [task-contract.md](references/task-contract.md).

Do not delegate an open-ended request such as “build this” without paths, constraints, stages, tests, and stopping conditions.

## Launch the managed worker

Use the isolated `codexworker` profile only through:

```text
/Users/xinshi/.local/bin/codexworker-run \
  --task-file <absolute-task-contract> \
  --cwd <absolute-project-directory> \
  --timeout <seconds> \
  --max-resumes 3
```

For a DeepSeek run, add explicit routing so resumes cannot drift to another provider:

```text
/Users/xinshi/.local/bin/codexworker-run \
  --task-file <absolute-task-contract> \
  --cwd <absolute-project-directory> \
  --provider deepseek \
  --model deepseek-chat \
  --timeout <seconds> \
  --max-resumes 3
```

Default to the `terminal,file` toolsets. Add network or other tools only when the task explicitly requires them and the data boundary permits it.

The runner archives the task, writes 15-second heartbeats, maintains a durable checkpoint, and records all execution segments in `session_chain`. Hermes `--resume` creates a new database session segment; treat the chain, not a single ID, as the unit of recovery.

Do not use Hermes fallback-provider configuration for supervised runs. A provider failure is a failed or blocked run that Codex must diagnose explicitly.

## Supervise execution

- Tell the user that Hermes has been delegated and state the bounded responsibility.
- Relay meaningful status at least once per minute while work continues.
- Treat a heartbeat as liveness only, not proof of progress.
- If three consecutive heartbeats show no message or checkpoint change, inspect `status.json`, the checkpoint, and attempt logs before deciding whether to wait or intervene.
- Let the runner perform bounded recovery. Do not restart manually while it is still healthy.
- If the recovery budget is exhausted, diagnose the failure from artifacts before retrying.
- Preserve user changes and enforce the task contract's allowed write paths.

Hermes must run the task-specific tests and record their results before declaring completion. Its self-test is evidence for review, not acceptance.

## Perform independent acceptance

After Hermes reports completion, Codex must independently:

1. Read the actual changed files and compare them with the task contract.
2. Inspect the diff or exact file scope for unintended changes.
3. Run the critical tests or validation commands again.
4. Verify the checkpoint and strict final protocol both report `complete`.
5. Verify `status.json` records the intended provider and model, and inspect `usage.json` without exposing credentials.
6. Verify `ITERATIONS.md` was updated for project changes.
7. For UI work, launch or inspect the rendered result and provide the user a visible preview or direct way to open it. File existence and build success are insufficient.
8. Judge content, usability, and product quality itself; do not inherit Hermes's self-assessment.

If acceptance fails, write a focused correction contract containing concrete evidence. Allow up to two correction rounds. After two failed rounds on the same issue, stop delegating fixes, locate the root cause in Codex, and decide the repair.

## Return the result

Return only a Codex-owned conclusion, not raw Hermes output. Include:

- the delivered outcome;
- the files or visible artifact;
- the independent tests Codex ran and their results;
- any remaining limitation or blocked item;
- a short note that Hermes executed the bounded work and Codex accepted it.

Never report success when the user cannot access or inspect the result.
