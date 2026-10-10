---
name: plan-map
description: "Keep a persistent visual plan with current steps and task progress in Codex. Proactively use for substantial multi-stage tasks, including Chinese requests; restore and open their plan each conversation without requiring the user to ask."
---

# Plan Map

Automatically use this workflow for substantial tasks with multiple stages or deliverables, or work continued across turns. The user does not need to say Plan or select Plan mode. At the beginning of each such task/conversation, open or restore the matching plan in the right panel. Reuse an existing matching tab, avoid duplicates, and skip trivial one-step work. Never assume the most recent saved plan belongs to the current conversation.

Use the plan-map MCP server's `plan_list`, `plan_import`, `plan_view`, and `plan_node` tools when available. The source is `/Users/xinshi/Documents/deepseek/work/dshworkspace/adapters/codex-plan-map/`.

For an approved multi-stage task, register a hierarchical outline once with a stable planId; include the conversation ID when known. Show `plan_view` to the user. Before proceeding to a new step, mark its node active; after verification, mark it done. Mark blockers explicitly and leave unverified work pending. These are user-visible steps and brief outcomes, never hidden reasoning.

At each new conversation, list and read the appropriate saved plan. Do not recreate or overwrite an existing plan blindly. Every edit to an existing plan must include the latest expectedRevision from a read; on conflict, re-read and incorporate the user’s changes. Never mark a whole plan done simply because a turn ends.

Only leaf work items count toward completion percentage. Parent stages keep their own explicit status. Use plan_node to set stage status when relevant. Multiple active branches are allowed.

The MCP resource is `ui://xinshi-plan-map/v3.html`. If the host doesn't render the MCP App, open the returned viewerUrl in Codex’s browser panel. The local viewer polls saved data and supports fold/zoom/details/status/reparenting. A new or refreshed conversation may be needed after initial MCP registration.

If these MCP tools are missing in the current turn, do not pretend they are available. The same local server can be called through its MCP SDK as a temporary adapter, or a visible browser viewer can be opened; report this boundary clearly.
