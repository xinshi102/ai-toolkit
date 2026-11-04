/**
 * 接线冒烟测试：用 mock ctx 驱动插件体，验证注册形状与 pre-step 中间件行为。
 * mock 的 API 形状均对照官方 bundled 源码（dsh-tools/dsh-session-projection/
 * dsh-agent-loop/dsh-plan-mode）逐一核对。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

function createSession() {
  const events = [];
  let replaceGeneration = 0;
  return {
    events,
    surface: {
      nodes: [],
      get replaceGeneration() { return replaceGeneration; },
    },
    eventAt: (seq) => events.find((e) => e.seq === seq),
    append(type, data, opts) {
      const seq = events.length + 1;
      events.push({ type, data, seq, surfaceOp: opts?.surfaceOp, sourceEventSeqs: opts?.sourceEventSeqs });
      if (opts?.surfaceOp !== undefined) replaceGeneration += 1;
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
      for (const n of names) child[n] = store[n];
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
    commands: { register: (def) => registered.commands.push(def) },
  };
  return { ctx, registered };
}

function toolResultEvent(session, text) {
  session.append("tool/result", { message: { role: "user", content: [{ type: "tool_result", callId: `c${session.events.length}`, content: [{ type: "text", text }] }] } });
  const seq = session.events.length;
  session.surface.nodes.push(seq);
  return seq;
}

test("插件注册：section(460) / chain_note 工具 / chain 投影 / pre-step 钩子", () => {
  const { ctx, registered } = createMockCtx();
  apply(ctx, { section: "TEST-SECTION", staleAfterSteps: 2 });
  assert.equal(registered.sections.length, 1);
  assert.equal(registered.sections[0].order, 460);
  assert.equal(registered.sections[0].text(), "TEST-SECTION");
  assert.ok(registered.projections.some((p) => p.key === "chain"));
  const tool = registered.tools.find((t) => t.name === "chain_note");
  assert.ok(tool !== undefined);
  assert.equal(tool.parameters.type, "object");
  assert.deepEqual(tool.parameters.required, ["phase", "note"]);
  assert.equal(typeof tool.output.render, "function");
  assert.equal(typeof tool.execute, "function");
  assert.equal(registered.hooks.has("agent/pre-step"), false);
});

test("chain_note execute：无 agent 报错；只依赖官方 tool/call，不写自定义事件", async () => {
  const { ctx, registered } = createMockCtx();
  apply(ctx, { staleAfterSteps: 2 });
  const tool = registered.tools.find((t) => t.name === "chain_note");
  await assert.rejects(tool.execute({ phase: "plan", note: "x" }, {}), /calling agent/);
  const session = createSession();
  const agent = { session };
  // harness 的真实顺序：先把模型的 tool/call 落库，再执行工具
  session.append("tool/call", { turn: 1, step: 1, callId: "c1", name: "chain_note", arguments: JSON.stringify({ phase: "act", note: "改代码" }) });
  const out = await tool.execute({ phase: "act", note: "改代码" }, { agent });
  assert.deepEqual(out, { ok: true, phase: "act", notes: 1 });
  assert.equal(session.events.length, 1);
  assert.equal(session.events[0].type, "tool/call");
  // 关键回归：不再往会话日志写自定义事件类型（写了这个会话就再也打不开）
  assert.equal(session.events.some((e) => String(e.type).startsWith("chain/")), false);
  await assert.rejects(tool.execute({ phase: "bad", note: "x" }, { agent }), /invalid arguments/);
});

test("提醒只进系统提示段，不插对话，也不注册 pre-step 钩子", () => {
  const { ctx, registered } = createMockCtx();
  apply(ctx, { section: "BASE", staleAfterSteps: 2 });
  const section = registered.sections[0];
  assert.equal(section.order, 460);
  // 没有 agent / 没有会话状态 → 原样返回基础段
  assert.equal(section.text(), "BASE");
  assert.equal(section.text({}), "BASE");

  const session = createSession();
  const agent = { session };
  // 从未用过 chain_note → 不提醒（长会话历史步数不算欠账）
  for (let i = 0; i < 5; i++) session.append("step/start", { turn: 1, step: i + 1 });
  assert.equal(section.text({ agent }), "BASE");

  // 用过一次（官方 tool/call 承载）+ 连续 3 步未记录 → 提醒出现在段里
  session.append("tool/call", { turn: 1, step: 5, callId: "c1", name: "chain_note", arguments: JSON.stringify({ phase: "act", note: "改代码", next: "" }) });
  for (let i = 0; i < 3; i++) session.append("step/start", { turn: 1, step: i + 6 });
  const text = section.text({ agent });
  assert.ok(text.startsWith("BASE"));
  assert.match(text, /已连续 3 步未记录思考链路/);
  assert.match(text, /当前阶段 act/);

  // 记完就自愈（这里顺便覆盖老日志里的 chain/note 兼容折叠）
  session.append("chain/note", { phase: "verify", note: "跑测试", next: "" });
  assert.equal(section.text({ agent }), "BASE");

  // 关键回归：不再注册 agent/pre-step（0.1.0 会往对话里插消息打扰用户）
  assert.equal(registered.hooks.has("agent/pre-step"), false);
});
