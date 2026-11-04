/**
 * 接线冒烟测试：mock ctx 驱动 token-lever，验证 surface 重写遵守
 * shadow-price 契约（compaction/prune 紧邻 replace）、keepRecent 保护、
 * 统计投影与 /lever 命令。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRUNE_MARK, apply } from "../lib/index.js";

function createSession() {
  const events = [];
  const nodes = [];
  let replaceGeneration = 0;
  return {
    events,
    surface: {
      nodes,
      get replaceGeneration() { return replaceGeneration; },
    },
    eventAt: (seq) => events.find((e) => e.seq === seq),
    append(type, data, opts) {
      const seq = events.length + 1;
      events.push({ type, data, seq, surfaceOp: opts?.surfaceOp, sourceEventSeqs: opts?.sourceEventSeqs });
      // 模拟官方 surface 语义：append 入面；replace 用新事件替换范围内的旧事件
      if (opts?.surfaceOp === "append") nodes.push(seq);
      else if (opts?.surfaceOp !== undefined && typeof opts.surfaceOp === "object" && opts.surfaceOp.op === "replace") {
        const { startSeq, endSeq } = opts.surfaceOp;
        const idx = nodes.indexOf(startSeq);
        if (idx >= 0) nodes.splice(idx, endSeq - startSeq + 1, seq);
        replaceGeneration += 1;
      }
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
    commands: { register: (def) => registered.commands.push(def) },
  };
  ctx.__setService = (name, value) => { store[name] = value; };  // 模拟服务在插件加载之后才注册
  return { ctx, registered };
}

const meter = { estimateMessage: (m) => Math.ceil(JSON.stringify(m).length / 4) };

function toolResultEvent(session, text) {
  const seq = session.events.length + 1;
  session.append("tool/result", {
    message: { role: "user", content: [{ type: "tool_result", callId: `c${seq}`, content: [{ type: "text", text }] }], source: { callId: `c${seq}` } },
  }, { surfaceOp: "append" });
  return seq;
}

test("meter 晚到也能生效（不再在 apply 时一次性自禁用）", async () => {
  const { ctx, registered } = createMockCtx();
  apply(ctx, { keepRecent: 1, thresholdChars: 4096 });
  // 加载时还没有 meter：投影与命令照样注册（旧版会直接 return，什么都没注册）
  assert.ok(registered.projections.some((p) => p.key === "tokenLever"), "投影必须注册");
  assert.ok(registered.commands.some((c) => c.name === "lever"), "命令必须注册");
  assert.ok(registered.hooks.has("agent/pre-step"), "pre-step 必须挂上");

  const hook = registered.hooks.get("agent/pre-step")[0];
  const session = createSession();
  toolResultEvent(session, "x".repeat(9000));
  toolResultEvent(session, "small");
  const decision = { kind: "enter", messages: [] };

  // 没有 meter：不动请求面（shadow-price 契约不能打折）
  await hook({ agent: { session }, signal: { aborted: false } }, async () => decision);
  assert.ok(!session.events.some((e) => e.type === "compaction/prune"), "无 meter 时不得重写");

  // meter 后到：同一会话再走一步，就应该开始修剪
  ctx.__setService("tokenMeter", meter);
  await hook({ agent: { session }, signal: { aborted: false } }, async () => decision);
  assert.ok(session.events.some((e) => e.type === "compaction/prune"), "meter 到位后必须生效");
});

test("pre-step：只重写陈旧大结果，紧邻 shadow-price，最近条不动", async () => {
  const { ctx, registered } = createMockCtx({ tokenMeter: meter });
  apply(ctx, { keepRecent: 2, thresholdChars: 4096, headChars: 512, tailChars: 256 });
  const hook = registered.hooks.get("agent/pre-step")[0];
  const session = createSession();
  const bigA = "a".repeat(9000); // 唯一内容 → 走裁剪
  const bigB = "b".repeat(9000); // 与 seq4 同内容 → 走去重
  toolResultEvent(session, bigA); // 1 旧大唯一 → 裁
  toolResultEvent(session, bigB); // 2 旧大且是 4 的副本 → 去重
  toolResultEvent(session, "small"); // 3 旧小 → 不动
  toolResultEvent(session, bigB); // 4 最近 → 不动（保留完整副本）
  toolResultEvent(session, "small"); // 5 最近 → 不动
  const decision = { kind: "enter", messages: [] };
  const out = await hook({ agent: { session }, signal: { aborted: false } }, async () => decision);
  assert.equal(out, decision); // 不改写 decision 本身
  const kinds = session.events.map((e) => e.type);
  assert.ok(kinds.includes("compaction/prune"));
  // 只写官方类型：不再有自定义的 token/lever 事件（宿主不认它，会让会话打不开）
  assert.deepEqual([...new Set(kinds)].sort(), ["compaction/prune", "tool/result"]);
  // shadow-price 与 replace 紧邻成对，且 range 一致
  for (let i = 0; i < session.events.length; i++) {
    const ev = session.events[i];
    if (ev.type === "compaction/prune") {
      const next = session.events[i + 1];
      assert.equal(next.type, "tool/result");
      assert.deepEqual(next.surfaceOp, { op: "replace", startSeq: ev.data.shadowedRange.start, endSeq: ev.data.shadowedRange.end });
      assert.deepEqual(next.sourceEventSeqs, [ev.data.shadowedRange.start]);
    }
  }
  // 投影折叠这些官方事件得到统计；本批次增量要等下一条不属于本批次的事件才确认
  session.append("step/start", { turn: 1, step: 1 });
  const state = ctx.sessionProjections.stateOf(session, "tokenLever");
  assert.equal(state.spans, 2);
  assert.equal(state.deduped, 1);
  assert.equal(state.pruned, 1);
  assert.equal(state.runs, 1);
  assert.ok(state.charsAfter > 0);
  assert.equal(state.charsBefore, 0); // 官方事件不给被替换内容的字符数
  assert.ok(state.tokensBefore > state.tokensAfter);
});

test("pre-step：第二次进入是幂等的（无可裁对象）", async () => {
  const { ctx, registered } = createMockCtx({ tokenMeter: meter });
  apply(ctx, { keepRecent: 1, thresholdChars: 4096 });
  const hook = registered.hooks.get("agent/pre-step")[0];
  const session = createSession();
  toolResultEvent(session, "x".repeat(9000));
  toolResultEvent(session, "y".repeat(9000));
  const decision = { kind: "enter", messages: [] };
  await hook({ agent: { session }, signal: { aborted: false } }, async () => decision);
  const count = session.events.length;
  await hook({ agent: { session }, signal: { aborted: false } }, async () => decision);
  assert.equal(session.events.length, count);
});

test("pre-step：抛错不冒泡（记录警告后放行）", async () => {
  const brokenSurface = {
    nodes: [1],
    eventAt: () => { throw new Error("boom"); },
  };
  const { ctx, registered } = createMockCtx({ tokenMeter: meter });
  apply(ctx, {});
  const hook = registered.hooks.get("agent/pre-step")[0];
  const decision = { kind: "enter", messages: [] };
  const out = await hook({ agent: { session: brokenSurface }, signal: { aborted: false } }, async () => decision);
  assert.equal(out, decision);
  assert.ok(registered.logs.length > 0);
});

test("/lever 命令：空统计与历史 token/lever 事件的兼容折叠", async () => {
  const { ctx, registered } = createMockCtx({ tokenMeter: meter });
  apply(ctx, {});
  const command = registered.commands.find((c) => c.name === "lever");
  const session = createSession();
  const empty = await command.handler({ agent: { session } });
  assert.match(empty.text, /还没有修剪/);
  // 老日志里已经存在的自定义事件：新版不再写，但必须继续折叠
  session.append("token/lever", { spans: 3, deduped: 1, pruned: 2, charsBefore: 9000, charsAfter: 1000, tokensBefore: 3000, tokensAfter: 350 });
  const full = await command.handler({ agent: { session } });
  assert.match(full.text, /3 处重写/);
  assert.match(full.text, /省 ~2650/);
});

test("/lever 命令：新折叠路径（官方 compaction/prune + replacement）也统计", async () => {
  const { ctx, registered } = createMockCtx({ tokenMeter: meter });
  apply(ctx, {});
  const command = registered.commands.find((c) => c.name === "lever");
  const session = createSession();
  session.append("compaction/prune", { shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [1], shadowedTokenCount: 4000 });
  session.append("tool/result", {
    message: { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: PRUNE_MARK }] }], source: { kind: "tool", callId: "c1" } },
  }, { surfaceOp: { op: "replace", startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] });
  session.append("step/start", { turn: 1, step: 1 }); // 下一条事件确认本批次
  const out = await command.handler({ agent: { session } });
  assert.match(out.text, /1 处重写/);
  assert.match(out.text, /去重 0 \/ 裁剪 1/);
  assert.match(out.text, /省 ~\d+/);
});
