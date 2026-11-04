/**
 * 接线冒烟测试：mock ctx 驱动 gpt-consult——工具/命令/投影注册，
 * 缺 key 的错误路径（不触网），命令行为。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

function createSession() {
  const events = [];
  return {
    events,
    eventAt: (seq) => events.find((e) => e.seq === seq),
    append(type, data) {
      const seq = events.length + 1;
      events.push({ type, data, seq });
      return { seq };
    },
  };
}

function createMockCtx(services = {}) {
  const registered = { tools: [], projections: [], commands: [], hooks: new Map(), logs: [] };
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
    on: () => {},
    tools: { register: (def) => registered.tools.push(def) },
    systemPrompt: { section: () => {}, getSectionOrder: () => 500 },
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

// 用一个几乎不可能存在的外部变量名，保证测试不依赖真实环境里是否配了 key
const CONF = { apiKeyEnv: "GPT_CONSULT_TEST_KEY_ABSENT", baseURL: "http://127.0.0.1:1/v1", timeoutMs: 50 };

test("注册：consult_gpt 工具 + gpt 命令 + gpt 投影", () => {
  const { ctx, registered } = createMockCtx();
  apply(ctx, CONF);
  const tool = registered.tools.find((t) => t.name === "consult_gpt");
  assert.ok(tool !== undefined);
  assert.deepEqual(tool.parameters.required, ["question"]);
  assert.equal(typeof tool.execute, "function");
  const command = registered.commands.find((c) => c.name === "gpt");
  assert.ok(command !== undefined);
  const projection = registered.projections.find((p) => p.key === "gpt");
  assert.ok(projection !== undefined);
  assert.deepEqual(projection.wire.view(projection.init()), { count: 0, fails: 0, totalMs: 0, lastModel: "", lastAt: 0, lastOk: null });
});

test("consult_gpt execute：缺 key 时报错、不再往日志写事件", async () => {
  const { ctx, registered } = createMockCtx();
  apply(ctx, CONF);
  const tool = registered.tools.find((t) => t.name === "consult_gpt");
  const session = createSession();
  const agent = { session };
  await assert.rejects(tool.execute({ question: "q" }, {}), /calling agent/);
  await assert.rejects(tool.execute({ question: "q" }, { agent }), /GPT_CONSULT_TEST_KEY_ABSENT/);
  await assert.rejects(tool.execute({ question: "" }, { agent }), /invalid arguments/);
  await assert.rejects(tool.execute({ question: "q", extra: 1 }, { agent }), /unknown argument/);
  // 插件不再写自定义类型：统计改由官方的 tool/call + tool/result 折叠得到
  assert.equal(session.events.length, 0);
});

test("/gpt 命令：帮助 / status / 咨询失败", async () => {
  const { ctx, registered } = createMockCtx();
  apply(ctx, CONF);
  const command = registered.commands.find((c) => c.name === "gpt");
  const session = createSession();
  const agent = { session, inject: () => {}, steer: () => {} };

  const help = await command.handler({ agent, rawInput: "" });
  assert.match(help.text, /\/gpt <问题>/);

  const empty = await command.handler({ agent, rawInput: "status" });
  assert.match(empty.text, /还没有咨询记录/);

  const failed = await command.handler({ agent, rawInput: "解释一下幂等" });
  assert.equal(failed.kind, "error");
  assert.match(failed.text, /GPT_CONSULT_TEST_KEY_ABSENT/);

  // 命令路径失败不再留任何事件（老版本会写 gpt/consult），因此也不计数
  assert.equal(session.events.length, 0);
  const stats = await command.handler({ agent, rawInput: "status" });
  assert.match(stats.text, /还没有咨询记录/);
});

test("/gpt 命令：成功时把答案注入会话，投影从官方 user/message 计数", async () => {
  const { ctx, registered } = createMockCtx();
  const cfg = { ...CONF, apiKeyEnv: "PATH" }; // PATH 一定存在，只是值不是真 key
  apply(ctx, cfg);
  const command = registered.commands.find((c) => c.name === "gpt");
  const injected = [];
  const session = createSession();
  const agent = { session, inject: (m) => injected.push(m), steer: () => {} };

  // 打桩全局 fetch：本地假上游
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "GPT 的回答" } }], model: "gpt-test" }) });
  try {
    const result = await command.handler({ agent, rawInput: "给点建议" });
    assert.equal(result.kind, "success");
    assert.match(result.text, /已咨询 GPT/);
    assert.equal(injected.length, 1);
    assert.match(injected[0].content[0].text, /GPT 的回答/);
    assert.equal(injected[0].source.plugin, "gpt-consult");
    // 命令路径不再自己写日志：宿主把注入的通知落成 user/message，投影据此统计
    assert.equal(session.events.length, 0);
    session.append("user/message", injected[0]);
    const state = ctx.sessionProjections.stateOf(session, "gpt");
    assert.equal(state.count, 1);
    assert.equal(state.lastOk, true);
    assert.equal(state.lastModel, "gpt-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
