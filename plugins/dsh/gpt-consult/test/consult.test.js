import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestBody,
  consult,
  extractAnswer,
  foldGpt,
  initialGptState,
  resolveApiKey,
  resolveConfig,
} from "../lib/index.js";

test("resolveConfig: 默认值 / 清洗 / 非法回退", () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.baseURL, "https://api.openai.com/v1");
  assert.equal(cfg.model, "gpt-5");
  assert.equal(cfg.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(cfg.timeoutMs, 60000);
  assert.equal(resolveConfig({ baseURL: "https://x.dev/v1///" }).baseURL, "https://x.dev/v1");
  assert.equal(resolveConfig({ apiKeyEnv: "bad-name" }).apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(resolveConfig({ model: "  " }).model, "gpt-5");
  assert.equal(resolveConfig({ timeoutMs: -5 }).timeoutMs, 60000);
});

test("resolveApiKey: 缺失/空/含换行 的错误信息不回显 key", () => {
  const cfg = resolveConfig({});
  const missing = resolveApiKey(cfg, {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /OPENAI_API_KEY/);
  assert.equal(resolveApiKey(cfg, { OPENAI_API_KEY: "sk-test" }).ok, true);
  assert.equal(resolveApiKey(cfg, { OPENAI_API_KEY: "  " }).ok, false);
  const bad = resolveApiKey(cfg, { OPENAI_API_KEY: "sk-a\nb" });
  assert.equal(bad.ok, false);
  assert.ok(!bad.error.includes("sk-a"));
  // 自定义 env 名
  assert.equal(resolveApiKey(resolveConfig({ apiKeyEnv: "MY_KEY" }), { MY_KEY: "k" }).ok, true);
});

test("buildRequestBody: 无 context 时两段消息，有 context 时拼接", () => {
  const cfg = resolveConfig({});
  const a = buildRequestBody(cfg, { question: "这个方案对吗？" });
  assert.equal(a.model, "gpt-5");
  assert.equal(a.messages.length, 2);
  assert.equal(a.messages[0].role, "system");
  assert.equal(a.messages[1].content, "这个方案对吗？");
  const b = buildRequestBody(cfg, { question: "q", context: "代码摘录" });
  assert.ok(b.messages[1].content.includes("代码摘录"));
  assert.ok(b.messages[1].content.includes("上下文"));
});

test("buildRequestBody: 超长问题与上下文截断", () => {
  const cfg = resolveConfig({ maxContextChars: 10 });
  const body = buildRequestBody(cfg, { question: "q".repeat(9000), context: "c".repeat(500) });
  assert.ok(body.messages[1].content.length < 8100);
  assert.ok(body.messages[1].content.includes("c".repeat(10)));
  assert.ok(!body.messages[1].content.includes("c".repeat(50)));
});

test("extractAnswer: 正常 / 缺 content / 上游错误", () => {
  const ok = extractAnswer({ choices: [{ message: { content: "答：可以" } }], model: "gpt-5", usage: { total_tokens: 42 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.answer, "答：可以");
  assert.equal(ok.usage.total_tokens, 42);
  assert.equal(extractAnswer({}).ok, false);
  const err = extractAnswer({ error: { message: "rate limited" } });
  assert.equal(err.ok, false);
  assert.match(err.error, /rate limited/);
});

test("foldGpt: 累计次数/失败/耗时，未知事件原样", () => {
  let s = initialGptState();
  s = foldGpt(s, { type: "gpt/consult", data: { ok: true, model: "gpt-5", ms: 1200, at: 111 } });
  s = foldGpt(s, { type: "gpt/consult", data: { ok: false, model: "gpt-5", ms: 50, at: 222 } });
  assert.equal(s.count, 2);
  assert.equal(s.fails, 1);
  assert.equal(s.totalMs, 1250);
  assert.equal(s.lastModel, "gpt-5");
  assert.equal(s.lastAt, 222);
  assert.equal(s.lastOk, false);
  assert.deepEqual(foldGpt(s, { type: "other", data: {} }), s);
});

/* ── 新折叠路径：官方事件（tool/call + tool/result + user/message） ──────── */

function toolCallEvent(seq, callId, time = 1000, name = "consult_gpt") {
  return { seq, time, type: "tool/call", data: { turn: 1, step: 1, callId, name, arguments: "{}" } };
}

function toolResultEvent(seq, callId, text, time = 2000, isError = false) {
  return {
    seq,
    time,
    type: "tool/result",
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "user",
        content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }], isError }],
        source: { kind: "tool", callId },
      },
    },
  };
}

test("foldGpt: 折叠 tool/call + 配对的 tool/result 得到次数/模型/耗时", () => {
  let s = foldGpt(initialGptState(), toolCallEvent(1, "c1", 1000));
  assert.equal(s.count, 1);
  s = foldGpt(s, toolResultEvent(2, "c1", "【GPT · gpt-5-mini · 1200ms】\n答案", 2400));
  assert.equal(s.count, 1);
  assert.equal(s.fails, 0);
  assert.equal(s.totalMs, 1200);
  assert.equal(s.lastModel, "gpt-5-mini");
  assert.equal(s.lastAt, 2400);
  assert.equal(s.lastOk, true);
  assert.equal(s.pendingCall, null);
});

test("foldGpt: 失败结果记失败；头行认不出来时退回两条事件的 time 差", () => {
  let s = foldGpt(initialGptState(), toolCallEvent(1, "c9", 1000));
  s = foldGpt(s, toolResultEvent(2, "c9", "Error: 未找到 API key", 1500, true));
  assert.equal(s.count, 1);
  assert.equal(s.fails, 1);
  assert.equal(s.totalMs, 500);
  assert.equal(s.lastOk, false);
  assert.equal(s.lastModel, "");
});

test("foldGpt: 别的工具调用与结果不影响统计", () => {
  const s = initialGptState();
  assert.equal(foldGpt(s, toolCallEvent(1, "b1", 1000, "bash")), s);
  assert.equal(foldGpt(s, toolResultEvent(2, "b1", "输出")), s);
  // 没有 tool/call 的孤立结果也不算
  assert.equal(foldGpt(s, toolResultEvent(3, "c1", "【GPT · gpt-5 · 10ms】\nx")), s);
});

test("foldGpt: 老日志（官方事件 + gpt/consult 并存）不重复计数", () => {
  let s = foldGpt(initialGptState(), toolCallEvent(1, "c1", 1000));
  s = foldGpt(s, { seq: 2, time: 1100, type: "gpt/consult", data: { ok: true, model: "gpt-5", ms: 900, at: 1100 } });
  assert.equal(s.pendingCall.covered, true);
  s = foldGpt(s, toolResultEvent(3, "c1", "【GPT · gpt-5 · 900ms】\n答案", 1100));
  assert.equal(s.count, 1); // 不是 2
  assert.equal(s.totalMs, 900); // 也不是 1800
  assert.equal(s.lastModel, "gpt-5");
  assert.equal(s.pendingCall, null);
});

test("foldGpt: 命令路径折叠 user/message，且不与老 gpt/consult 重复", () => {
  const notice = (seq, time) => ({
    seq,
    time,
    type: "user/message",
    data: {
      role: "user",
      content: [{ type: "text", text: "【GPT · gpt-5】\n答案" }],
      source: { kind: "plugin", plugin: "gpt-consult", form: "notice", summary: "GPT 第二意见" },
    },
  });
  let s = foldGpt(initialGptState(), { seq: 1, time: 10, type: "gpt/consult", data: { ok: true, model: "gpt-5", ms: 700, at: 10 } });
  assert.equal(s.count, 1);
  assert.equal(s.legacyNoticeBacklog, 1);
  s = foldGpt(s, notice(2, 20));
  assert.equal(s.count, 1); // 老日志里同一次咨询的注入通知不再计一遍
  assert.equal(s.legacyNoticeBacklog, 0);
  s = foldGpt(s, notice(3, 30));
  assert.equal(s.count, 2); // 新日志没有 gpt/consult，靠通知计数
  assert.equal(s.lastAt, 30);
  assert.equal(s.lastOk, true);
  assert.equal(s.lastModel, "gpt-5");
  // 别的插件注入的通知不算
  const other = { seq: 4, time: 40, type: "user/message", data: { content: [], source: { kind: "plugin", plugin: "other-plugin", form: "notice" } } };
  assert.equal(foldGpt(s, other), s);
});

test("consult: 无 key 直接失败（不触网）", async () => {
  const cfg = resolveConfig({});
  const r = await consult(cfg, { question: "q" }, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /OPENAI_API_KEY/);
});

test("consult: HTTP 非 2xx 返回上游状态", async () => {
  const cfg = resolveConfig({});
  const fakeFetch = async () => ({ ok: false, status: 429, text: async () => "rate limited" });
  const r = await consult(cfg, { question: "q" }, { OPENAI_API_KEY: "k" }, fakeFetch);
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 429/);
});

test("consult: 成功路径带 model 与 ms", async () => {
  const cfg = resolveConfig({});
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(init.headers.authorization, "Bearer k");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-5");
    assert.equal(body.messages[1].content, "你好");
    return { ok: true, json: async () => ({ choices: [{ message: { content: "你好！" } }], model: "gpt-5-mini" }) };
  };
  const r = await consult(cfg, { question: "你好" }, { OPENAI_API_KEY: "k" }, fakeFetch);
  assert.equal(r.ok, true);
  assert.equal(r.answer, "你好！");
  assert.equal(r.model, "gpt-5-mini");
  assert.ok(Number.isFinite(r.ms));
});

test("consult: 超时映射为友好错误", async () => {
  const cfg = resolveConfig({ timeoutMs: 10 });
  const fakeFetch = async () => {
    const err = new Error("aborted");
    err.name = "TimeoutError";
    throw err;
  };
  const r = await consult(cfg, { question: "q" }, { OPENAI_API_KEY: "k" }, fakeFetch);
  assert.equal(r.ok, false);
  assert.match(r.error, /超时/);
});
