/**
 * @local/dsh-plan-map — 主机侧：**用户的计划树**（不是 AI 的思考流水）。
 *
 * 模型：
 *  - 树 = 用户给出/批准的计划内容，层级由用户（或从计划解析）决定：
 *      做游戏 ├ 策划案 ├ 构思 / 成型
 *             ├ 写代码
 *             └ 测试游戏
 *  - 状态 = 在执行中自动前进：官方 todo 列表里同名条目的状态会**自动**推进
 *    对应节点的状态（只前进不回退），模型也可以显式标记（blocked 优先显示）。
 *  - 明确不做的事：不把 chain_note（AI 思考步骤）、工具调用流水塞进这棵树。
 *
 * 数据来源：
 *  - `plan_import` 工具：一次调用把整份计划（缩进大纲 / markdown）登记成树；
 *  - `plan_node` 工具：增量维护（加节点 / 标记状态 / 改标题 / 删节点）；
 *  - `tool/call(exit_plan_mode)`：批准的计划 markdown 自动解析成树；
 *  - `todo/write`：官方待办列表 → 只用于**状态同步**（`includeTodos: true` 时才额外画出来）。
 *
 * 零依赖；纯函数导出供测试。
 */

import { isTaskCard, parseImport as parseImportText } from "./card.js";

export const name = "@local/dsh-plan-map";
// ⚠️ inject 必须列全 apply 里访问的**每一个** ctx 服务：cordis 的 ctx 代理对未声明的
// 服务访问会直接抛 `cannot get property "x" without inject`，而插件 apply 抛错会让
// **整个插件树加载失败**（DSH 起不来）。`systemPrompt` 在 2026-09-24 漏过一次：
// guidance 默认为 true，于是每次启动都会走到 `ctx.systemPrompt.section(...)` 而炸掉。
export const inject = ["tools", "systemPrompt", "sessionProjections"];

const ACTIONS = ["add", "update", "remove", "clear"];
const STATUSES = ["pending", "active", "done", "blocked"];
const IMPORT_MODES = ["replace", "append"];
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const MAX_TITLE = 120;
const MAX_NOTE = 600;
const MAX_TODOS = 50;
const MAX_IMPORT_NODES = 200;
/** 状态只前进：pending < active < done（blocked 为显式标记，单独优先）。 */
const STATUS_RANK = { pending: 0, active: 1, done: 2 };
/** 官方 todo 工具状态 → 计划节点状态。 */
const TODO_STATUS = { pending: "pending", in_progress: "active", completed: "done" };
const TODO_PREFIX = "todo:";
const TODO_ROOT = "todo:root";
const TODO_ROOT_TITLE = "任务清单";

/* ── 纯逻辑（测试 import） ─────────────────────────────────────────────── */

export function clip(v, max) {
  if (typeof v !== "string") return "";
  const t = v.replace(/\r?\n/gu, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export function firstHeading(markdown) {
  if (typeof markdown !== "string") return undefined;
  for (const line of markdown.split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*$/u.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** 标题归一化：供「按标题定位节点」与「todo 自动同步」匹配用。 */
export function normalizeTitle(text) {
  return String(text ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * 解析计划文本 → 节点数组（父在前）。
 * 接受三种写法，可混用：
 *   - 缩进大纲：每行一个节点，缩进 2 空格一层
 *   - markdown 列表：`-`/`*`/`1.` 加缩进
 *   - markdown 标题：`#`/`##`/`###` 层级（其下的列表项/缩进行作为子节点）
 * @returns [{id, parent, title, status, note}]，id 为 p1..pN
 */
/**
 * 导入解析的统一入口：任务卡（`# 任务：` + `## 子任务拆分` 表）走任务卡映射，
 * 其余仍按大纲解析。`plan_import` 的 execute 与投影回放**必须**都走这里，
 * 否则同一次导入在两处会得到不同的树（重启后树会变样）。
 * @param text - 大纲 / markdown / 任务卡。
 * @param options - 与 `parseOutline` 相同。
 */
export function parseImport(text, options = {}) {
  return parseImportText(text, options, parseOutline);
}

export function parseOutline(text, options = {}) {
  const maxNodes = Number.isInteger(options.maxNodes) ? options.maxNodes : MAX_IMPORT_NODES;
  const indentUnit = Number.isInteger(options.indentUnit) && options.indentUnit > 0 ? options.indentUnit : 2;
  const nodes = [];
  const stack = [];
  let headingBase = 0;
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    if (rawLine.trim() === "") continue;
    if (nodes.length >= maxNodes) break;
    const indent = /^[ \t]*/u.exec(rawLine)[0].replace(/\t/gu, "  ").length;
    let line = rawLine.trim();
    let depth;
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      depth = heading[1].length;
      headingBase = depth;
      line = heading[2];
    } else {
      const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/u.exec(line);
      if (bullet !== null) line = bullet[1];
      depth = headingBase + 1 + Math.floor(indent / indentUnit);
    }
    const title = clip(line.replace(/[*_`]/gu, ""), MAX_TITLE);
    if (title === "") continue;
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const id = `p${nodes.length + 1}`;
    nodes.push({ id, parent: stack.length > 0 ? stack[stack.length - 1].id : "", title, status: "pending", note: "" });
    stack.push({ depth, id });
  }
  return nodes;
}

/** 在计划节点里按 id 或标题定位；返回节点 id 或 undefined。 */
export function resolveNode(state, ref) {
  if (typeof ref !== "string" || ref === "") return undefined;
  if (Object.hasOwn(state.nodes, ref)) return ref;
  const key = normalizeTitle(ref);
  if (key === "") return undefined;
  const hits = Object.keys(state.nodes).filter((id) => normalizeTitle(state.nodes[id].title) === key);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * 当前待办列表里与某标题对应的条目（精确 key 优先，其次包含匹配取最长）。
 * 归一化后短于 2 字的标题不参与匹配（避免「A」匹配到一切）。
 */
export function matchTodo(title, todos) {
  const key = normalizeTitle(title);
  if (key.length < 2) return undefined;
  let best;
  let bestLength = -1;
  for (const todo of todos ?? []) {
    const other = normalizeTitle(todo?.content);
    if (other === "") continue;
    const hit = other === key || (key.length >= 3 && other.includes(key)) || (other.length >= 3 && key.includes(other));
    if (hit && other.length > bestLength) {
      best = todo;
      bestLength = other.length;
    }
  }
  return best;
}

/**
 * 节点状态 = **谁后写谁说了算**（可前进也可回退）：
 *  - 显式标记（plan_node 带 status）会记下它的 seq；
 *  - 待办列表更新（todo/write）也记 seq；
 *  - 两者取更新的一方：待办更新更晚 → 跟随待办状态；显式标记更晚 → 用显式状态。
 * 这样 AI 干完能自动变绿，发现做错了再标回去也能**回退**。
 */
export function effectiveStatus(node, todos, todoSeq) {
  const todo = matchTodo(node?.title, todos);
  const explicitSeq = Number.isInteger(node?.statusSeq) ? node.statusSeq : 0;
  if (todo !== undefined && (Number.isInteger(todoSeq) ? todoSeq : 0) > explicitSeq) {
    return TODO_STATUS[todo.status] ?? node.status;
  }
  return node.status;
}

export function initialTreeState() {
  return { nodes: {}, order: [], planMode: false, todos: [], todoSeq: 0, updatedSeq: 0 };
}

/** 校验并应用一条 plan_node 意图；返回 {ok:true,state} 或 {ok:false,error}。 */
export function applyPlanNode(state, data, limits = {}) {
  const maxNodes = Number.isInteger(limits.maxNodes) ? limits.maxNodes : MAX_IMPORT_NODES;
  const s = state ?? initialTreeState();
  const action = data?.action;
  if (!ACTIONS.includes(action)) return { ok: false, error: `action must be one of ${ACTIONS.join("|")}` };
  if (action === "clear") return { ok: true, state: { ...s, nodes: {}, order: [] } };

  const addId = data?.id;
  if (action === "add") {
    if (typeof addId !== "string" || !ID_PATTERN.test(addId)) return { ok: false, error: "add requires id matching ^[A-Za-z0-9_.:-]{1,64}$" };
    if (Object.hasOwn(s.nodes, addId)) return { ok: false, error: `node "${addId}" already exists` };
    const title = clip(data.title, MAX_TITLE);
    if (title === "") return { ok: false, error: "add requires a non-empty title" };
    if (Object.keys(s.nodes).length >= maxNodes) return { ok: false, error: `plan tree is full (max ${maxNodes} nodes)` };
    const rawParent = typeof data.parent === "string" ? data.parent : "";
    const parent = rawParent === "" ? "" : resolveNode(s, rawParent);
    if (rawParent !== "" && parent === undefined) return { ok: false, error: `parent "${rawParent}" does not exist (pass its id or its exact title)` };
    if (parent === addId) return { ok: false, error: "a node cannot be its own parent" };
    const explicit = STATUSES.includes(data.status);
    const node = {
      id: addId,
      parent,
      title,
      status: explicit ? data.status : "pending",
      note: clip(data.note, MAX_NOTE),
      statusSeq: explicit && Number.isInteger(limits.seq) ? limits.seq : 0,
    };
    return { ok: true, state: { ...s, nodes: { ...s.nodes, [addId]: node }, order: [...s.order, addId] } };
  }

  // update / remove：id 可以是节点 id，也可以是节点标题（自动补全用起来最顺手）
  const id = resolveNode(s, data?.id);
  if (id === undefined) return { ok: false, error: `node "${String(data?.id)}" does not exist (pass its id or its exact title)` };
  const prev = s.nodes[id];

  if (action === "update") {
    if (data.title !== undefined && clip(data.title, MAX_TITLE) === "") return { ok: false, error: "title cannot be empty" };
    let nextParent = prev.parent;
    if (data.parent !== undefined) {
      const rawParent = data.parent === null ? "" : data.parent;
      if (typeof rawParent !== "string") return { ok: false, error: "parent must be a string" };
      nextParent = rawParent === "" ? "" : resolveNode(s, rawParent);
      if (rawParent !== "" && nextParent === undefined) return { ok: false, error: `parent "${rawParent}" does not exist (pass its id or its exact title)` };
      if (nextParent === id) return { ok: false, error: "a node cannot be its own parent" };
      if (nextParent !== "" && createsCycle(s, id, nextParent)) return { ok: false, error: "reparenting would create a cycle" };
    }
    const explicit = STATUSES.includes(data.status);
    const node = {
      ...prev,
      title: data.title === undefined ? prev.title : clip(data.title, MAX_TITLE),
      parent: nextParent,
      status: explicit ? data.status : prev.status,
      note: data.note === undefined ? prev.note : clip(data.note, MAX_NOTE),
      statusSeq: explicit && Number.isInteger(limits.seq) ? limits.seq : prev.statusSeq ?? 0,
    };
    return { ok: true, state: { ...s, nodes: { ...s.nodes, [id]: node } } };
  }

  // remove：子节点上提，避免丢工作项
  const nodes = { ...s.nodes };
  const parent = nodes[id].parent;
  delete nodes[id];
  const reparented = [];
  for (const [cid, child] of Object.entries(nodes)) {
    if (child.parent === id) {
      nodes[cid] = { ...child, parent };
      reparented.push(cid);
    }
  }
  return { ok: true, state: { ...s, nodes, order: s.order.filter((x) => x !== id), reparented } };
}

function createsCycle(state, id, parent) {
  let p = parent;
  const seen = new Set([id]);
  while (p !== "") {
    if (seen.has(p)) return true;
    seen.add(p);
    const node = state.nodes[p];
    if (node === undefined) return false;
    p = node.parent;
  }
  return false;
}

/** 把一批（带 parent 的）节点并入状态；mode=replace 先清空计划节点（保留 todo 派生物）。 */
export function importNodes(state, parsed, mode = "replace", limits = {}) {
  const maxNodes = Number.isInteger(limits.maxNodes) ? limits.maxNodes : MAX_IMPORT_NODES;
  const s = state ?? initialTreeState();
  const keep = mode === "replace" ? { nodes: {}, order: [] } : { nodes: { ...s.nodes }, order: [...s.order] };
  const nodes = keep.nodes;
  const order = keep.order;
  const idMap = new Map();
  let skipped = 0;
  for (const item of parsed) {
    if (Object.keys(nodes).length >= maxNodes) {
      skipped += 1;
      continue;
    }
    const id = `p${order.length + 1}`;
    idMap.set(item.id, id);
    const parent = item.parent === "" ? "" : idMap.get(item.parent) ?? "";
    nodes[id] = {
      id,
      parent,
      title: clip(item.title, MAX_TITLE),
      status: STATUSES.includes(item.status) ? item.status : "pending",
      note: clip(item.note, MAX_NOTE),
      statusSeq: 0,
    };
    order.push(id);
  }
  return { ...s, nodes, order, skipped };
}

/** 折叠一条会话事件。 */
export function foldTree(state, event, limits = {}) {
  const s = state ?? initialTreeState();
  // 主路径：官方 `tool/call`。harness 把模型的工具参数以 **JSON 字符串** 原样写在这里，
  // 所以整棵树都能从官方事件重建——插件不再写 plan/node、plan/import 这类自定义事件
  // （写自定义类型会让宿主读会话日志时整份拒读，见 docs/architecture.md §5.1）。
  // PTC 模式：模型只能直接调 run_code，其内部调用的工具由 harness 记为
  // tool/ptc-dispatch（而非 tool/call）。计划工具必须同样从这类事件折叠，
  // 否则在只暴露 run_code 的会话里计划树永远是空的。
  if (event.type === "tool/call" || event.type === "tool/ptc-dispatch") {
    const toolName = event.data?.name;
    if (toolName === "plan_node") {
      const args = parseCallArgs(event);
      // 与 execute 同判据：参数非法 → 折叠忽略（execute 那边也会抛错）
      if (args === null || validateArgs(PLAN_NODE_PARAMS, args).length > 0) return s;
      const result = applyPlanNode(s, sanitize(args), { ...limits, seq: event.seq });
      return result.ok ? { ...result.state, updatedSeq: event.seq } : s;
    }
    if (toolName === "plan_import") {
      const args = parseCallArgs(event);
      if (args === null || validateArgs(PLAN_IMPORT_PARAMS, args).length > 0) return s;
      const parsed = parseImport(args.outline, limits);
      if (parsed.length === 0) return s; // 空导入是无操作，绝不能清空现有计划
      const mode = IMPORT_MODES.includes(args.mode) ? args.mode : "replace";
      return { ...importNodes(s, parsed, mode, limits), updatedSeq: event.seq };
    }
    // 批准的计划：整份 markdown 解析成树（替换，因为批准的计划就是这份计划）
    if (toolName === "exit_plan_mode") {
      const plan = parseCallArgs(event)?.plan;
      const parsed = parseOutline(plan, limits);
      if (parsed.length === 0) {
        const heading = firstHeading(plan);
        if (heading === undefined) return s;
        parsed.push({ id: "p1", parent: "", title: clip(heading, MAX_TITLE), status: "active", note: "" });
      }
      const noteChars = Number.isInteger(limits.planNoteChars) ? limits.planNoteChars : MAX_NOTE;
      if (noteChars > 0 && parsed.length > 0) parsed[0].note = clip(plan, noteChars);
      return { ...importNodes(s, parsed, "replace", limits), updatedSeq: event.seq };
    }
    return s;
  }
  // 命令通道：客户端拖拽/点击发出的 /planmap 命令，由 harness 以官方 `command/run`
  // 落库（含 name 与 args），投影据此改树——**不写自定义事件**，跨设备/重启都还在。
  if (event.type === "command/run" && event.data?.name === "planmap") {
    const parsed = parsePlanMapCommand(event.data.args);
    if (!parsed.ok || parsed.intent === undefined) return s;
    const result = applyPlanNode(s, parsed.intent, { ...limits, seq: event.seq });
    return result.ok ? { ...result.state, updatedSeq: event.seq } : s;
  }
  // 兼容老日志：0.1.x 自己写的自定义事件（现已停写，历史链路不能丢）
  if (event.type === "plan/node") {
    const result = applyPlanNode(s, event.data, { ...limits, seq: event.seq });
    return result.ok ? { ...result.state, updatedSeq: event.seq } : s;
  }
  if (event.type === "plan/import") {
    const parsed = Array.isArray(event.data?.nodes) ? event.data.nodes : [];
    if (parsed.length === 0) return s; // 空导入是无操作，绝不能清空现有计划
    const mode = IMPORT_MODES.includes(event.data?.mode) ? event.data.mode : "replace";
    return { ...importNodes(s, parsed, mode, limits), updatedSeq: event.seq };
  }
  // 官方 todo 列表：只作为「执行事实」记录，用于自动推进节点状态
  if (event.type === "todo/write") {
    const todos = Array.isArray(event.data?.todos) ? event.data.todos.slice(0, MAX_TODOS) : [];
    return { ...s, todos, todoSeq: event.seq, updatedSeq: event.seq };
  }
  if (event.type === "plan/mode") {
    return { ...s, planMode: event.data?.active === true, updatedSeq: event.seq };
  }
  return s;
}

/**
 * 解析 `tool/call` 里的工具参数：harness 写的是 JSON 字符串（`data.arguments`），
 * 测试/回放里也可能是已解析的对象。拿不到对象时返回 null。
 */
export function parseCallArgs(event) {
  const raw = event?.data?.arguments;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** wire view：扁平节点（层级由客户端算）+ 进度 + 计划模式标志。 */
export function treeView(state, limits = {}) {
  const s = state ?? initialTreeState();
  const todos = Array.isArray(s.todos) ? s.todos : [];
  const ids = (s.order ?? []).filter((id) => Object.hasOwn(s.nodes, id));
  for (const id of Object.keys(s.nodes)) if (!ids.includes(id)) ids.push(id);
  const todoSeq = Number.isInteger(s.todoSeq) ? s.todoSeq : 0;
  const nodes = ids.map((id) => {
    const n = s.nodes[id];
    return {
      id: n.id,
      parent: n.parent,
      title: n.title,
      status: effectiveStatus(n, todos, todoSeq),
      note: n.note,
    };
  });
  const progress = { total: nodes.length, done: nodes.filter((n) => n.status === "done").length, active: nodes.filter((n) => n.status === "active").length };
  if (limits.includeTodos === true && todos.length > 0) {
    nodes.push({ id: TODO_ROOT, parent: "", title: TODO_ROOT_TITLE, status: "active", note: "" });
    todos.forEach((todo, index) => {
      nodes.push({
        id: `${TODO_PREFIX}${index + 1}`,
        parent: TODO_ROOT,
        title: clip(todo?.content, MAX_TITLE),
        status: TODO_STATUS[todo?.status] ?? "pending",
        note: "",
      });
    });
  }
  return { nodes, planMode: s.planMode === true, updatedSeq: s.updatedSeq ?? 0, progress };
}

function normalizeTree(v) {
  const s = initialTreeState();
  if (v === null || typeof v !== "object") return s;
  const nodes = {};
  const order = [];
  for (const [id, raw] of Object.entries(v.nodes ?? {})) {
    if (raw === null || typeof raw !== "object") continue;
    nodes[id] = {
      id: String(id),
      parent: typeof raw.parent === "string" ? raw.parent : "",
      title: typeof raw.title === "string" ? raw.title : "",
      status: STATUSES.includes(raw.status) ? raw.status : "pending",
      note: typeof raw.note === "string" ? raw.note : "",
      statusSeq: Number.isInteger(raw.statusSeq) ? raw.statusSeq : 0,
    };
    order.push(String(id));
  }
  const todos = Array.isArray(v.todos)
    ? v.todos.filter((t) => t !== null && typeof t === "object" && typeof t.content === "string").slice(0, MAX_TODOS).map((t) => ({ content: t.content, status: String(t.status ?? "pending") }))
    : [];
  return {
    nodes,
    order: Array.isArray(v.order) ? v.order.filter((id) => typeof id === "string" && Object.hasOwn(nodes, id)) : order,
    planMode: v.planMode === true,
    todos,
    todoSeq: Number.isInteger(v.todoSeq) ? v.todoSeq : 0,
    updatedSeq: Number.isInteger(v.updatedSeq) ? v.updatedSeq : 0,
  };
}

/** `/planmap` 的动词 → plan_node 意图。命令行/拖拽都走这一条，便于测试与复用。 */
export const PLANMAP_VERBS = ["move", "status", "rename", "add", "rm", "tree"];

/**
 * 解析 `/planmap …`。
 * @param text 命令名之后的原始文本
 * @returns {ok:true, kind, intent?} 或 {ok:false, error}
 */
export function parsePlanMapCommand(text) {
  const raw = String(text ?? "").trim();
  if (raw === "") return { ok: false, error: "用法：/planmap move <节点> <新父节点|-> ｜ status <节点> <pending|active|done|blocked> ｜ rename <节点> <标题> ｜ add <父节点|-> <标题> ｜ rm <节点> ｜ tree" };
  const space = raw.search(/\s/u);
  const verb = (space === -1 ? raw : raw.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : raw.slice(space + 1).trim();
  if (!PLANMAP_VERBS.includes(verb)) return { ok: false, error: `未知子命令「${verb}」（可用：${PLANMAP_VERBS.join(" / ")}）` };
  if (verb === "tree") return { ok: true, kind: "tree" };

  const firstSpace = rest.search(/\s/u);
  const head = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  const tail = firstSpace === -1 ? "" : rest.slice(firstSpace + 1).trim();

  if (verb === "status") {
    const parts = rest.split(/\s+/u).filter((x) => x !== "");
    if (parts.length !== 2) return { ok: false, error: "用法：/planmap status <节点> <pending|active|done|blocked>" };
    if (!STATUSES.includes(parts[1])) return { ok: false, error: `状态只能是 ${STATUSES.join(" / ")}` };
    return { ok: true, kind: "status", intent: { action: "update", id: parts[0], status: parts[1] } };
  }
  if (head === "") return { ok: false, error: `用法：/planmap ${verb} …` };

  if (verb === "move") {
    const parts = rest.split(/\s+/u).filter((x) => x !== "");
    if (parts.length !== 2) return { ok: false, error: "用法：/planmap move <节点> <新父节点|->（`-` 表示移到根）" };
    return { ok: true, kind: "move", intent: { action: "update", id: parts[0], parent: parts[1] === "-" ? null : parts[1] } };
  }
  if (verb === "rename") {
    if (tail === "") return { ok: false, error: "用法：/planmap rename <节点> <新标题>" };
    return { ok: true, kind: "rename", intent: { action: "update", id: head, title: tail } };
  }
  if (verb === "add") {
    if (tail === "") return { ok: false, error: "用法：/planmap add <父节点|-> <标题>" };
    return { ok: true, kind: "add", intent: { action: "add", id: `c${Date.now().toString(36)}`, parent: head === "-" ? "" : head, title: tail } };
  }
  if (verb === "rm") return { ok: true, kind: "rm", intent: { action: "remove", id: head } };
  return { ok: false, error: `未处理的子命令「${verb}」` };
}

/* ── 插件体 ───────────────────────────────────────────────────────────── */

const PLAN_NODE_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ACTIONS, description: "add 新节点 / update 改状态或标题 / remove 删节点（子节点上提）/ clear 清空。" },
    id: { type: "string", description: "节点 id（add 必填，^[A-Za-z0-9_.:-]{1,64}$）；update/remove 时可传节点标题代替 id。" },
    parent: { type: "string", description: "父节点 id；缺省或空字符串表示根。" },
    title: { type: "string", description: "节点标题（add 必填，<=120 字符）。" },
    status: { type: "string", enum: STATUSES, description: "pending/active/done/blocked。" },
    note: { type: "string", description: "可选备注：节点细化内容、验收标准。" },
  },
  required: ["action"],
};

const PLAN_IMPORT_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    outline: { type: "string", description: "计划正文：缩进大纲（每行一个节点，2 空格一层）或 markdown（# 标题 + 缩进列表）。" },
    mode: { type: "string", enum: IMPORT_MODES, description: "replace（默认）整份替换现有计划；append 追加。" },
  },
  required: ["outline"],
};

export function apply(ctx, config = {}) {
  const limits = {
    maxNodes: Number.isInteger(config.maxNodes) ? config.maxNodes : MAX_IMPORT_NODES,
    planNoteChars: Number.isInteger(config.planNoteChars) ? config.planNoteChars : MAX_NOTE,
    includeTodos: config.includeTodos === true,
  };
  const guidance = typeof config.section === "string" && config.section.trim() !== "" ? config.section : DEFAULT_SECTION;

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "planmap",
      description: "计划树操作（客户端拖拽也走它）：move / status / rename / add / rm / tree",
      input: { hint: "move <节点> <新父节点|->", attachments: false },
      handler: ({ agent, rawInput }) => {
        const parsed = parsePlanMapCommand(rawInput);
        if (!parsed.ok) return { kind: "error", text: parsed.error };
        if (parsed.kind === "tree") {
          const state = ctx.sessionProjections.stateOf(agent.session, "planTree") ?? initialTreeState();
          const view = treeView(state, limits);
          if (view.nodes.length === 0) return { kind: "success", text: "计划树为空。" };
          const label = (node) => {
            const parent = view.nodes.find((n) => n.id === node.parent);
            return `${"  ".repeat(depthOf(view, node))}${node.title} · ${node.status}${parent === undefined ? "" : ""}`;
          };
          return { kind: "success", text: view.nodes.map(label).join("\n") };
        }
        // 只做校验：真正的状态变更由投影折叠本次 `command/run` 完成（官方事件，可回放）
        const state = ctx.sessionProjections.stateOf(agent.session, "planTree") ?? initialTreeState();
        const check = applyPlanNode(state, parsed.intent, limits);
        if (!check.ok) return { kind: "error", text: parsed.intent.action === "add" ? check.error : `${check.error}` };
        return { kind: "success", text: `planmap ${parsed.kind} 已应用` };
      },
    });
  });

  ctx.sessionProjections.register({
    key: "planTree",
    stateVersion: 2,
    stateSchema: { parse: (v) => normalizeTree(v) },
    init: () => initialTreeState(),
    apply: (state, event) => foldTree(state, event, limits),
    wire: { viewSchema: { parse: (v) => v }, view: (s) => treeView(s, limits) },
  });

  if (config.guidance !== false) {
    ctx.systemPrompt.section({
      name: "plan-map:guidance",
      order: 470,
      text: () => guidance,
    });
  }

  ctx.tools.register({
    name: "plan_import",
    description:
      "Register the user's plan as a hierarchical plan tree — the phases and sub-items of THEIR plan (for example: 做游戏 → 策划案 → 构思/成型, 写代码, 测试游戏). One call builds the whole tree from an indented outline or markdown. It also accepts a xinshiimprove task card verbatim (`# 任务：…` plus a `## 子任务拆分` table): the task becomes the root, each subtask row becomes a child node with its 产出 and 验收方式 in the note, and the 状态 column (待开始/进行中/已验收) maps to pending/active/done. Use it whenever the user gives a plan, a task breakdown or a task card, then advance node statuses with plan_node as the work completes. This tree shows the plan's content, not your own reasoning steps.",
    parameters: PLAN_IMPORT_PARAMS,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", const: true },
          nodes: { type: "integer" },
          roots: { type: "integer" },
        },
        required: ["ok", "nodes", "roots"],
      },
      render: (args, value) => [{
        type: "text",
        text: isTaskCard(args?.outline)
          ? `任务卡已登记：${value.nodes - 1} 个子任务（根节点 1 个，状态按卡片里的「状态」列映射）`
          : `计划已登记：${value.nodes} 个节点（${value.roots} 个顶层）`,
      }],
    },
    execute: async (args, exec) => {
      const agent = requireAgent(exec, "plan_import");
      const bad = validateArgs(PLAN_IMPORT_PARAMS, args);
      if (bad.length > 0) throw new Error(`plan_import: invalid arguments: ${bad.join("; ")}`);
      const parsed = parseImport(args.outline, limits);
      if (parsed.length === 0) throw new Error("plan_import: outline produced no nodes");
      // 不写事件：本次调用的官方 tool/call 已经带着同样的参数落库，投影会折叠它
      return { ok: true, nodes: parsed.length, roots: parsed.filter((n) => n.parent === "").length };
    },
    presentCall: (args) => ({
      card: "generic",
      title: "plan_import",
      kind: "other",
      content: [{ type: "text", text: String(args?.outline ?? "").split("\n").slice(0, 12).join("\n") }],
    }),
  });

  ctx.tools.register({
    name: "plan_node",
    description:
      "Update one node of the user's plan tree. Add a child node under any existing node (`parent` accepts an id or an exact title), mark status as the work progresses — active when started, done when finished, blocked when stuck, and BACK to pending or active when the work has to be redone — rename, or remove it. `id` also accepts the node's exact title. Statuses additionally follow the session todo list automatically; an explicit status wins over an older todo update, and a newer todo update wins over an older explicit mark.",
    parameters: PLAN_NODE_PARAMS,
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", const: true },
          nodes: { type: "integer" },
          reparented: { type: "array", items: { type: "string" } },
        },
        required: ["ok", "nodes"],
      },
      render: (args, value) => [{ type: "text", text: `计划树已更新：${value.nodes} 个节点${value.reparented?.length ? `（${value.reparented.length} 个子节点上提）` : ""}` }],
    },
    execute: async (args, exec) => {
      const agent = requireAgent(exec, "plan_node");
      const bad = validateArgs(PLAN_NODE_PARAMS, args);
      if (bad.length > 0) throw new Error(`plan_node: invalid arguments: ${bad.join("; ")}`);
      const session = agent.session;
      // harness 的顺序是「先写 tool/call，再执行工具」，投影此刻已经折叠了本次调用；
      // 所以校验/试算必须用「本次调用之前」的状态——否则同一个动作会被应用两次
      // （add 会撞 "node already exists"、clear/remove 会算错）。
      const current = stateBeforeCall(session, exec.callId, limits);
      const result = applyPlanNode(current, args, limits);
      if (!result.ok) throw new Error(`plan_node: ${result.error}`);
      // 不写事件：本次调用的官方 tool/call 会由投影折叠入树
      return { ok: true, nodes: Object.keys(result.state.nodes).length, reparented: result.state.reparented ?? [] };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `plan_node · ${String(args?.action ?? "")}`,
      kind: "other",
      content: [{ type: "text", text: [args?.id, args?.title, args?.status].filter(Boolean).join(" · ") }],
    }),
  });
}

const DEFAULT_SECTION = [
  "计划树（plan-map）：",
  "- 用户给出计划或任务分解时，用 plan_import 一次登记成树（缩进或 markdown 表示层级）。",
  "- 执行时用 plan_node 推进状态：开始标 active、完成标 done、卡住标 blocked，做错了就标回去（状态可回退）；id 与 parent 都能传标题，子节点可加在任意节点下。",
  "- 这棵树展示的是用户的计划内容，不是你的思考步骤，别往里塞过程日志。",
].join("\n");

/** 节点在树里的深度（用于 /planmap tree 的缩进打印）。 */
function depthOf(view, node) {
  const index = new Map(view.nodes.map((n) => [n.id, n]));
  let depth = 0;
  let cur = node;
  while (cur !== undefined && cur.parent !== "") {
    cur = index.get(cur.parent);
    depth += 1;
    if (depth > 64) break;
  }
  return depth;
}

function requireAgent(exec, toolName) {
  const agent = exec.agent;
  if (agent === undefined) throw new Error(`${toolName} requires a calling agent (no session to record into)`);
  return agent;
}

function sanitize(args) {
  const out = { action: args.action, id: args.id };
  for (const key of ["parent", "title", "status", "note"]) if (args[key] !== undefined && args[key] !== null) out[key] = args[key];
  return out;
}

/**
 * 折叠出「本次 tool/call 之前」的树状态：从日志重放到本次 callId 为止。
 * 投影里的当前状态已经含本次调用（harness 先写 tool/call 再执行工具），
 * 拿它再试算一次会把同一个动作应用两遍（add 撞 id、remove 报不存在）。
 */
function stateBeforeCall(session, callId, limits) {
  const events = Array.isArray(session?.log) ? session.log : Array.isArray(session?.events) ? session.events : [];
  let state = initialTreeState();
  for (const event of events) {
    if (typeof callId === "string" && callId !== "" && event?.type === "tool/call" && event.data?.callId === callId) break;
    if (typeof callId === "string" && callId !== "" && event?.type === "tool/ptc-dispatch" && (event.data?.subCallId === callId || event.data?.callId === callId)) break;
    state = foldTree(state, event, limits);
  }
  return state;
}

function validateArgs(schema, args) {
  const errs = [];
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
  const props = schema.properties ?? {};
  for (const key of Object.keys(args)) if (!Object.hasOwn(props, key)) errs.push(`unknown argument "${key}"`);
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) errs.push(`missing "${key}"`);
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(args, key)) continue;
    const v = args[key];
    if (spec.type === "string") {
      if (typeof v !== "string") { errs.push(`"${key}" must be a string`); continue; }
      if (spec.enum !== undefined && !spec.enum.includes(v)) errs.push(`"${key}" must be one of ${spec.enum.join("|")}`);
    } else if (spec.type === "boolean") {
      if (typeof v !== "boolean") errs.push(`"${key}" must be a boolean`);
    } else if (spec.type === "integer") {
      if (!Number.isInteger(v)) errs.push(`"${key}" must be an integer`);
    } else if (spec.type === "array") {
      if (!Array.isArray(v)) errs.push(`"${key}" must be an array`);
    } else if (spec.type === "object") {
      if (v === null || typeof v !== "object" || Array.isArray(v)) errs.push(`"${key}" must be an object`);
    }
  }
  return errs;
}
