/**
 * @local/dsh-master-plan — STATE.
 *
 * The single source of truth for a long-lived Master Plan: one Project, a
 * hierarchical Task tree, per-Task Status, one Current Task, Dependency edges,
 * an optional Blocker per Task, and an append-only Mutation Log.
 *
 * This module is pure: no filesystem, no clock reads, no globals. Every
 * mutation takes `(state, input, env)` and returns either
 * `{ ok: true, state, ... }` with a NEW state object, or `{ ok: false, error }`.
 * Persistence lives in `store.js`; orchestration lives in `controller.js`.
 */

/** Allowed Task statuses. `blocked` is the Blocker-representing status. */
export const STATUSES = ["pending", "active", "done", "blocked"];

/** Task / project id shape. Deliberately URL- and log-friendly. */
export const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

export const LIMITS = Object.freeze({
  title: 200,
  note: 1000,
  blockedReason: 400,
  name: 120,
  log: 200,
  tasks: 500,
});

/** Current state schema version; bumped only by a breaking model change. */
export const STATE_VERSION = 1;

/* ── small helpers ─────────────────────────────────────────────────────── */

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Collapse whitespace and clip to `max` code units. Non-strings become "". */
export function clip(v, max) {
  if (typeof v !== "string") return "";
  const t = v.replace(/\s+/gu, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** First `t<N>` not already taken, starting from `from`. */
function nextFreeId(tasks, from) {
  let n = Number.isInteger(from) && from > 0 ? from : 1;
  while (Object.hasOwn(tasks, `t${n}`)) n += 1;
  return n;
}

/** Clock indirection so tests are deterministic. */
function nowOf(env) {
  const at = env?.now?.() ?? new Date().toISOString();
  return typeof at === "string" ? at : new Date(at).toISOString();
}

/* ── shape ─────────────────────────────────────────────────────────────── */

/** A brand-new, empty Master Plan. */
export function initialState(env) {
  const at = nowOf(env);
  return {
    version: STATE_VERSION,
    seq: 0,
    nextId: 1,
    project: null,
    tasks: {},
    order: [],
    currentTaskId: "",
    mutationLog: [],
    createdAt: at,
    updatedAt: at,
  };
}

function taskOrder(state) {
  const seen = new Set();
  const out = [];
  for (const id of state.order) {
    if (Object.hasOwn(state.tasks, id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  // Self-heal: a task present in `tasks` but missing from `order`.
  for (const id of Object.keys(state.tasks)) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * Defensive load: coerce arbitrary persisted JSON into a valid state.
 * Never throws — a corrupt file degrades to whatever is salvageable.
 */
export function normalizeState(raw, env) {
  const base = initialState(env);
  if (!isRecord(raw)) return base;

  const tasks = {};
  const order = [];
  const source = isRecord(raw.tasks) ? raw.tasks : {};
  for (const id of taskOrder({ order: Array.isArray(raw.order) ? raw.order : [], tasks: source })) {
    const t = source[id];
    if (!isRecord(t)) continue;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) continue;
    const status = STATUSES.includes(t.status) ? t.status : "pending";
    tasks[id] = {
      id,
      parentId: typeof t.parentId === "string" && ID_PATTERN.test(t.parentId) ? t.parentId : "",
      title: clip(t.title, LIMITS.title),
      status,
      deps: Array.isArray(t.deps) ? [...new Set(t.deps.filter((d) => typeof d === "string" && ID_PATTERN.test(d) && d !== id))] : [],
      blockedReason: clip(t.blockedReason, LIMITS.blockedReason),
      note: clip(t.note, LIMITS.note),
      createdAt: typeof t.createdAt === "string" ? t.createdAt : base.createdAt,
      updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : base.createdAt,
      doneAt: typeof t.doneAt === "string" ? t.doneAt : "",
    };
    order.push(id);
  }

  // Drop dangling parent pointers and dependency edges, and break parent cycles.
  for (const id of order) {
    const t = tasks[id];
    if (t.parentId !== "" && !Object.hasOwn(tasks, t.parentId)) t.parentId = "";
    if (t.parentId !== "" && reachesParentCycle(tasks, id)) t.parentId = "";
    t.deps = t.deps.filter((d) => Object.hasOwn(tasks, d));
  }

  const project = isRecord(raw.project) && typeof raw.project.name === "string" && raw.project.name.trim() !== ""
    ? {
        id: typeof raw.project.id === "string" && ID_PATTERN.test(raw.project.id) ? raw.project.id : "project",
        name: clip(raw.project.name, LIMITS.name),
        createdAt: typeof raw.project.createdAt === "string" ? raw.project.createdAt : base.createdAt,
        updatedAt: typeof raw.project.updatedAt === "string" ? raw.project.updatedAt : base.createdAt,
      }
    : null;

  const currentTaskId = typeof raw.currentTaskId === "string" && Object.hasOwn(tasks, raw.currentTaskId) ? raw.currentTaskId : "";

  const mutationLog = Array.isArray(raw.mutationLog)
    ? raw.mutationLog
        .filter(isRecord)
        .slice(-LIMITS.log)
        .map((e, i) => ({
          seq: Number.isInteger(e.seq) ? e.seq : i + 1,
          at: typeof e.at === "string" ? e.at : base.createdAt,
          actor: typeof e.actor === "string" ? e.actor : "agent",
          op: typeof e.op === "string" ? e.op : "unknown",
          taskId: typeof e.taskId === "string" ? e.taskId : "",
          summary: clip(e.summary, LIMITS.title),
        }))
    : [];

  const maxSeq = mutationLog.reduce((m, e) => Math.max(m, e.seq), 0);
  const nextId = Number.isInteger(raw.nextId) && raw.nextId > 0 ? raw.nextId : order.length + 1;

  return {
    version: STATE_VERSION,
    seq: Number.isInteger(raw.seq) ? Math.max(raw.seq, maxSeq) : maxSeq,
    nextId,
    project,
    tasks,
    order,
    currentTaskId,
    mutationLog,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.createdAt,
  };
}

/** Follow `id`'s parent chain; true when it loops back onto itself. */
function reachesParentCycle(tasks, id) {
  const seen = new Set([id]);
  let cur = tasks[id]?.parentId ?? "";
  while (cur !== "") {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = tasks[cur]?.parentId ?? "";
  }
  return false;
}

/** Would making `child` a child of `parent` create a cycle? */
function wouldCycle(tasks, child, parent) {
  let cur = parent;
  const seen = new Set([child]);
  while (cur !== "") {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = tasks[cur]?.parentId ?? "";
  }
  return false;
}

/** Would `from` depending on `to` create a dependency cycle? */
function wouldDepCycle(tasks, from, to) {
  if (from === to) return true;
  const seen = new Set([from]);
  const stack = [to];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (seen.has(cur)) return true;
    seen.add(cur);
    const t = tasks[cur];
    if (t === undefined) continue;
    for (const d of t.deps) stack.push(d);
  }
  return false;
}

/* ── log ───────────────────────────────────────────────────────────────── */

function withLog(state, { actor, op, taskId, summary }, env) {
  const seq = state.seq + 1;
  const entry = { seq, at: nowOf(env), actor, op, taskId: taskId ?? "", summary: clip(summary, LIMITS.title) };
  const mutationLog = [...state.mutationLog, entry];
  return {
    ...state,
    seq,
    mutationLog: mutationLog.length > LIMITS.log ? mutationLog.slice(-LIMITS.log) : mutationLog,
    updatedAt: entry.at,
  };
}

/* ── mutations ─────────────────────────────────────────────────────────── */

/**
 * Create the Project, or rename the existing one. The Project is optional until
 * first set, so a plan can start from a bare task list.
 */
export function setProject(state, input, env) {
  const name = clip(input?.name, LIMITS.name);
  if (name === "") return { ok: false, error: "name must be a non-empty string" };
  const at = nowOf(env);
  const existed = state.project !== null;
  const project = existed
    ? { ...state.project, name, updatedAt: at }
    : { id: "project", name, createdAt: at, updatedAt: at };
  const next = withLog({ ...state, project }, {
    actor: input?.actor,
    op: existed ? "project.rename" : "project.create",
    summary: `${existed ? "renamed" : "created"} project "${name}"`,
  }, env);
  return { ok: true, state: next };
}

/**
 * Add a Task. `id` is optional — when omitted the state's `nextId` counter
 * assigns a stable `t1`, `t2`, … so the caller never has to invent a unique id.
 */
export function addTask(state, input, env) {
  const title = clip(input?.title, LIMITS.title);
  if (title === "") return { ok: false, error: "title must be a non-empty string" };

  const requested = input?.id;
  if (requested !== undefined && (typeof requested !== "string" || !ID_PATTERN.test(requested))) {
    return { ok: false, error: "id must match ^[A-Za-z0-9_.:-]{1,64}$" };
  }
  const id = requested ?? `t${state.nextId}`;
  if (Object.hasOwn(state.tasks, id)) return { ok: false, error: `task "${id}" already exists` };
  if (taskOrder(state).length >= LIMITS.tasks) return { ok: false, error: `plan is full (max ${LIMITS.tasks} tasks)` };

  const parentId = input?.parent === undefined || input.parent === null ? "" : input.parent;
  if (typeof parentId !== "string") return { ok: false, error: "parent must be a string" };
  if (parentId !== "" && !Object.hasOwn(state.tasks, parentId)) return { ok: false, error: `parent "${parentId}" does not exist` };

  const status = STATUSES.includes(input?.status) ? input.status : "pending";
  const deps = normalizeDeps(state, input?.deps, id);
  if (deps.error !== undefined) return { ok: false, error: deps.error };

  const at = nowOf(env);
  // Invariant: a task is blocked exactly when it carries a blocker reason.
  const blockedReason = clip(input?.blockedReason, LIMITS.blockedReason);
  if (status === "blocked" && blockedReason === "") {
    return { ok: false, error: "status blocked requires blockedReason" };
  }
  const task = {
    id,
    parentId,
    title,
    status,
    deps: deps.value,
    blockedReason: status === "blocked" ? blockedReason : "",
    note: clip(input?.note, LIMITS.note),
    createdAt: at,
    updatedAt: at,
    doneAt: status === "done" ? at : "",
  };

  const withTask = {
    ...state,
    tasks: { ...state.tasks, [id]: task },
    order: [...taskOrder(state), id],
    nextId: nextFreeId({ ...state.tasks, [id]: task }, state.nextId),
  };
  const next = withLog(withTask, {
    actor: input?.actor,
    op: "task.add",
    taskId: id,
    summary: `added "${title}"${parentId === "" ? "" : ` under ${parentId}`}`,
  }, env);
  return { ok: true, state: next, id };
}

/**
 * Update a Task: title, parent, status, dependencies, blocker reason, note.
 * Only supplied fields change. Marking `done` (re)stamps `doneAt`; a `blocked`
 * status keeps its reason, and clearing `blocked` clears the reason.
 */
export function updateTask(state, input, env) {
  const id = input?.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return { ok: false, error: "id must match ^[A-Za-z0-9_.:-]{1,64}$" };
  const prev = state.tasks[id];
  if (prev === undefined) return { ok: false, error: `task "${id}" does not exist` };

  const patch = {};

  if (input.title !== undefined) {
    const title = clip(input.title, LIMITS.title);
    if (title === "") return { ok: false, error: "title cannot be empty" };
    patch.title = title;
  }

  if (input.parent !== undefined) {
    const parentId = input.parent === null ? "" : input.parent;
    if (typeof parentId !== "string") return { ok: false, error: "parent must be a string" };
    if (parentId !== "" && !Object.hasOwn(state.tasks, parentId)) return { ok: false, error: `parent "${parentId}" does not exist` };
    if (parentId === id) return { ok: false, error: "a task cannot be its own parent" };
    if (parentId !== "" && wouldCycle(state.tasks, id, parentId)) return { ok: false, error: "reparenting would create a cycle" };
    patch.parentId = parentId;
  }

  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) return { ok: false, error: `status must be one of ${STATUSES.join("|")}` };
    patch.status = input.status;
  }

  if (input.deps !== undefined) {
    const deps = normalizeDeps(state, input.deps, id);
    if (deps.error !== undefined) return { ok: false, error: deps.error };
    for (const dep of deps.value) {
      if (wouldDepCycle(state.tasks, id, dep)) return { ok: false, error: `depending on "${dep}" would create a dependency cycle` };
    }
    patch.deps = deps.value;
  }

  if (input.blockedReason !== undefined) patch.blockedReason = clip(input.blockedReason, LIMITS.blockedReason);
  if (input.note !== undefined) patch.note = clip(input.note, LIMITS.note);

  const at = nowOf(env);
  const status = patch.status ?? prev.status;
  if (patch.status !== undefined) patch.doneAt = status === "done" ? at : "";
  // A task that is no longer blocked must not keep a stale blocker reason.
  if (status !== "blocked" && patch.blockedReason === undefined) patch.blockedReason = "";
  if (status === "blocked" && (patch.blockedReason ?? prev.blockedReason) === "") {
    return { ok: false, error: "status blocked requires blockedReason" };
  }

  const next = { ...prev, ...patch, updatedAt: at };
  const changed = describeChange(prev, next);

  let withTask = { ...state, tasks: { ...state.tasks, [id]: next } };
  // A done task is no longer the work in progress.
  if (next.status === "done" && withTask.currentTaskId === id) withTask = { ...withTask, currentTaskId: "" };
  // Setting a task active makes it the current task; it cannot be current and blocked.
  if (next.status === "active" && withTask.currentTaskId === "") withTask = { ...withTask, currentTaskId: id };

  const logged = withLog(withTask, { actor: input?.actor, op: "task.update", taskId: id, summary: changed }, env);
  return { ok: true, state: logged, changed };
}

/** Human-readable one-liner for the Mutation Log. */
function describeChange(prev, next) {
  const parts = [];
  if (prev.title !== next.title) parts.push(`title "${next.title}"`);
  if (prev.parentId !== next.parentId) parts.push(next.parentId === "" ? "moved to root" : `moved under ${next.parentId}`);
  if (prev.status !== next.status) parts.push(`${prev.status} → ${next.status}`);
  if (prev.deps.join(",") !== next.deps.join(",")) parts.push(next.deps.length === 0 ? "deps cleared" : `deps [${next.deps.join(", ")}]`);
  if (prev.blockedReason !== next.blockedReason) parts.push(next.blockedReason === "" ? "unblocked" : `blocked: ${next.blockedReason}`);
  if (prev.note !== next.note) parts.push("note updated");
  return parts.length === 0 ? "no-op" : parts.join("; ");
}

/**
 * Remove a Task. Children are lifted to the removed Task's parent so no work
 * item is orphaned, and every dependency edge pointing at it is dropped.
 */
export function removeTask(state, input, env) {
  const id = input?.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return { ok: false, error: "id must match ^[A-Za-z0-9_.:-]{1,64}$" };
  const victim = state.tasks[id];
  if (victim === undefined) return { ok: false, error: `task "${id}" does not exist` };

  const tasks = { ...state.tasks };
  delete tasks[id];
  const lifted = [];
  for (const [cid, c] of Object.entries(tasks)) {
    const nextDeps = c.deps.filter((d) => d !== id);
    const isChild = c.parentId === id;
    if (isChild) lifted.push(cid);
    if (isChild || nextDeps.length !== c.deps.length) {
      tasks[cid] = { ...c, parentId: isChild ? victim.parentId : c.parentId, deps: nextDeps };
    }
  }

  const withRemoval = {
    ...state,
    tasks,
    order: taskOrder(state).filter((x) => x !== id),
    currentTaskId: state.currentTaskId === id ? "" : state.currentTaskId,
  };
  const next = withLog(withRemoval, {
    actor: input?.actor,
    op: "task.remove",
    taskId: id,
    summary: `removed "${victim.title}"${lifted.length > 0 ? ` (lifted ${lifted.length} child${lifted.length === 1 ? "" : "ren"})` : ""}`,
  }, env);
  return { ok: true, state: next, lifted };
}

/**
 * Set the Current Task (the single work-in-progress pointer). Passing an empty
 * string clears it. Setting a task active-promotes it unless it is done.
 */
export function setCurrent(state, input, env) {
  const raw = input?.id;
  const id = raw === undefined || raw === null ? "" : raw;
  if (typeof id !== "string") return { ok: false, error: "id must be a string (empty clears the current task)" };
  if (id !== "" && !Object.hasOwn(state.tasks, id)) return { ok: false, error: `task "${id}" does not exist` };
  if (id !== "" && state.tasks[id].status === "done") return { ok: false, error: `task "${id}" is done; reopen it before making it current` };

  const at = nowOf(env);
  const tasks = { ...state.tasks };
  if (id !== "" && tasks[id].status !== "active") {
    // Promoting a blocked task to the work in progress clears its blocker.
    tasks[id] = { ...tasks[id], status: "active", blockedReason: "", updatedAt: at };
  }
  const next = withLog({ ...state, tasks, currentTaskId: id }, {
    actor: input?.actor,
    op: "current.set",
    taskId: id,
    summary: id === "" ? "cleared current task" : `current task → ${id} "${tasks[id].title}"`,
  }, env);
  return { ok: true, state: next };
}

/** Validate and canonicalize a dependency list. */
function normalizeDeps(state, raw, selfId) {
  if (raw === undefined || raw === null) return { value: [] };
  if (!Array.isArray(raw)) return { error: "deps must be an array of task ids" };
  const out = [];
  for (const d of raw) {
    if (typeof d !== "string" || !ID_PATTERN.test(d)) return { error: "each dep must be a task id" };
    if (d === selfId) return { error: "a task cannot depend on itself" };
    if (!Object.hasOwn(state.tasks, d)) return { error: `dependency "${d}" does not exist` };
    if (!out.includes(d)) out.push(d);
  }
  return { value: out };
}

/* ── derived / read models ─────────────────────────────────────────────── */

const isDone = (t) => t.status === "done";

/**
 * Build the presentation view model.
 *
 * The View is deliberately given a fully-resolved, nested structure so it
 * contains no plan logic of its own — depth, ordering, dependency resolution
 * and readiness are all decided here, in the State layer.
 */
export function buildViewModel(state, options = {}) {
  const order = taskOrder(state);
  const byParent = new Map();
  for (const id of order) {
    const t = state.tasks[id];
    const key = t.parentId !== "" && Object.hasOwn(state.tasks, t.parentId) ? t.parentId : "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(id);
  }

  const decorate = (id, depth, seen) => {
    if (seen.has(id)) return null; // cycle guard; normalizeState already breaks these
    seen.add(id);
    const t = state.tasks[id];
    const deps = t.deps
      .filter((d) => Object.hasOwn(state.tasks, d))
      .map((d) => ({ id: d, title: state.tasks[d].title, status: state.tasks[d].status }));
    const blockers = deps.filter((d) => !isDone(state.tasks[d.id]));
    const children = (byParent.get(id) ?? []).map((c) => decorate(c, depth + 1, seen)).filter((n) => n !== null);
    seen.delete(id);
    return {
      id,
      title: t.title,
      status: t.status,
      note: t.note,
      blockedReason: t.blockedReason,
      depth,
      deps,
      blockedByDeps: blockers,
      readyForWork: t.status !== "done" && blockers.length === 0,
      isCurrent: state.currentTaskId === id,
      updatedAt: t.updatedAt,
      children,
    };
  };

  const seen = new Set();
  const roots = (byParent.get("") ?? []).map((id) => decorate(id, 0, seen)).filter((n) => n !== null);

  const stats = { total: 0, pending: 0, active: 0, done: 0, blocked: 0 };
  for (const id of order) {
    stats.total += 1;
    stats[state.tasks[id].status] += 1;
  }

  return {
    version: state.version,
    project: state.project === null ? null : { id: state.project.id, name: state.project.name },
    currentTaskId: state.currentTaskId,
    currentTask: state.currentTaskId === "" ? null : { id: state.currentTaskId, title: state.tasks[state.currentTaskId]?.title ?? "" },
    stats,
    roots,
    updatedAt: state.updatedAt,
    seq: state.seq,
    log: state.mutationLog.slice(-(Number.isInteger(options.logTail) ? options.logTail : 8)),
  };
}

/** Flat, in-order task list (depth-first) — used by the text summary. */
export function flatten(state) {
  const out = [];
  const order = taskOrder(state);
  const byParent = new Map();
  for (const id of order) {
    const t = state.tasks[id];
    const key = t.parentId !== "" && Object.hasOwn(state.tasks, t.parentId) ? t.parentId : "";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(id);
  }
  const walk = (key, depth, seen) => {
    for (const id of byParent.get(key) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...state.tasks[id], depth });
      walk(id, depth + 1, seen);
    }
  };
  walk("", 0, new Set());
  return out;
}

const MARK = { pending: "[ ]", active: "[~]", done: "[x]", blocked: "[!]" };

/**
 * Compact ASCII rendering of the whole plan. This is what the model reads, so
 * it is deliberately dense: one line per task, dependencies and blockers inline.
 */
export function summarize(state, options = {}) {
  const vm = buildViewModel(state, options);
  const lines = [];
  lines.push(`Project: ${vm.project === null ? "(unset)" : vm.project.name}`);
  lines.push(
    `Tasks: ${vm.stats.total} total · ${vm.stats.pending} pending · ${vm.stats.active} active · ${vm.stats.done} done · ${vm.stats.blocked} blocked`,
  );
  lines.push(`Current: ${vm.currentTask === null ? "(none)" : `${vm.currentTask.id} "${vm.currentTask.title}"`}`);

  const flat = flatten(state);
  if (flat.length === 0) {
    lines.push("Tree: (empty — add tasks with plan_task action=add)");
  } else {
    lines.push("Tree:");
    for (const t of flat) {
      const bits = [`${"  ".repeat(t.depth + 1)}${MARK[t.status] ?? "[ ]"} ${t.id} · ${t.title}`];
      if (t.status === "blocked" && t.blockedReason !== "") bits.push(`   blocked: ${t.blockedReason}`);
      if (t.deps.length > 0) bits.push(`   deps: ${t.deps.join(", ")}`);
      if (state.currentTaskId === t.id) bits.push("   ← CURRENT");
      lines.push(bits.join(""));
      if (t.note !== "") lines.push(`${"  ".repeat(t.depth + 2)}note: ${t.note}`);
    }
  }
  return lines.join("\n");
}
