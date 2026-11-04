/**
 * 接线冒烟测试：用 mock ctx 驱动守卫体，验证注册形状、降级路径与
 * 「监听器绝不抛错」这条硬约束（SessionStore.announce 不隔离监听器异常）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, resolveKnownTypes } from "../lib/index.js";

function fakeSession() {
  const calls = [];
  return {
    calls,
    append(type, data, ...opts) {
      calls.push({ type, data, opts });
    },
  };
}

function createMockCtx(services = {}) {
  const registered = { hooks: new Map(), commands: [], logs: [], injected: [] };
  const store = {
    commands: { register: (def) => registered.commands.push(def) },
    ...services,
  };
  const ctx = {
    get: (name) => store[name],
    logger: { warn: (...a) => registered.logs.push(a), info: () => {} },
    effect: () => () => {},
    // cordis 语义：服务缺失时回调根本不会执行（不是拿到 undefined 再崩）
    inject: (names, fn) => {
      registered.injected.push(names);
      if (names.some((n) => store[n] === undefined || store[n] === null)) return;
      const child = { ...ctx };
      for (const n of names) child[n] = store[n];
      fn(child);
    },
    on: (name, handler) => {
      if (!registered.hooks.has(name)) registered.hooks.set(name, []);
      registered.hooks.get(name).push(handler);
    },
  };
  // declare `inject: [...]` 的插件拿到的是「服务已就位」的 ctx，
  // 所以 mock 也要把服务直接挂到根 ctx 上（守卫在 apply 里用 ctx.sessions 补挂既有会话）。
  for (const [key, value] of Object.entries(store)) {
    if (value !== undefined && value !== null) ctx[key] = value;
  }
  return { ctx, registered };
}

function sessionsService(entries = []) {
  return { store: new Map(entries.map((s, i) => [`s${i}`, { id: `s${i}`, session: s }])) };
}

const warnText = (registered) => registered.logs.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")).join("\n");

test("apply：注册 session/created 监听、补挂既有会话、注册 /session-guard 命令", async () => {
  const existing = fakeSession();
  const { ctx, registered } = createMockCtx({ sessions: sessionsService([existing]) });
  await apply(ctx, { candidates: ["/definitely/not/here"] }); // 强制降级，测试不依赖本机 DSH

  const hooks = registered.hooks.get("session/created");
  assert.equal(hooks?.length, 1, "应注册恰好一个 session/created 监听");

  assert.deepEqual(registered.injected, [["commands"]]);
  assert.equal(registered.commands.length, 1);
  assert.equal(registered.commands[0].name, "session-guard");
  const result = registered.commands[0].handler({});
  assert.equal(result.kind, "success");
  assert.match(result.text, /session-guard/u);
  assert.match(result.text, /已守卫 1 个会话/u, "既有会话应被补挂");
  assert.match(result.text, /warn-only/u, "定位不到词表时应报告 warn-only");
});

test("apply：定位不到宿主词表 ⇒ 降级告警，且未知类型不被阻断", async () => {
  const session = fakeSession();
  const { ctx, registered } = createMockCtx({ sessions: sessionsService([session]) });
  await apply(ctx, { candidates: ["/definitely/not/here"] });
  assert.match(warnText(registered), /只告警/u);
  assert.doesNotThrow(() => session.append("plan/node", {}));
  assert.equal(session.calls.length, 1, "降级模式下必须放行");
});

test("apply：session/created 监听器永不抛错（announce 不隔离异常）", async () => {
  const { ctx, registered } = createMockCtx({ sessions: sessionsService() });
  await apply(ctx, { candidates: ["/definitely/not/here"] });
  const listener = registered.hooks.get("session/created")[0];
  const hostile = {
    get append() {
      throw new Error("hostile getter");
    },
  };
  for (const value of [undefined, null, 42, {}, hostile, Object.freeze({ append() {} })]) {
    assert.doesNotThrow(() => listener(value), `监听器对 ${String(value)} 不应抛错`);
  }
});

test("apply：commands 服务缺失也能加载（守卫不依赖命令）", async () => {
  const { ctx, registered } = createMockCtx({ sessions: sessionsService(), commands: undefined });
  await assert.doesNotReject(() => apply(ctx, { candidates: ["/definitely/not/here"] }));
  assert.deepEqual(registered.commands, [], "没有 commands 服务就不该注册命令");
});

test("apply：真机路径 —— 宿主词表可读时未知类型 fail-closed", async (t) => {
  const known = await resolveKnownTypes();
  if (known === undefined) {
    t.skip("本机宿主词表不可读（官方桌面版在纯 node 下读不到 asar），跳过");
    return;
  }
  const session = fakeSession();
  const { ctx, registered } = createMockCtx({ sessions: sessionsService([session]) });
  await apply(ctx, {}); // 走自动探测

  const hooks = registered.hooks.get("session/created");
  const created = fakeSession();
  hooks[0](created);

  // 官方类型透传
  created.append("tool/call", { name: "chain_note" });
  assert.equal(created.calls.length, 1);

  // 历史踩雷的两种自定义类型必须被拦
  for (const type of ["plan/node", "chain/note", "plan/import", "gpt/consult"]) {
    assert.throws(() => created.append(type, {}), /session-guard 拒绝写入/u, `${type} 应被拦截`);
  }
  assert.equal(created.calls.length, 1, "被拦截的写入绝不能落到原 append");
  const status = registered.commands[0].handler({});
  assert.match(status.text, /已守卫 2 个会话/u);
  assert.match(status.text, /拦截 4 次/u);
  assert.match(status.text, /enforce/u);
});
