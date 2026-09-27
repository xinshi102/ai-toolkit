---
name: xinshiimprove
description: "Apply Xinshi’s v1.12 cross-harness collaboration system for task planning, project onboarding, tool adaptation, experience capture, and rule maintenance."
---

# Xinshi Improve

Use the bundled `share/ROUTER.md` as the only always-loaded index. Route by task type and read only the applicable sections/files; do not load the full share library by default. Treat `share/` as a read-only snapshot unless the user explicitly requests a rule-source change.

Follow the active project’s `AGENTS.md` and the user’s current instructions. The shared `collaboration.md` defines phase gates, task sizing, acceptance, reports, and knowledge capture. Read its version and compare it with the project baseline for each task. For XL work, read the project `progress.md` at session start and update it before handing off.

For Codex-specific behavior, read [references/codex-runtime.md](references/codex-runtime.md). For tasks shared with another harness, read [references/task-handoff.md](references/task-handoff.md) and use the canonical task contract recorded in the shared workspace. Keep status claims tied to evidence: local persistence does not prove remote receipt.

Use the DSH `plan-map` / `thinking-chain` concepts only where available; in Codex, use the native Plan and Goal facilities plus the shared task card. Do not expose hidden chain-of-thought: record brief stage, decision, and verification notes only.

When personal knowledge is relevant, consult the configured Obsidian wiki entry point and follow that vault’s schema. Do not copy private source notes into task cards, bridge messages, or another harness unless the user explicitly asks and the destination is appropriate.

The v1.12 closeout requires a concise self-assessment and a separate human-facing acceptance report. At task end, ask the four rule-observation questions in one sentence; only record an observation if the user recognizes one. Do not independently change shared rules, delete skills, or promote an experiment as effective.
