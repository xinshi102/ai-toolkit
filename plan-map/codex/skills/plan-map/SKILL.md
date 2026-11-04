---
name: plan-map
description: "Keep a persistent visual plan with current steps and task progress in Codex. Proactively use for substantial multi-stage tasks, including Chinese requests; restore and open their plan each conversation without requiring the user to ask."
---

# Plan Map

Automatically use this workflow for substantial tasks with multiple stages or deliverables, or work continued across turns. The user does not need to say Plan or select Plan mode. At the beginning of each such task/conversation, open or restore the matching plan in the right panel. Reuse an existing matching tab, avoid duplicates, and skip trivial one-step work. Never assume the most recent saved plan belongs to the current conversation.

Use the plan-map MCP server's `plan_list`, `plan_import`, `plan_view`, `plan_node`, `plan_batch`, and `plan_history` tools when available. Runtime 0.6.0 is installed at `E:/AI-Workspace/Projects/Shared/Plan-Map/codex/`. A running chat can retain older tools until it reconnects; inspect actual discovery before using new tools.

For an approved multi-stage task, register a hierarchical outline once with a stable planId; include the conversation ID when known. Show `plan_view` to the user. Before proceeding to a new step, mark its node active; after verification, mark it done. Mark blockers explicitly and leave unverified work pending. These are user-visible steps and brief outcomes, never hidden reasoning.

Build substantial plans as goal → major stages → actionable tasks. Major stages should describe meaningful outcomes; put implementation details and verification steps under the relevant stage. When work is added or split, reuse its existing branch instead of appending every step directly to the goal. Keep stage statuses and the current stage accurate so the overview supports decisions. For a small task, avoid unnecessary grouping. Restructure an existing authorized plan with stable IDs, preserving its task statuses, notes and blockers; do not regroup other saved plans without their project context. A flat native todo event is only a task list within its dedicated branch, not a replacement for the full hierarchical plan.

At each new conversation, list and read the appropriate saved plan. Do not recreate or overwrite an existing plan blindly. Every edit to an existing plan must include the latest expectedRevision from a read; on conflict, re-read and incorporate the user’s changes. Never mark a whole plan done simply because a turn ends.

Only leaf work items count toward completion percentage. Parent stages keep their own explicit status. Use plan_node to set stage status when relevant. Multiple active branches are allowed.

The current MCP resource is `ui://xinshi-plan-map/v8.html`; v3–v7 remain compatibility aliases. If the host doesn't render the MCP App, open the returned viewerUrl in Codex’s browser panel. Distinguish browser acceptance from actual embedded display and interaction. A new turn or refreshed connection may be needed after an upgrade.

## Automatic maintenance

The installed user PostToolUse hook runs `codex/maintenance-hook.js`. A successful explicit `plan_view` or `plan_import` binds the chat and its transcript identity to that plan; unbound or different transcripts cannot synchronize native todos. Native `update_plan` events maintain a separate “宿主待办联动” branch, preserving existing manual tasks. The bridge does not read transcript contents or infer task completion from prose.

When native `update_plan` is unavailable, maintain the approved plan through `plan_batch` or `plan_node` using a fresh revision. Report this as explicit AI maintenance, not verified host-event automation. Hook trust/discovery alone does not prove an actual event fired. Never mark the whole task complete while embedded or host-event acceptance remains pending.

If these MCP tools are missing in the current turn, do not pretend they are available. The same local server can be called through its MCP SDK as a temporary adapter, or a visible browser viewer can be opened; report this boundary clearly.

## Windows installation

The configured Node executable is C:/Program Files/nodejs/node.exe. The MCP server is E:/AI-Workspace/Projects/Shared/Plan-Map/codex/server.js. Persistent plan data is E:/AI-Workspace/Data/Plan-Map/Codex (PLAN_MAP_HOME); keep it private. Follow existing user authorization and workspace/project rules when selecting or updating approved plans. The DSH version keeps separate storage.
