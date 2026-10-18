# Codex runtime adapter

Use this adapter only when applying Xinshi Improve inside Codex. The common collaboration rules remain in `E:/AI-Workspace/Projects/Shared/Agent-Conventions/collaboration.md`; this file records Codex-specific mechanics.

## Entry and context

- Codex reads project `AGENTS.md` automatically. Follow its read order and the v1.12 router.
- User-level skills live under the user-level native skill directory (`~/.agents/skills/` in current Codex, or the host's supported legacy root); this Windows installation routes to the single canonical shared protocol directory.
- Use Codex Plan for the current implementation plan and Goal for a durable multi-session objective when the app exposes them. Keep project task card/progress files as the cross-harness source of truth.

## Handoff and evidence

- See `task-handoff.md` for the shared task envelope and bridge state semantics.
- Resolve personal knowledge access through the active project's declared knowledge entry and the workspace migration mappings. Read a project-specific personal-knowledge-access contract only when it exists; do not assume the old macOS location is available.
- A bridge API response or local outbox write proves persistence only. Report remote receipt only when the receiving harness records its terminal acknowledgment.
- Do not expose hidden reasoning. Share task state, decisions, evidence, blockers, and next action.

## Capability differences

- Codex may have tools unavailable to DSH, such as project file access or app-managed goals; availability depends on the current host and task.
- Tool availability does not imply permission to use credentials, trigger paid inference, send messages, restart a harness, or publish externally. Apply the current user and project boundaries.
- If an expected app capability is unavailable, preserve the acceptance criterion and provide the strongest local evidence possible; explicitly mark remote acceptance unverified.
