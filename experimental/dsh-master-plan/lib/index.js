/**
 * @local/dsh-master-plan — HOST plugin (CONTROLLER surface).
 *
 * Wires the three layers together on the host side:
 *   - STATE:      `state.js` (model) + `store.js` (durable JSON document)
 *   - CONTROLLER: `controller.js`, reached only through the tools below and the
 *                 same-origin route in `route.js`
 *   - VIEW:       `client.js`, served to the Web app as a client module
 *
 * Five tools are the whole model-facing surface: read the plan, name the
 * project, mutate a task, move the Current Task, read the Mutation Log.
 */

import { createController } from "./controller.js";
import { defaultRoot } from "./store.js";
import { registerRoute } from "./route.js";
import { LIMITS, STATUSES } from "./state.js";

export const name = "@local/dsh-master-plan";
export const inject = ["tools", "systemPrompt", "webServer"];

/**
 * The policy that turns the tools from passive CRUD into a living plan.
 *
 * This section is the reason the plan stays current without the user asking:
 * it names the events that oblige the model to write, not just read.
 */
const POLICY = `## Master Plan (persistent, shared across conversations)

You own a durable **Master Plan** that lives outside this conversation and is
rendered to the user as an interactive tree inside the chat. It is the single
source of truth for long-running project work — the conversation is not.

Rules:

1. **Restore before you work.** At the start of any multi-step project, call
   \`plan_get\` FIRST. Never assume the conversation still contains the plan, and
   never rebuild it from memory: another session may have changed it.
2. **Mutate proactively, without being asked.** Whenever any of these happens,
   call the tool in the same step instead of narrating that the plan "should" change:
   - a task is confirmed complete → \`plan_task\` action=update, status=done
   - work is discovered that the plan does not contain → action=add
   - a task turns out to be too big → action=add its children under it, then
     keep the parent as the grouping node (do not leave a split implicit)
   - a dependency appears or disappears → action=update, deps=[...]
   - progress is blocked → action=update, status=blocked, blocked_reason="…"
   - a blocker clears → action=update, status=active (or pending) to clear it
   - focus moves to another task → \`plan_current\`
3. **Keep exactly one Current Task.** It is the work in progress; setting a task
   active or current is how the user knows where you are.
4. **Keep it small.** Phase-level and task-level nodes only — this is a plan, not
   a transcript. Put acceptance criteria or detail in \`note\` rather than adding
   nodes, and never add a node for something you can finish immediately.
5. **Do not narrate bookkeeping.** The tree updates inline for the user; a
   one-line note in your reply is enough.

Statuses: ${STATUSES.join(" / ")}. \`blocked\` requires \`blocked_reason\`.`;

/* ── argument validation (registry-ready tools validate in execute) ─────── */

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkObject(args, allowed) {
  if (!isRecord(args)) return ["arguments must be an object"];
  const errors = [];
  for (const key of Object.keys(args)) if (!allowed.includes(key)) errors.push(`unknown argument "${key}"`);
  return errors;
}

function checkString(value, field, { required = false, max = LIMITS.title } = {}) {
  if (value === undefined || value === null) return required ? [`${field} is required`] : [];
  if (typeof value !== "string") return [`${field} must be a string`];
  if (required && value.trim() === "") return [`${field} must not be empty`];
  if (value.length > max) return [`${field} must be at most ${max} characters`];
  return [];
}

const PLAN_TASK_ACTIONS = ["add", "update", "remove"];

/** Shared by \`plan_task\`; returns a list of human-readable problems. */
function validateTaskArgs(args) {
  const errors = checkObject(args, ["action", "id", "title", "parent", "status", "deps", "blocked_reason", "note"]);
  if (errors.length > 0) return errors;
  if (!PLAN_TASK_ACTIONS.includes(args.action)) {
    errors.push(`action must be one of ${PLAN_TASK_ACTIONS.join("|")}`);
    return errors;
  }
  if (args.action !== "add") {
    errors.push(...checkString(args.id, "id", { required: true, max: 64 }));
  } else if (args.id !== undefined) {
    errors.push(...checkString(args.id, "id", { max: 64 }));
  }
  if (args.action === "add") errors.push(...checkString(args.title, "title", { required: true }));
  else if (args.title !== undefined) errors.push(...checkString(args.title, "title", {}));
  errors.push(...checkString(args.parent, "parent", { max: 64 }));
  errors.push(...checkString(args.note, "note", { max: LIMITS.note }));
  errors.push(...checkString(args.blocked_reason, "blocked_reason", { max: LIMITS.blockedReason }));
  if (args.status !== undefined && !STATUSES.includes(args.status)) errors.push(`status must be one of ${STATUSES.join("|")}`);
  if (args.deps !== undefined) {
    if (!Array.isArray(args.deps)) errors.push("deps must be an array of task ids");
    else for (const d of args.deps) if (typeof d !== "string") errors.push("each dep must be a task id string");
  }
  return errors;
}

/* ── output helpers ────────────────────────────────────────────────────── */

const OK_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean" },
    text: { type: "string" },
    current_task_id: { type: "string" },
    tasks: { type: "integer" },
  },
  required: ["ok", "text"],
};

const textOut = (args, value) => [{ type: "text", text: value.text }];

/** Re-read the plan after a mutation so the model always sees the new state. */
async function snapshot(controller) {
  const state = await controller.read();
  const view = await controller.view({ logTail: 3 });
  return {
    ok: true,
    text: `${await controller.summary()}`,
    current_task_id: state.currentTaskId ?? "",
    tasks: view.stats.total,
  };
}

/* ── plugin ────────────────────────────────────────────────────────────── */

export default function plugin(ctx, config = {}) {
  const logger = ctx.logger;
  const logTail = Number.isInteger(config.logTail) ? config.logTail : 8;
  const controller = createController({
    root: typeof config.root === "string" && config.root !== "" ? config.root : defaultRoot(),
    logger,
  });

  ctx.systemPrompt.section({
    name: "tool:master-plan",
    order: ctx.systemPrompt.getSectionOrder("PLAN_POLICY"),
    text: POLICY,
  });

  ctx.effect(() => registerRoute(ctx, controller, { logTail }));

  ctx.tools.register({
    name: "plan_get",
    description:
      "Read the persistent Master Plan: project name, the full task tree with statuses, dependencies and blockers, the Current Task, and the tail of the Mutation Log. Call this FIRST when starting or resuming long-running project work — the plan lives across conversations, so the current session's context is not a reliable copy of it.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        log_limit: { type: "integer", description: "How many recent Mutation Log entries to include (1-50, default 5)." },
      },
    },
    output: { schema: OK_OUTPUT, render: textOut },
    execute: async (args) => {
      const errors = checkObject(args, ["log_limit"]);
      if (errors.length > 0) throw new Error(`plan_get: ${errors.join("; ")}`);
      if (args.log_limit !== undefined && (!Number.isInteger(args.log_limit) || args.log_limit < 1 || args.log_limit > 50)) {
        throw new Error("plan_get: log_limit must be an integer between 1 and 50");
      }
      const state = await controller.read();
      const view = await controller.view({ logTail: args.log_limit ?? 5 });
      const lines = [await controller.summary()];
      if (view.log.length > 0) {
        lines.push("", "Recent mutations (newest last):");
        for (const e of view.log) lines.push(`  #${e.seq} ${e.at} ${e.actor} ${e.op} ${e.taskId}`.trimEnd() + ` — ${e.summary}`);
      }
      return {
        ok: true,
        text: lines.join("\n"),
        current_task_id: state.currentTaskId ?? "",
        tasks: view.stats.total,
      };
    },
    presentCall: () => ({ card: "generic", title: "Master Plan · read", kind: "read" }),
  });

  ctx.tools.register({
    name: "plan_project",
    description:
      "Set or rename the Master Plan's Project. Call it once when a project's plan is first created, and again only if the project is genuinely renamed.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string", description: "Project name (<=120 characters)." } },
      required: ["name"],
    },
    output: { schema: OK_OUTPUT, render: textOut },
    execute: async (args) => {
      const errors = [...checkObject(args, ["name"]), ...checkString(args.name, "name", { required: true, max: LIMITS.name })];
      if (errors.length > 0) throw new Error(`plan_project: ${errors.join("; ")}`);
      const result = await controller.setProject({ name: args.name }, { actor: "agent" });
      if (!result.ok) throw new Error(`plan_project: ${result.error}`);
      return snapshot(controller);
    },
    presentCall: (args) => ({ card: "generic", title: `Master Plan · project "${args?.name ?? ""}"`, kind: "execute" }),
  });

  ctx.tools.register({
    name: "plan_task",
    description:
      "Create, change or delete one task in the persistent Master Plan tree.\n" +
      "- action=add: new task. `title` required; `id` optional (auto t1, t2, …); `parent` nests it; `deps` lists prerequisites.\n" +
      "- action=update: change only the fields you pass — title, parent (re-nest), status, deps, blocked_reason, note.\n" +
      "- action=remove: delete a task; its children are lifted to its parent and dependency edges to it are dropped.\n" +
      "Use this proactively: mark work done the moment it is verified, add work the moment it is discovered, add children when a task needs splitting, and record dependencies and blockers as they appear. status=blocked requires blocked_reason.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: PLAN_TASK_ACTIONS, description: "add | update | remove" },
        id: { type: "string", description: "Task id (^[A-Za-z0-9_.:-]{1,64}$). Required for update/remove; optional for add." },
        title: { type: "string", description: "Task title (<=200 characters)." },
        parent: { type: "string", description: "Parent task id; empty string means a root task." },
        status: { type: "string", enum: STATUSES, description: "pending | active | done | blocked" },
        deps: { type: "array", items: { type: "string" }, description: "Task ids this task depends on. Replaces the existing list." },
        blocked_reason: { type: "string", description: `Why the task is blocked (<=${LIMITS.blockedReason} chars). Required when status=blocked.` },
        note: { type: "string", description: `Detail: acceptance criteria, findings, split rationale (<=${LIMITS.note} chars).` },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ...OK_OUTPUT.properties, id: { type: "string" } },
        required: ["ok", "text"],
      },
      render: textOut,
    },
    execute: async (args) => {
      const errors = validateTaskArgs(args);
      if (errors.length > 0) throw new Error(`plan_task: ${errors.join("; ")}`);
      const input = {
        id: args.id,
        title: args.title,
        parent: args.parent,
        status: args.status,
        deps: args.deps,
        blockedReason: args.blocked_reason,
        note: args.note,
      };
      const context = { actor: "agent" };
      const result =
        args.action === "add"
          ? await controller.addTask(input, context)
          : args.action === "update"
            ? await controller.updateTask(input, context)
            : await controller.removeTask(input, context);
      if (!result.ok) throw new Error(`plan_task: ${result.error}`);
      return { ...(await snapshot(controller)), ...(result.id === undefined ? {} : { id: result.id }) };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Master Plan · ${args?.action ?? "task"}${args?.id === undefined ? "" : ` ${args.id}`}`,
      kind: "execute",
      rawInput: args?.title ?? args?.status,
    }),
  });

  ctx.tools.register({
    name: "plan_current",
    description:
      "Point the Master Plan at the single Current Task (the work in progress), or clear it with an empty string. Setting it also activates a pending or blocked task. Marking the current task done clears it automatically.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", description: "Task id to make current; empty string clears it." } },
      required: ["id"],
    },
    output: { schema: OK_OUTPUT, render: textOut },
    execute: async (args) => {
      const errors = [...checkObject(args, ["id"]), ...checkString(args.id, "id", { required: true, max: 64 })];
      if (errors.length > 0) throw new Error(`plan_current: ${errors.join("; ")}`);
      const result = await controller.setCurrent({ id: args.id }, { actor: "agent" });
      if (!result.ok) throw new Error(`plan_current: ${result.error}`);
      return snapshot(controller);
    },
    presentCall: (args) => ({ card: "generic", title: `Master Plan · current ${args?.id === "" ? "(clear)" : args?.id ?? ""}`, kind: "execute" }),
  });

  ctx.tools.register({
    name: "plan_log",
    description:
      "Read the Master Plan's Mutation Log — an append-only record of who changed what and when. Use it to see how the plan evolved (including changes made in other conversations) before making large edits.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { limit: { type: "integer", description: "How many entries to return (1-200, default 20)." } },
    },
    output: { schema: OK_OUTPUT, render: textOut },
    execute: async (args) => {
      const errors = checkObject(args, ["limit"]);
      if (errors.length > 0) throw new Error(`plan_log: ${errors.join("; ")}`);
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > LIMITS.log)) {
        throw new Error(`plan_log: limit must be an integer between 1 and ${LIMITS.log}`);
      }
      const entries = await controller.log(args.limit ?? 20);
      const text =
        entries.length === 0
          ? "Mutation Log is empty."
          : entries.map((e) => `#${e.seq} ${e.at} ${e.actor} ${e.op} ${e.taskId}`.trimEnd() + ` — ${e.summary}`).join("\n");
      const state = await controller.read();
      const view = await controller.view({ logTail: 0 });
      return { ok: true, text, current_task_id: state.currentTaskId ?? "", tasks: view.stats.total };
    },
    presentCall: () => ({ card: "generic", title: "Master Plan · mutation log", kind: "read" }),
  });
}

/* Exported for tests and for any future transport that wants the same logic. */
export { createController } from "./controller.js";
export { createStore, defaultRoot } from "./store.js";
export * as state from "./state.js";
