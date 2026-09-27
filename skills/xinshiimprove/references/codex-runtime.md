# Codex runtime adapter

Use this adapter only when applying Xinshi Improve inside Codex. The common collaboration rules remain in `../share/collaboration.md`; this file records Codex-specific mechanics.

## Entry and context

- Codex reads project `AGENTS.md` automatically. Follow its read order and the v1.12 router.
- User-level skills live under `~/.codex/skills/`; this migration bundles a versioned `share/` snapshot for predictable routing.
- Use Codex Plan for the current implementation plan and Goal for a durable multi-session objective when the app exposes them. Keep project task card/progress files as the cross-harness source of truth.

## Handoff and evidence

- See `task-handoff.md` for the shared task envelope and bridge state semantics.
- For the personal Obsidian wiki location and cross-device limit, read `/Users/xinshi/Documents/deepseek/work/dshworkspace/docs/personal-knowledge-access.md` when the active environment can access it.
- A bridge API response or local outbox write proves persistence only. Report remote receipt only when the receiving harness records its terminal acknowledgment.
- Do not expose hidden reasoning. Share task state, decisions, evidence, blockers, and next action.

## Capability differences

- Codex may have tools unavailable to DSH, such as project file access or app-managed goals; availability depends on the current host and task.
- Tool availability does not imply permission to use credentials, trigger paid inference, send messages, restart a harness, or publish externally. Apply the current user and project boundaries.
- If an expected app capability is unavailable, preserve the acceptance criterion and provide the strongest local evidence possible; explicitly mark remote acceptance unverified.
