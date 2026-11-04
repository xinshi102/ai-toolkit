import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPlanNode,
  clip,
  effectiveStatus,
  firstHeading,
  foldTree,
  importNodes,
  initialTreeState,
  matchTodo,
  normalizeTitle,
  parseOutline,
  resolveNode,
  treeView,
} from "../lib/index.js";
import { COMPACT, collidingIds, elbowPath, elbowPathVertical, layoutTree, linkPath, measureTitle, nodeWidthOf, truncateToWidth } from "../lib/layout.js";

const GAME_OUTLINE = ["做游戏", "  策划案", "    构思", "    成型", "  写代码", "  测试游戏"].join("\n");

function titles(view) {
  return view.nodes.map((n) => n.title);
}

function statusByTitle(view) {
  return Object.fromEntries(view.nodes.map((n) => [n.title, n.status]));
}

/* ── parseOutline：用户计划 → 树 ───────────────────────────────────────── */

test("parseOutline: 缩进大纲（用户给的游戏计划）", () => {
  const nodes = parseOutline(GAME_OUTLINE);
  assert.deepEqual(nodes.map((n) => n.title), ["做游戏", "策划案", "构思", "成型", "写代码", "测试游戏"]);
  assert.deepEqual(nodes.map((n) => n.parent), ["", "p1", "p2", "p2", "p1", "p1"]);
  assert.ok(nodes.every((n) => n.status === "pending"));
});

test("parseOutline: markdown 标题 + 列表，层级一致", () => {
  const nodes = parseOutline("# 做游戏\n## 策划案\n- 构思\n- 成型\n## 写代码\n## 测试游戏");
  assert.deepEqual(nodes.map((n) => n.title), ["做游戏", "策划案", "构思", "成型", "写代码", "测试游戏"]);
  assert.deepEqual(nodes.map((n) => n.parent), ["", "p1", "p2", "p2", "p1", "p1"]);
});

test("parseOutline: 有序列表、markdown 强调、空行、4 空格缩进", () => {
  const nodes = parseOutline("1. 做游戏\n    - **策划案**\n        - `构思`\n\n- 写代码");
  assert.deepEqual(nodes.map((n) => n.title), ["做游戏", "策划案", "构思", "写代码"]);
  // 4 空格缩进 = 两层（indentUnit 2），父链由栈决定；回到 0 缩进即回到根
  assert.deepEqual(nodes.map((n) => n.parent), ["", "p1", "p2", ""]);
});

test("parseOutline: 空输入与 maxNodes 上限", () => {
  assert.deepEqual(parseOutline(""), []);
  assert.deepEqual(parseOutline("   \n\n"), []);
  const capped = parseOutline(Array.from({ length: 30 }, (_, i) => `节点${i}`).join("\n"), { maxNodes: 5 });
  assert.equal(capped.length, 5);
});

/* ── importNodes / plan/import ─────────────────────────────────────────── */

test("plan/import: replace 整份替换，append 追加", () => {
  let s = foldTree(initialTreeState(), { seq: 1, type: "plan/import", data: { nodes: parseOutline(GAME_OUTLINE), mode: "replace" } });
  assert.equal(treeView(s, {}).nodes.length, 6);
  s = foldTree(s, { seq: 2, type: "plan/import", data: { nodes: parseOutline("新计划\n  子项"), mode: "replace" } });
  assert.deepEqual(titles(treeView(s, {})), ["新计划", "子项"]);
  s = foldTree(s, { seq: 3, type: "plan/import", data: { nodes: parseOutline("另一个计划"), mode: "append" } });
  assert.deepEqual(titles(treeView(s, {})), ["新计划", "子项", "另一个计划"]);
  // 脏数据不动原树
  const before = treeView(s, {}).nodes.length;
  s = foldTree(s, { seq: 4, type: "plan/import", data: { nodes: "nope", mode: "replace" } });
  assert.equal(treeView(s, {}).nodes.length, before);
});

test("importNodes: 父 id 重映射，缺失父挂根，超限跳过", () => {
  const parsed = [
    { id: "a", parent: "", title: "A" },
    { id: "b", parent: "a", title: "B" },
    { id: "c", parent: "ghost", title: "C" },
  ];
  const s = importNodes(initialTreeState(), parsed, "replace");
  const view = treeView(s, {});
  assert.deepEqual(titles(view), ["A", "B", "C"]);
  assert.equal(view.nodes[1].parent, view.nodes[0].id);
  assert.equal(view.nodes[2].parent, "");
  const capped = importNodes(initialTreeState(), parsed, "replace", { maxNodes: 2 });
  assert.equal(capped.skipped, 1);
  assert.equal(treeView(capped, {}).nodes.length, 2);
});

/* ── 状态：自动推进 + 显式标记 ─────────────────────────────────────────── */

test("matchTodo / effectiveStatus：谁后写谁说了算（可前进也可回退）", () => {
  assert.equal(normalizeTitle(" 写代码！ "), "写代码");
  const todos = [
    { content: "构思", status: "completed" },
    { content: "写代码（游戏循环）", status: "in_progress" },
  ];
  assert.equal(matchTodo("构思", todos).status, "completed");       // 精确匹配
  assert.equal(matchTodo("写代码", todos).status, "in_progress");    // 包含匹配
  assert.equal(matchTodo("测试游戏", todos), undefined);
  assert.equal(matchTodo("a", todos), undefined);                    // 太短不匹配

  const node = { title: "构思", status: "pending", statusSeq: 0 };
  // 待办更新更晚 → 跟随待办（前进）
  assert.equal(effectiveStatus(node, todos, 5), "done");
  // 显式标记更晚 → 用显式状态，即使它更早（回退）
  assert.equal(effectiveStatus({ ...node, status: "pending", statusSeq: 9 }, todos, 5), "pending");
  assert.equal(effectiveStatus({ ...node, status: "active", statusSeq: 9 }, todos, 5), "active");
  // 待办再次更新 → 又能盖回来（前进）
  assert.equal(effectiveStatus({ ...node, status: "pending", statusSeq: 9 }, todos, 12), "done");
  // 没有被匹配的待办 → 始终用显式状态
  assert.equal(effectiveStatus({ title: "测试游戏", status: "blocked", statusSeq: 0 }, todos, 99), "blocked");
});

test("todo/write 自动推进状态；显式标记可回退；todo 不占计划树版面", () => {
  let s = foldTree(initialTreeState(), { seq: 1, type: "plan/import", data: { nodes: parseOutline(GAME_OUTLINE), mode: "replace" } });
  assert.equal(treeView(s, {}).nodes.length, 6);
  // 待办完成/进行中 → 节点自动跟进
  s = foldTree(s, { seq: 5, type: "todo/write", data: { todos: [{ content: "构思", status: "completed" }, { content: "成型", status: "in_progress" }] } });
  let view = treeView(s, {});
  assert.equal(view.nodes.length, 6); // 计划树版面不被 todo 污染
  assert.equal(statusByTitle(view)["构思"], "done");
  assert.equal(statusByTitle(view)["成型"], "active");
  assert.equal(statusByTitle(view)["写代码"], "pending");
  assert.deepEqual(view.progress, { total: 6, done: 1, active: 1 });

  // ① 待办回退（AI 发现做错了，把待办改回 pending）→ 节点跟着回退
  s = foldTree(s, { seq: 9, type: "todo/write", data: { todos: [{ content: "构思", status: "pending" }, { content: "成型", status: "in_progress" }] } });
  assert.equal(statusByTitle(treeView(s, {}))["构思"], "pending");

  // ② 显式回退：干完了又发现不对，直接标回 active
  s = foldTree(s, { seq: 12, type: "todo/write", data: { todos: [{ content: "构思", status: "completed" }] } });
  assert.equal(statusByTitle(treeView(s, {}))["构思"], "done");
  s = foldTree(s, { seq: 20, type: "plan/node", data: { action: "update", id: "构思", status: "active" } });
  assert.equal(statusByTitle(treeView(s, {}))["构思"], "active");
  // 之后待办再更新（seq 更新）→ 又跟随待办
  s = foldTree(s, { seq: 30, type: "todo/write", data: { todos: [{ content: "构思", status: "completed" }] } });
  assert.equal(statusByTitle(treeView(s, {}))["构思"], "done");

  // ③ blocked 就是普通状态值，可设可撤
  s = foldTree(s, { seq: 40, type: "plan/node", data: { action: "update", id: "写代码", status: "blocked" } });
  assert.equal(statusByTitle(treeView(s, {}))["写代码"], "blocked");
  s = foldTree(s, { seq: 41, type: "plan/node", data: { action: "update", id: "写代码", status: "pending" } });
  assert.equal(statusByTitle(treeView(s, {}))["写代码"], "pending");

  // ④ todo 子树只在 includeTodos 时出现
  assert.ok(!treeView(s, {}).nodes.some((n) => n.id === "todo:root"));
  assert.ok(treeView(s, { includeTodos: true }).nodes.some((n) => n.id === "todo:root"));
});

test("子节点可加在任意节点下（parent 支持标题，层级不限）", () => {
  let s = importNodes(initialTreeState(), parseOutline(GAME_OUTLINE), "replace");
  let r = applyPlanNode(s, { action: "add", id: "doc", parent: "构思", title: "写设定文档" });
  assert.ok(r.ok);
  r = applyPlanNode(r.state, { action: "add", id: "doc2", parent: "写设定文档", title: "角色表" });
  assert.ok(r.ok);
  const view = treeView(r.state, {});
  const byTitle = Object.fromEntries(view.nodes.map((n) => [n.title, n]));
  assert.equal(byTitle["写设定文档"].parent, byTitle["构思"].id);
  assert.equal(byTitle["角色表"].parent, byTitle["写设定文档"].id);
  const l = layoutTree(view.nodes, {});
  assert.equal(l.positions[byTitle["角色表"].id].depth, 4); // 做游戏(0)→策划案(1)→构思(2)→写设定文档(3)→角色表(4)
  // 父节点不存在 → 明确报错
  const bad = applyPlanNode(r.state, { action: "add", id: "x", parent: "不存在", title: "X" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /pass its id or its exact title/);
  // 迁移父级同样支持标题
  const moved = applyPlanNode(r.state, { action: "update", id: "角色表", parent: "写代码" });
  assert.ok(moved.ok);
  assert.equal(treeView(moved.state, {}).nodes.find((n) => n.title === "角色表").parent, byTitle["写代码"].id);
});

/* ── applyPlanNode：增删改查 + 标题定位 ────────────────────────────────── */

test("add: 建根与子节点、幂等/空标题/父不存在保护", () => {
  let s = initialTreeState();
  s = applyPlanNode(s, { action: "add", id: "api", title: "API 设计" }).state;
  s = applyPlanNode(s, { action: "add", id: "schema", parent: "api", title: "Schema 细化" }).state;
  assert.deepEqual(Object.keys(s.nodes), ["api", "schema"]);
  assert.equal(s.nodes.schema.parent, "api");
  assert.equal(applyPlanNode(s, { action: "add", id: "api", title: "重复" }).ok, false);
  assert.equal(applyPlanNode(s, { action: "add", id: "bad id!", title: "X" }).ok, false);
  assert.equal(applyPlanNode(s, { action: "add", id: "b", title: "  " }).ok, false);
  assert.equal(applyPlanNode(s, { action: "add", id: "b", title: "B", parent: "nope" }).ok, false);
  assert.equal(applyPlanNode(s, { action: "add", id: "c", title: "C", parent: "c" }).ok, false);
});

test("update/remove: 支持按标题定位（自动打标用）", () => {
  let s = importNodes(initialTreeState(), parseOutline("做游戏\n  策划案\n    构思\n    成型"), "replace");
  const updated = applyPlanNode(s, { action: "update", id: "构思", status: "done" });
  assert.ok(updated.ok);
  assert.equal(statusByTitle(treeView(updated.state, {}))["构思"], "done");
  // 开始执行 → active
  const running = applyPlanNode(updated.state, { action: "update", id: "成型", status: "active" });
  assert.equal(statusByTitle(treeView(running.state, {}))["成型"], "active");
  // 删除父节点 → 子节点上提
  const removed = applyPlanNode(running.state, { action: "remove", id: "策划案" });
  assert.ok(removed.ok);
  const after = treeView(removed.state, {});
  const rootId = after.nodes.find((n) => n.title === "做游戏").id;
  // 子节点上提到被删节点的父级（做游戏），不是直接变根
  assert.equal(after.nodes.find((n) => n.title === "构思").parent, rootId);
  assert.deepEqual(removed.state.reparented.length, 2);
  // 找不到
  assert.equal(applyPlanNode(removed.state, { action: "update", id: "不存在", status: "done" }).ok, false);
  // 非法状态保持原值 / 改标题 / 循环父级
  const s2 = applyPlanNode(removed.state, { action: "update", id: "构思", status: "weird" });
  assert.equal(statusByTitle(treeView(s2.state, {}))["构思"], "done");
  const renamed = applyPlanNode(s2.state, { action: "update", id: "构思", title: "构思（细化）" });
  assert.ok(titles(treeView(renamed.state, {})).includes("构思（细化）"));
  assert.equal(applyPlanNode(renamed.state, { action: "update", id: "做游戏", parent: "构思（细化）" }).ok, false);
});

test("clear 与 maxNodes 上限", () => {
  let s = importNodes(initialTreeState(), parseOutline(GAME_OUTLINE), "replace");
  s = applyPlanNode(s, { action: "clear" }).state;
  assert.deepEqual(treeView(s, {}).nodes, []);
  let t = initialTreeState();
  for (let i = 0; i < 3; i++) t = applyPlanNode(t, { action: "add", id: `n${i}`, title: `N${i}` }, { maxNodes: 3 }).state;
  const full = applyPlanNode(t, { action: "add", id: "x", title: "X" }, { maxNodes: 3 });
  assert.equal(full.ok, false);
  assert.match(full.error, /full/);
});

/* ── 批准的计划整份解析 ────────────────────────────────────────────────── */

test("foldTree: exit_plan_mode 的计划整份解析成树（替换语义）", () => {
  let s = foldTree(initialTreeState(), { seq: 1, type: "plan/import", data: { nodes: parseOutline("- 旧计划"), mode: "replace" } });
  // harness 落库的 arguments 是 JSON 字符串（下面也覆盖已解析对象的老写法）
  s = foldTree(s, { seq: 9, type: "tool/call", data: { name: "exit_plan_mode", arguments: JSON.stringify({ plan: "# 做游戏\n## 策划案\n- 构思\n- 成型\n## 写代码" }) } });
  const view = treeView(s, {});
  assert.deepEqual(titles(view), ["做游戏", "策划案", "构思", "成型", "写代码"]);
  assert.ok(view.nodes[0].note.includes("策划案")); // 正文进根节点备注
  assert.ok(!titles(view).includes("旧计划"));       // 替换而非叠加
  // 空白计划是无操作（绝不能清空现有计划）
  const before = treeView(s, {}).nodes.length;
  s = foldTree(s, { seq: 10, type: "tool/call", data: { name: "exit_plan_mode", arguments: { plan: "   \n\n" } } });
  assert.equal(treeView(s, {}).nodes.length, before);
  // 纯文本计划（没有 # 标题）也整份解析；单行 → 单节点树
  s = foldTree(s, { seq: 11, type: "tool/call", data: { name: "exit_plan_mode", arguments: { plan: "就一个任务" } } });
  assert.deepEqual(titles(treeView(s, {})), ["就一个任务"]);
  // 非 exit_plan_mode 的工具调用忽略
  const after = treeView(s, {}).nodes.length;
  assert.equal(treeView(foldTree(s, { seq: 12, type: "tool/call", data: { name: "read", arguments: {} } }), {}).nodes.length, after);
});

/* ── 主路径：官方 tool/call（plan/node、plan/import 自定义事件已停写） ── */

const call = (seq, name, args) => ({ seq, type: "tool/call", data: { name, arguments: JSON.stringify(args) } });

test("foldTree: plan_import 的 tool/call 建树（replace / append）", () => {
  let s = foldTree(initialTreeState(), call(1, "plan_import", { outline: GAME_OUTLINE }));
  assert.deepEqual(titles(treeView(s, {})), ["做游戏", "策划案", "构思", "成型", "写代码", "测试游戏"]);

  s = foldTree(s, call(2, "plan_import", { outline: "另一个计划\n  子项", mode: "append" }));
  assert.equal(Object.keys(s.nodes).length, 8);
  // 非法参数（缺 outline / 未知参数）→ 忽略，不炸会话
  const before = Object.keys(s.nodes).length;
  s = foldTree(s, call(3, "plan_import", { extra: 1 }));
  assert.equal(Object.keys(s.nodes).length, before);
  // 坏 JSON → 忽略
  s = foldTree(s, { seq: 4, type: "tool/call", data: { name: "plan_import", arguments: "{oops" } });
  assert.equal(Object.keys(s.nodes).length, before);
  // 空大纲是无操作，绝不能清空现有计划
  s = foldTree(s, call(5, "plan_import", { outline: "   " }));
  assert.equal(Object.keys(s.nodes).length, before);
});

test("foldTree: plan_node 的 tool/call 推进状态（按 id/标题定位、非法忽略）", () => {
  let s = foldTree(initialTreeState(), call(1, "plan_import", { outline: GAME_OUTLINE }));
  s = foldTree(s, call(2, "plan_node", { action: "update", id: "构思", status: "done" }));
  const node = treeView(s, {}).nodes.find((n) => n.title === "构思");
  assert.equal(node.status, "done");

  s = foldTree(s, call(3, "plan_node", { action: "add", id: "x1", parent: "写代码", title: "补测试" }));
  assert.ok(titles(treeView(s, {})).includes("补测试"));

  // 非法动作 / 不存在的节点 / 非法 id → 原样返回，绝不半途改树
  const snapshot = JSON.stringify(s.nodes);
  assert.equal(JSON.stringify(foldTree(s, call(4, "plan_node", { action: "nope", id: "构思" })).nodes), snapshot);
  assert.equal(JSON.stringify(foldTree(s, call(5, "plan_node", { action: "update", id: "不存在" })).nodes), snapshot);
  assert.equal(JSON.stringify(foldTree(s, call(6, "plan_node", { action: "add", id: "bad id!", title: "X" })).nodes), snapshot);
});

test("foldTree: plan/node 与 plan/import 老事件仍兼容（不丢历史树）", () => {
  let s = foldTree(initialTreeState(), { seq: 1, type: "plan/import", data: { nodes: parseOutline(GAME_OUTLINE), mode: "replace" } });
  s = foldTree(s, { seq: 2, type: "plan/node", data: { action: "update", id: "构思", status: "done" } });
  assert.equal(treeView(s, {}).nodes.find((n) => n.title === "构思").status, "done");
});

test("foldTree: plan/mode 与未知事件", () => {
  let s = foldTree(initialTreeState(), { seq: 2, type: "plan/mode", data: { active: true } });
  assert.equal(treeView(s, {}).planMode, true);
  s = foldTree(s, { seq: 3, type: "plan/mode", data: { active: false } });
  assert.equal(treeView(s, {}).planMode, false);
  const base = initialTreeState();
  assert.deepEqual(foldTree(base, { seq: 1, type: "bash", data: {} }), base);
  // 非法 plan/node 静默跳过（不炸会话）
  assert.deepEqual(foldTree(base, { seq: 1, type: "plan/node", data: { action: "add", id: "bad id!", title: "X" } }).nodes, {});
});

/* ── 恢复 / 状态解析 ───────────────────────────────────────────────────── */

test("stateSchema.parse: 损坏状态回落，保留 todos 与进度", () => {
  const bad = { parse: (v) => v };
  assert.ok(bad !== undefined);
  let s = foldTree(initialTreeState(), { seq: 1, type: "plan/import", data: { nodes: parseOutline(GAME_OUTLINE), mode: "replace" } });
  s = foldTree(s, { seq: 2, type: "todo/write", data: { todos: [{ content: "构思", status: "completed" }] } });
  const roundTrip = JSON.parse(JSON.stringify(s));
  assert.equal(statusByTitle(treeView(roundTrip, {}))["构思"], "done"); // 状态可从日志状态重算
});

/* ── 旧接口保持可用 ────────────────────────────────────────────────────── */

test("firstHeading / clip / resolveNode", () => {
  assert.equal(firstHeading("intro\n### 深度\nbody"), "深度");
  assert.equal(firstHeading("no heading"), undefined);
  assert.equal(clip(" a\nb ", 10), "a b");
  assert.equal(clip("x".repeat(10), 3), "xxx…");
  const s = importNodes(initialTreeState(), parseOutline("做游戏\n  策划案"), "replace");
  assert.equal(resolveNode(s, "p2"), "p2");
  assert.equal(resolveNode(s, "策划案"), "p2");
  assert.equal(resolveNode(s, "不存在"), undefined);
});

/* ── 排版度量 ─────────────────────────────────────────────────────────── */

test("measureTitle: CJK 按 1 个字宽、ASCII 按 0.55", () => {
  assert.equal(measureTitle("构思", 12), 24);
  assert.equal(measureTitle("abcd", 12), Math.ceil(4 * 0.55 * 12));
  assert.ok(measureTitle("更长一点的标题", 12) > measureTitle("短", 12));
});

test("nodeWidthOf: 有下限上限，备注与折叠徽标会加宽", () => {
  const minimal = nodeWidthOf({ title: "构思" });
  assert.ok(minimal >= 88, "有最小宽度，短标题不会缩成一小坨");
  // 用超过下限的标题验证加宽项（下限会把短标题的差异吃掉）
  const mid = nodeWidthOf({ title: "这是一个中等长度的计划节点" });
  assert.ok(mid > minimal);
  assert.equal(nodeWidthOf({ title: "这是一个中等长度的计划节点", note: "x" }), mid + 14);
  assert.equal(nodeWidthOf({ title: "这是一个中等长度的计划节点", collapsedChildren: true }), mid + 30);
  const long = nodeWidthOf({ title: "这是一个非常非常长的计划节点标题用来测试上限" });
  assert.ok(long <= 280);
  assert.ok(nodeWidthOf({ title: "构思" }, { compact: true }) < minimal, "紧凑档更窄");
});

/* ── layoutTree（横向 tidy tree；客户端内联同一份实现） ────────────────── */

const TREE = [
  { id: "root", parent: "", title: "总览", status: "active" },
  { id: "a", parent: "root", title: "分支 A", status: "pending" },
  { id: "a1", parent: "a", title: "A1", status: "pending" },
  { id: "a2", parent: "a", title: "A2", status: "pending" },
  { id: "b", parent: "root", title: "分支 B", status: "done" },
];

const rects = (l) => Object.entries(l.positions).map(([id, p]) => ({ id, ...p }));
const overlaps = (x, y) => x.x < y.x + y.w && y.x < x.x + x.w && x.y < y.y + y.h && y.y < x.y + x.h;

test("layoutTree: 深度决定列 X，同一列左对齐", () => {
  const l = layoutTree(TREE, {});
  assert.deepEqual(l.roots, ["root"]);
  assert.equal(l.positions.root.x, l.depthPos[0]);
  assert.equal(l.positions.a.x, l.depthPos[1]);
  assert.equal(l.positions.b.x, l.depthPos[1], "同层必须同 x（列对齐才像图）");
  assert.equal(l.positions.a1.x, l.depthPos[2]);
  assert.ok(l.depthPos[1] > l.depthPos[0] && l.depthPos[2] > l.depthPos[1]);
});

test("layoutTree: 没有节点重叠，兄弟子树之间留出竖直间距", () => {
  const l = layoutTree(TREE, {});
  const rs = rects(l);
  for (let i = 0; i < rs.length; i += 1) {
    for (let j = i + 1; j < rs.length; j += 1) {
      assert.ok(!overlaps(rs[i], rs[j]), `${rs[i].id} 与 ${rs[j].id} 重叠`);
    }
  }
  // a1 / a2 是相邻叶子：间距应正好是 gapY 级别（紧凑但不挤）
  const gap = l.positions.a2.y - (l.positions.a1.y + l.positions.a1.h);
  assert.ok(gap > 0 && gap < 24, `叶子间距异常：${gap}`);
});

test("layoutTree: 父节点纵向落在首末子节点之间（居中语义）", () => {
  const l = layoutTree(TREE, {});
  const center = (id) => l.positions[id].y + l.positions[id].h / 2;
  assert.ok(center("a") >= Math.min(center("a1"), center("a2")) - 0.01);
  assert.ok(center("a") <= Math.max(center("a1"), center("a2")) + 0.01);
  assert.ok(center("root") >= Math.min(center("a"), center("b")) - 0.01);
  assert.ok(center("root") <= Math.max(center("a"), center("b")) + 0.01);
  assert.ok(l.positions.root.y >= 0, "整棵树归一化到画布内，不出现负坐标");
});

test("layoutTree: 可变宽度按列取最宽节点", () => {
  const wide = [
    { id: "r", parent: "", title: "根" },
    { id: "k1", parent: "r", title: "很短" },
    { id: "k2", parent: "r", title: "这是一个明显更长的子节点标题" },
  ];
  const l = layoutTree(wide, {});
  assert.ok(l.positions.k2.w > l.positions.k1.w, "长标题的卡片更宽");
  // 画布必须覆盖最后一列最宽的那个节点；列 X 逐列递增
  assert.ok(l.depthPos[1] > l.depthPos[0]);
  assert.ok(l.width >= l.depthPos[1] + l.positions.k2.w, "画布要装得下最宽节点");
});

test("layoutTree: 折叠后子树不参与排版并给出计数", () => {
  const l = layoutTree(TREE, { collapsed: ["a"] });
  assert.equal(l.positions.a1, undefined);
  assert.equal(l.positions.a2, undefined);
  assert.equal(l.subtree.a, 2);
  assert.equal(l.edges.length, 2);
});

test("layoutTree: 紧凑档靠重排（更小尺寸）而不是缩字", () => {
  const normal = layoutTree(TREE, {});
  const tiny = layoutTree(TREE, { compact: true });
  assert.ok(tiny.width < normal.width && tiny.height < normal.height);
  assert.equal(tiny.nodeH, COMPACT.nodeHeight);
});

test("layoutTree: 循环父级回退为根", () => {
  const cyclic = [
    { id: "x", parent: "y", title: "X", status: "pending" },
    { id: "y", parent: "x", title: "Y", status: "pending" },
  ];
  const l = layoutTree(cyclic, {});
  assert.deepEqual(l.roots.sort(), ["x", "y"]);
  const rs = rects(l);
  assert.ok(!overlaps(rs[0], rs[1]));
});

test("layoutTree: 深链只长宽度不长高度（右栏又高又窄的关键）", () => {
  const chain = [{ id: "n0", parent: "", title: "L0" }];
  for (let i = 1; i < 8; i++) chain.push({ id: `n${i}`, parent: `n${i - 1}`, title: `L${i}` });
  const l = layoutTree(chain, {});
  assert.equal(l.height, l.nodeH);
  assert.ok(l.width > l.depthPos[7]);
});

/* ── 圆角折线 ─────────────────────────────────────────────────────────── */

test("elbowPath: 同行直接横线，跨行是「横-竖-横」圆角折线", () => {
  const parent = { x: 0, y: 0, w: 100, h: 34 };
  const sameRow = elbowPath(parent, { x: 144, y: 0, w: 100, h: 34 });
  assert.equal(sameRow, "M 100 17 H 144");
  const below = elbowPath(parent, { x: 144, y: 60, w: 100, h: 34 });
  assert.ok(below.startsWith("M 100 17 "), "从左中出发");
  assert.ok(below.includes("Q"), "拐角是二次贝塞尔（圆角）");
  assert.ok(below.includes("V 68"), "竖线落在子节点中线附近（留出圆角半径）");
  assert.ok(below.trim().endsWith("H 144"), "收在子节点左边中点");
  const above = elbowPath(parent, { x: 144, y: -60, w: 100, h: 34 });
  assert.ok(above.includes("V -34"), "向上同样成立（圆角方向镜像）");
});

/* ── 方向：上下（vertical）与左右（horizontal）同一套算法 ─────────────── */

test("layoutTree: vertical 方向是「上根下枝」，深度决定行 Y", () => {
  const l = layoutTree(TREE, { direction: "vertical" });
  assert.equal(l.direction, "vertical");
  // 同一层必须同一 y（行对齐），父层在上
  assert.equal(l.positions.root.y, l.depthPos[0]);
  assert.equal(l.positions.a.y, l.depthPos[1]);
  assert.equal(l.positions.b.y, l.depthPos[1]);
  assert.equal(l.positions.a1.y, l.depthPos[2]);
  assert.ok(l.depthPos[1] > l.depthPos[0] && l.depthPos[2] > l.depthPos[1]);
  // 兄弟左右排开、不重叠
  const rs = rects(l);
  for (let i = 0; i < rs.length; i += 1) {
    for (let j = i + 1; j < rs.length; j += 1) assert.ok(!overlaps(rs[i], rs[j]), `${rs[i].id}/${rs[j].id} 重叠`);
  }
  // 父节点横向居中于首末子节点之间
  const cx = (id) => l.positions[id].x + l.positions[id].w / 2;
  assert.ok(cx("a") >= Math.min(cx("a1"), cx("a2")) - 0.01);
  assert.ok(cx("a") <= Math.max(cx("a1"), cx("a2")) + 0.01);
  // 画布装得下
  const maxX = Math.max(...rs.map((r) => r.x + r.w));
  const maxY = Math.max(...rs.map((r) => r.y + r.h));
  assert.ok(maxX <= l.width + 0.01 && maxY <= l.height + 0.01);
});

test("linkPath: 两个方向各自的连线几何", () => {
  const parent = { x: 0, y: 0, w: 100, h: 34 };
  const child = { x: 144, y: 60, w: 100, h: 34 };
  assert.equal(linkPath(parent, child, { direction: "horizontal" }), elbowPath(parent, child));
  const vertical = linkPath(parent, child, { direction: "vertical" });
  assert.equal(vertical, elbowPathVertical(parent, child));
  assert.ok(vertical.startsWith("M 50 34 "), "从上根节点下中出发");
  assert.ok(vertical.includes("Q"), "圆角拐角");
  assert.ok(vertical.trim().endsWith("V 60"), "收在下子节点上边");
});

/* ── 验收发现的布局 bug：文本溢出 / 节点重叠（回归） ──────────────────── */

test("truncateToWidth: 任何宽度预算下都不溢出（中文最容易出错）", () => {
  const titles = [
    "构建 DSH 插件生态：让 DeepSeek 更好用",
    "纯中文的很长的计划节点标题用来测试溢出问题",
    "mixed 混合 CJK and ascii 标题 with 更多内容",
    "短",
    "",
  ];
  for (const title of titles) {
    for (let maxPx = 0; maxPx <= 400; maxPx += 7) {
      for (const font of [11, 12, 13]) {
        const out = truncateToWidth(title, maxPx, font);
        assert.ok(measureTitle(out, font) <= maxPx + 0.001, `「${title}」@${maxPx}px/${font}px → 「${out}」溢出`);
      }
    }
  }
  // 逐字截断必须优于按字符数估：中文标题在 120px 内应保留不超过预算的量
  assert.ok(measureTitle(truncateToWidth("构建 DSH 插件生态", 120, 12), 12) <= 120);
});

test("layoutTree: 超长标题 / 深树 / 多根 都不重叠（两种方向、两种密度）", () => {
  const nodes = [
    { id: "r", parent: "", title: "构建 DSH 插件生态：让 DeepSeek 更好用" },
    { id: "a", parent: "r", title: "纯中文的很长的计划节点标题用来测试重叠" },
    { id: "b", parent: "r", title: "mixed 混合 CJK and ascii 的标题" },
    { id: "a1", parent: "a", title: "短" },
    { id: "a2", parent: "a", title: "另一个同样很长的中文子节点标题" },
    { id: "a3", parent: "a", title: "x" },
    { id: "deep1", parent: "a1", title: "第四层" },
    { id: "deep2", parent: "deep1", title: "第五层" },
    { id: "orphan", parent: "ghost", title: "孤儿节点也很长很长很长" },
  ];
  for (const compact of [false, true]) {
    for (const direction of ["horizontal", "vertical"]) {
      const l = layoutTree(nodes, { compact, direction });
      const rects = Object.entries(l.positions).map(([id, p]) => ({ id, ...p }));
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i];
          const b = rects[j];
          const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          assert.ok(!hit, `${direction}/${compact ? "compact" : "normal"}: ${a.id} 与 ${b.id} 重叠`);
        }
      }
      // 坐标不得为负（画布从原点开始）
      for (const rect of rects) assert.ok(rect.x >= -0.001 && rect.y >= -0.001, `${rect.id} 出现负坐标`);
    }
  }
});

test("collidingIds: 自动布局不互压；手工偏移压住了就点出双方", () => {
  const nodes = [
    { id: "r", parent: "", title: "根" },
    { id: "a", parent: "r", title: "甲" },
    { id: "b", parent: "r", title: "乙" },
  ];
  const l = layoutTree(nodes, {});
  assert.deepEqual(collidingIds(l.positions), [], "自动布局本来就该是干净的");

  // 模拟用户把 b 拖到 a 身上（手工偏移不受布局约束）
  const a = l.positions.a;
  const dragged = { ...l.positions, b: { ...l.positions.b, x: a.x, y: a.y } };
  assert.deepEqual(collidingIds(dragged).sort(), ["a", "b"]);

  // 只碰到别人、只被别人碰到，都算参与冲突（否则复位后仍会压着）
  const three = { ...l.positions, b: { ...l.positions.b, x: a.x, y: a.y }, c: { x: a.x + 2, y: a.y + 2, w: a.w, h: a.h } };
  assert.deepEqual(collidingIds(three), ["a", "b", "c"]);
});

test("collidingIds: 边界相接不算重叠（复位不能误伤整整齐齐的摆放）", () => {
  const a = { x: 0, y: 0, w: 100, h: 40 };
  assert.deepEqual(collidingIds({ a, b: { x: 100, y: 0, w: 100, h: 40 } }), [], "右邻相接");
  assert.deepEqual(collidingIds({ a, b: { x: 0, y: 40, w: 100, h: 40 } }), [], "下邻相接");
  assert.deepEqual(collidingIds({ a }), [], "单节点");
  assert.deepEqual(collidingIds({}), [], "空");
  assert.deepEqual(collidingIds(undefined), [], "缺参不炸");
  assert.deepEqual(collidingIds({ a, b: { x: 99.5, y: 0, w: 100, h: 40 } }), ["a", "b"], "压进去 0.5px 就算压住");
});

test("回归（2026-09-24 线上事故）：重排后旧的手工偏移会把节点摞在一起", () => {
  // 线上数据：localStorage 里存着 p10{dy:85} / p12{dy:143} / p8{dy:47} 这几个手工位置，
  // 面板放不下 → 客户端自动折叠成两列 → 基准位置变了，但「手拖到哪儿就停在哪儿」的偏移没变
  // → p10 压住 web-search-plus、p12 压住 xinshi-skill / xinshi-dsh-integration。
  // 这份用例复原的就是那一次的几何：8 个第一层兄弟（各带一个子节点 → 会被自动折叠）。
  const nodes = [{ id: "p1", parent: "", title: "构建 DSH 插件生态" }];
  for (const [i, name] of ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛"].entries()) {
    nodes.push({ id: `n${i}`, parent: "p1", title: `${name}节点标题` });
    nodes.push({ id: `n${i}c`, parent: `n${i}`, title: "子" });
  }
  const offsets = { n1: { dx: -4, dy: 47 }, n3: { dx: -2, dy: 85 }, n5: { dx: -2, dy: 143 } };
  const auto = new Set(nodes.filter((n) => n.parent && nodes.some((c) => c.parent === n.id)).map((n) => n.id));
  const l = layoutTree(nodes, { collapsed: auto, compact: true, direction: "horizontal" });
  const rects = {};
  for (const [id, p] of Object.entries(l.positions)) {
    const off = offsets[id] || { dx: 0, dy: 0 };
    rects[id] = { ...p, x: p.x + off.dx, y: p.y + off.dy };
  }
  const hit = collidingIds(rects);
  assert.ok(hit.length > 0, "重排后旧偏移应当造成互压（这就是用户截图里的重叠）");
  // 自修复 = 只删掉「有手工位置 且 参与冲突」的那些，别人的手工位置不动
  const manual = Object.keys(offsets);
  const touched = hit.filter((id) => manual.includes(id));
  assert.ok(touched.length > 0, "参与冲突的手工位置必须被复位");
  for (const id of touched) assert.ok(manual.includes(id), `${id} 不该被动`);
  const fixed = { ...rects };
  for (const id of touched) fixed[id] = l.positions[id];
  assert.deepEqual(collidingIds(fixed), [], "复位后不得再有重叠");
  for (const id of manual.filter((id) => !touched.includes(id))) {
    assert.deepEqual({ x: fixed[id].x, y: fixed[id].y }, { x: rects[id].x, y: rects[id].y }, `${id} 的手工位置应当保留`);
  }
});
