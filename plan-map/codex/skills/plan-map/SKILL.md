---
name: plan-map
description: "Automatically create, restore and display inline persistent visual plans for multi-stage tasks, multiple deliverables and substantial task continuations in any Codex conversation, including Chinese requests without a Plan keyword."
---

# Plan Map

Assess applicability in every conversation and reassess when a simple request becomes substantial. Use this workflow when the task normally has three or more meaningful steps, multiple deliverables or dependent stages, or continues an existing substantial task across turns or conversations. Skip standalone factual answers, translations and trivial one-step edits unless the user asks for a map. Chinese requests need no Plan keyword or Plan mode.

Use the plan-map MCP server's `plan_list`, `plan_import`, `plan_view`, and `plan_node` tools when available. The source is `/Users/xinshi/Documents/deepseek/work/dshworkspace/adapters/codex-plan-map/`.

At the start of a qualifying task, use `plan_list` and inspect candidate plans with `plan_view`. The list omits conversation metadata, so inspect the full plan before deciding it matches. Match the task and known conversation ID; an explicit continuation can reuse another conversation's plan when its contents match. A shared project or the newest saved plan alone is insufficient. For an unrelated task, create a fresh planId using the conversation ID when known and a task suffix; otherwise use a unique task ID. Do not attach yesterday's completed plan to unrelated work.

For a task the user has authorized, derive a short hierarchical outline and call `plan_import` once without seeking separate outline approval. If the user explicitly requires approval before execution, respect that requirement. Include the conversation ID when known. Do not recreate or overwrite an existing plan blindly. Every edit to an existing plan must include the latest expectedRevision from a read; on conflict, re-read and incorporate the user's changes.

Mark the first work node active and display the plan before substantial execution. Before moving to a new step, update the current node; after verification, mark it done. Mark blockers explicitly and leave unverified work pending. Never mark a whole plan done simply because a turn ends. Record user-visible steps and brief outcomes, never hidden reasoning.

Only leaf work items count toward completion percentage. Parent stages keep their own explicit status. Use plan_node to set stage status when relevant. Multiple active branches are allowed.

Display the native MCP App inline in the chat with `plan_view`. For the user's default workflow, do not call `open_in_codex`, `createBrowserTab`, or any browser navigation to display or verify a plan. Calling plan_view and also opening viewerUrl creates duplicate views. Uncertainty about inline visibility, a missing browser tab, or inability to inspect the inline widget is not a reason to open the right panel. Report a genuine inline display limitation and continue safe task work; open the browser version only when the user explicitly requests it. Do not mark a Plan Map browser tab as a retained deliverable in the default inline workflow.

The user has confirmed inline rendering in this desktop app. This does not prove that every other conversation has the MCP connection. Display belongs to the current conversation: a map opened in another conversation does not satisfy this step. The MCP resource is `ui://xinshi-plan-map/v6.html`. When the user explicitly requests a browser version, read plan_view for the current viewerUrl; never hardcode a previous localhost port. Reuse a matching plan tab and preserve unrelated tabs. If inline display is confirmed and an automatically opened duplicate tab is accessible in this conversation, close that matching tab. Do not create a tab in an attempt to find or close an inaccessible duplicate.

Verify that the intended title and current step appear in the embedded map or fallback panel. A user screenshot showing the map is valid display evidence. A tool result, queued panel request or MCP registration is not proof of visible display; report any display limitation and continue safe task work. The local viewer polls saved data and supports fold/zoom/details/status/reparenting. A new or refreshed conversation may be needed after initial MCP registration.

If these MCP tools are missing in the current turn, do not pretend they are available. The same local server can be called through its MCP SDK as a temporary adapter, report this boundary clearly and use the browser viewer only if the user explicitly requests it.

This automatic behavior is driven by user-level instructions and skill selection when the AI handles a qualifying request. It does not install a native new-chat hook, open a plan before any message is handled, or deploy the local server to other computers or cloud chats. Keep the installed skill and its distribution copies consistent when changing this workflow.
