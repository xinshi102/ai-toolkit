/**
 * 接线冒烟测试：mock ctx 驱动 plan-map 的真实注册与执行路径
 * （两个工具 / guidance 段 / 投影折叠 / todo 自动推进 / 状态恢复）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, parseOutline, parsePlanMapCommand } from "../lib/index.js";

const GAME_OUTLINE = ["做游戏", "  策划案", "    构思", "    成型", "  写代码", "  测试游戏"].join("\n");

function createSession() {
  const events = [];
  return {
    events,
    eventAt: (seq) => events.find((e) => e.seq === seq),
    append(type, data, opts) {
      const seq = events.length + 1;
      events.push({ type, data, seq, surfaceOp: opts?.surfaceOp });
      return { seq };
    },
  };
}

function createMockCtx(services = {}) {
  const registered = { tools: [], projections: [], sections: [], commands: [], hooks: new Map(), logs: [] };
  const store = { ...services };
  const ctx = {
    get: (name) => store[name],
    logger: { warn: (...a) => registered.logs.push(a), info: () => {} },
    effect: () => () => {},
    inject: (names, fn) => {
      const child = { ...ctx };
      for (const n of names) if (store[n] !== undefined) child[n] = store[n];
      fn(child);
    },
    on: (name, handler) => {
      if (!registered.hooks.has(name)) registered.hooks.set(name, []);
      registered.hooks.get(name).push(handler);
    },
    tools: { register: (def) => registered.tools.push(def) },
    systemPrompt: { section: (s) => registered.sections.push(s), getSectionOrder: () => 500 },
    sessionProjections: {
      register: (def) => registered.projections.push(def),
      stateOf: (session, key) => {
        const def = registered.projections.find((p) => p.key === key);
        if (def === undefined) return undefined;
        let state = def.init();
        for (const ev of session.events) state = def.apply(state, ev);
        return state;
      },
    },
    commands: { register: (definition) => registered.commands.push(definition) },
  };
  return { ctx, registered };
}

function setup(config = {}) {
  const { ctx, registered } = createMockCtx();
  apply(ctx, config);
  const projection = registered.projections.find((p) => p.key === "planTree");
  return { registered, projection, tool: (name) => registered.tools.find((t) => t.name === name) };
}

test("注册：planTree 投影(v2) + plan_import/plan_node 工具 + guidance 段", () => {
  const { registered, projection, tool } = setup({ guidance: true });
  assert.ok(projection !== undefined);
  assert.equal(projection.stateVersion, 2);
  assert.equal(typeof projection.stateSchema.parse, "function");
  assert.deepEqual(projection.wire.view(projection.init()), { nodes: [], planMode: false, updatedSeq: 0, progress: { total: 0, done: 0, active: 0 } });

  assert.deepEqual(registered.tools.map((t) => t.name).sort(), ["plan_import", "plan_node"]);
  for (const name of ["plan_import", "plan_node"]) {
    const def = tool(name);
    assert.equal(def.parameters.type, "object");
    assert.equal(def.parameters.additionalProperties, false);
    assert.equal(typeof def.execute, "function");
    assert.equal(typeof def.output.render, "function");
  }
  assert.deepEqual(tool("plan_import").parameters.required, ["outline"]);
  assert.deepEqual(tool("plan_node").parameters.required, ["action"]);

  const section = registered.sections.find((s) => s.name === "plan-map:guidance");
  assert.ok(section !== undefined);
  assert.equal(section.order, 470);
  assert.match(section.text(), /plan_import/);
  // guidance:false 不注入提示段
  assert.equal(setup({ guidance: false }).registered.sections.length, 0);
});

/** 模拟 harness 的真实顺序：先把模型的 tool/call 落库，再执行工具（并返回本次 callId）。 */
function callTool(session, name, args, callId) {
  session.append("tool/call", { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) });
  return { callId };
}

test("plan_import execute：直接吃任务卡（子任务表→节点、状态列→状态、验收方式→阶段门），且投影回放同树", async () => {
  const { tool, projection } = setup();
  const importTool = tool("plan_import");
  const session = createSession();
  const agent = { session };
  const card = [
    "# 任务：给计划树加任务卡导入",
    "",
    "## 档位（必填）",
    "M",
    "",
    "## 目标（必填）",
    "让 plan_import 直接吃任务卡。",
    "",
    "## 子任务拆分（L / XL 必填，M 可选）",
    "| # | 子任务 | 产出 | 验收方式 | 状态 |",
    "|---|---|---|---|---|",
    "| 1 | 写解析器 | lib/card.js | 单测全绿 | 已验收 |",
    "| 2 | 接进 plan_import | 统一导入入口 | 回放同树 | 进行中 |",
    "| 3 | 补文档 | README | 人能照写 | 待开始 |",
    "",
    "## 验收方式（必填）",
    "verify 全绿。",
  ].join("\n");

  const { callId } = callTool(session, "plan_import", { outline: card }, "card-1");
  const out = await importTool.execute({ outline: card }, { agent, callId });
  assert.deepEqual(out, { ok: true, nodes: 4, roots: 1 });
  assert.match(importTool.output.render({ outline: card }, out)[0].text, /任务卡已登记：3 个子任务/);
  // 大纲渲染文案不受影响
  assert.match(importTool.output.render({ outline: "甲\n  乙" }, { nodes: 2, roots: 1 })[0].text, /计划已登记/);

  // execute 与投影回放必须得到同一棵树（否则重启后树会变样）
  let state = projection.init();
  for (const ev of session.events) state = projection.apply(state, ev);
  const nodes = Object.values(state.nodes);
  assert.equal(nodes.length, 4);
  assert.equal(nodes[0].title, "给计划树加任务卡导入");
  assert.deepEqual(nodes.slice(1).map((n) => [n.title, n.status]), [["写解析器", "done"], ["接进 plan_import", "active"], ["补文档", "pending"]]);
  assert.match(nodes[0].note, /档位：M/);
  assert.match(nodes[1].note, /验收：单测全绿/);
  assert.equal(nodes[0].status, "active", "子任务汇总：有进行中 → 根 active");
});

test("plan_import execute：解析大纲、由官方 tool/call 承载（不写自定义事件）", async () => {
  const { tool, projection } = setup();
  const importTool = tool("plan_import");
  const session = createSession();
  const agent = { session };

  await assert.rejects(importTool.execute({ outline: GAME_OUTLINE }, {}), /calling agent/);
  await assert.rejects(importTool.execute({ outline: "   " }, { agent }), /no nodes/);
  await assert.rejects(importTool.execute({ outline: GAME_OUTLINE, extra: 1 }, { agent }), /unknown argument/);

  const { callId } = callTool(session, "plan_import", { outline: GAME_OUTLINE }, "c1");
  const out = await importTool.execute({ outline: GAME_OUTLINE }, { agent, callId });
  assert.deepEqual(out, { ok: true, nodes: 6, roots: 1 });
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0].type, "tool/call");
  // 关键回归：不再往会话日志写自定义事件类型（写了这个会话就再也打不开）
  assert.equal(session.events.some((e) => String(e.type).startsWith("plan/")), false);
  // 投影从官方 tool/call 折叠出同一棵树
  let state = projection.init();
  for (const ev of session.events) state = projection.apply(state, ev);
  assert.equal(Object.keys(state.nodes).length, 6);

  callTool(session, "plan_import", { outline: "另一个计划", mode: "append" }, "c2");
  const appended = await importTool.execute({ outline: "另一个计划", mode: "append" }, { agent, callId: "c2" });
  assert.equal(appended.nodes, 1);
  state = projection.init();
  for (const ev of session.events) state = projection.apply(state, ev);
  assert.equal(Object.keys(state.nodes).length, 7);
});

test("plan_node execute：重放到本次调用之前再试算、错误路径", async () => {
  const { tool } = setup();
  const nodeTool = tool("plan_node");
  const session = createSession();
  const agent = { session };

  await assert.rejects(nodeTool.execute({ action: "add", id: "a", title: "A" }, {}), /calling agent/);
  callTool(session, "plan_import", { outline: GAME_OUTLINE }, "c1");
  await tool("plan_import").execute({ outline: GAME_OUTLINE }, { agent, callId: "c1" });

  callTool(session, "plan_node", { action: "update", id: "构思", status: "done" }, "c2");
  const done = await nodeTool.execute({ action: "update", id: "构思", status: "done" }, { agent, callId: "c2" });
  assert.equal(done.ok, true);
  assert.equal(done.nodes, 6);
  assert.equal(session.events.at(-1).type, "tool/call");

  callTool(session, "plan_node", { action: "update", id: "不存在", status: "done" }, "c3");
  await assert.rejects(nodeTool.execute({ action: "update", id: "不存在", status: "done" }, { agent, callId: "c3" }), /does not exist/);
  // 非法 id 的报错来自 applyPlanNode（add 要求 id 形状），不是通用参数校验
  await assert.rejects(nodeTool.execute({ action: "add", id: "bad id!", title: "X" }, { agent }), /requires id matching/);
  await assert.rejects(nodeTool.execute({ action: "nope" }, { agent }), /invalid arguments/);

  callTool(session, "plan_node", { action: "clear" }, "c4");
  const cleared = await nodeTool.execute({ action: "clear" }, { agent, callId: "c4" });
  assert.equal(cleared.nodes, 0);
  assert.equal(session.events.some((e) => String(e.type).startsWith("plan/")), false);
});

test("投影折叠：plan/import + todo/write 自动推进 + plan/mode", () => {
  const { projection } = setup();
  const session = createSession();
  session.append("plan/import", { nodes: parseOutline(GAME_OUTLINE), mode: "replace" });
  session.append("todo/write", { todos: [{ content: "构思", status: "completed" }, { content: "写代码", status: "in_progress" }] });
  session.append("plan/mode", { active: true });

  let state = projection.init();
  for (const ev of session.events) state = projection.apply(state, ev);
  const view = projection.wire.view(state);
  assert.equal(view.planMode, true);
  assert.equal(view.nodes.length, 6); // todo 不占计划树版面
  const byTitle = Object.fromEntries(view.nodes.map((n) => [n.title, n.status]));
  assert.equal(byTitle["构思"], "done");        // 待办完成 → 节点自动 done
  assert.equal(byTitle["写代码"], "active");     // 待办进行中 → 节点自动 active
  assert.equal(byTitle["测试游戏"], "pending");
  assert.deepEqual(view.progress, { total: 6, done: 1, active: 1 });
});

test("stateSchema.parse：损坏状态回落，statusSeq/todoSeq 决定谁说了算", () => {
  const { projection } = setup();
  assert.deepEqual(projection.stateSchema.parse(null), projection.init());
  const restored = projection.stateSchema.parse({
    nodes: {
      p1: { parent: "", title: "构思", status: "pending", statusSeq: 3 },
      p2: { parent: "p1", title: "成型", status: "done", statusSeq: 0 },
      p3: { parent: "p1", title: "验收", status: "pending", statusSeq: 99 },
    },
    order: ["p1", "p2", "p3", "ghost"],
    planMode: "yes",
    todos: [{ content: "构思", status: "completed" }, { content: "验收", status: "completed" }, "junk"],
    todoSeq: 5,
    updatedSeq: 7,
  });
  assert.equal(restored.nodes.p1.status, "pending");
  assert.equal(restored.nodes.p1.statusSeq, 3);
  assert.deepEqual(restored.order, ["p1", "p2", "p3"]);
  assert.equal(restored.planMode, false);
  assert.equal(restored.todoSeq, 5);
  assert.equal(restored.updatedSeq, 7);
  assert.deepEqual(restored.todos, [{ content: "构思", status: "completed" }, { content: "验收", status: "completed" }]);

  const byTitle = Object.fromEntries(projection.wire.view(restored).nodes.map((n) => [n.title, n.status]));
  assert.equal(byTitle["构思"], "done");    // todoSeq 5 > statusSeq 3 → 跟随待办
  assert.equal(byTitle["成型"], "done");    // 无匹配待办 → 用显式状态
  assert.equal(byTitle["验收"], "pending"); // statusSeq 99 > todoSeq 5 → 显式标记更晚，压过待办
});

/* ── 命令通道：客户端拖拽/点击 → /planmap → 官方 command/run ───────────── */

test("parsePlanMapCommand: 各子命令与错误路径", () => {
  assert.equal(parsePlanMapCommand("move 构思 写代码").intent.parent, "写代码");
  assert.equal(parsePlanMapCommand("move 构思 -").intent.parent, null, "`-` 表示移到根");
  assert.equal(parsePlanMapCommand("status 构思 done").intent.status, "done");
  assert.equal(parsePlanMapCommand("rename 构思 构思（细化）").intent.title, "构思（细化）");
  const added = parsePlanMapCommand("add 策划案 写设定文档");
  assert.equal(added.intent.parent, "策划案");
  assert.equal(added.intent.title, "写设定文档");
  assert.equal(parsePlanMapCommand("rm 成型").kind, "rm");
  assert.equal(parsePlanMapCommand("tree").kind, "tree");
  for (const bad of ["", "nope 1 2", "status 构思", "status 构思 weird", "move 构思", "rename 构思", "add 策划案"]) {
    assert.equal(parsePlanMapCommand(bad).ok, false, `应报错：${bad}`);
  }
});

test("command/run 折叠成树变更（拖动持久化的路径）", () => {
  const { projection } = setup();
  const session = createSession();
  session.append("plan/import", { nodes: parseOutline(GAME_OUTLINE), mode: "replace" });
  session.append("command/run", { commandId: "c1", name: "planmap", args: "status 构思 done" });
  session.append("command/run", { commandId: "c2", name: "planmap", args: "move 成型 写代码" });
  session.append("command/run", { commandId: "c3", name: "other", args: "status 构思 pending" });

  let state = projection.init();
  for (const ev of session.events) state = projection.apply(state, ev);
  const view = projection.wire.view(state);
  const byTitle = Object.fromEntries(view.nodes.map((n) => [n.title, n]));
  assert.equal(byTitle["构思"].status, "done");
  assert.equal(byTitle["写代码"].id, byTitle["成型"].parent, "成型 已挂到 写代码 下");
  assert.equal(byTitle["构思"].status, "done", "别的命令不动这棵树");
});

test("/planmap 命令已注册（客户端拖拽的唯一通道）", () => {
  const { registered } = setup();
  const command = registered.commands.find((c) => c.name === "planmap");
  assert.ok(command !== undefined, "必须注册 planmap 命令");
  assert.ok(command.input.hint.length > 0, "hint 不能为空（宿主会拒绝空 hint）");
  const session = createSession();
  session.append("plan/import", { nodes: parseOutline(GAME_OUTLINE), mode: "replace" });
  const agent = { session };
  assert.equal(command.handler({ agent, rawInput: "move 构思 不存在" }).kind, "error");
  assert.equal(command.handler({ agent, rawInput: "status 构思 done" }).kind, "success");
  assert.match(command.handler({ agent, rawInput: "tree" }).text, /做游戏/);
});
