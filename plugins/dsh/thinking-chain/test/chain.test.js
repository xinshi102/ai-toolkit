import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PHASES,
  chainNoteOf,
  clipText,
  foldChain,
  initialChainState,
  isPhase,
  nudgeDecision,
  validateArgs,
} from "../lib/index.js";

test("clipText: 压平换行、去空白、超长截断", () => {
  assert.equal(clipText("  a\nb  ", 10), "a b");
  assert.equal(clipText("x".repeat(20), 5), "xxxxx…");
  assert.equal(clipText(42, 10), "");
  assert.equal(clipText(null, 10), "");
});

test("isPhase: 只认四个阶段", () => {
  assert.ok(isPhase("plan"));
  assert.ok(isPhase("done"));
  assert.ok(!isPhase("PLAN"));
  assert.ok(!isPhase(undefined));
  assert.ok(!isPhase(""));
});

test("foldChain: chain/note 重置步数并记录阶段", () => {
  let s = initialChainState();
  s = foldChain(s, { type: "step/start", data: {} });
  s = foldChain(s, { type: "step/start", data: {} });
  assert.equal(s.sinceNote, 2);
  assert.equal(s.phase, "plan");
  s = foldChain(s, { type: "chain/note", data: { phase: "act", note: "改 index.js", next: "跑测试" } });
  assert.equal(s.phase, "act");
  assert.equal(s.note, "改 index.js");
  assert.equal(s.next, "跑测试");
  assert.equal(s.sinceNote, 0);
  assert.equal(s.notes, 1);
  assert.equal(initialChainState().phase, "plan");
});

test("foldChain: 非法 phase 回退到上一阶段；note 截断", () => {
  let s = foldChain(initialChainState(), { type: "chain/note", data: { phase: "hack", note: "y".repeat(200) } });
  assert.equal(s.phase, "plan");
  assert.ok(s.note.length <= 121);
});

test("foldChain: 未知事件原样返回", () => {
  const s = initialChainState();
  assert.deepEqual(foldChain(s, { type: "whatever", data: {} }), s);
});

test("foldChain: chain/nudge 记录 lastNudgeSince", () => {
  let s = foldChain(initialChainState(), { type: "chain/nudge", data: { sinceNote: 4 } });
  assert.equal(s.nudges, 1);
  assert.equal(s.lastNudgeSince, 4);
});

/* ── 主路径：官方 tool/call（chain/note 自定义事件已停写） ─────────────── */

const toolCall = (args) => ({ type: "tool/call", seq: 9, data: { turn: 1, step: 1, callId: "c1", name: "chain_note", arguments: JSON.stringify(args) } });

test("chainNoteOf: 只认 chain_note 的 tool/call，参数非法返回 null", () => {
  const parsed = chainNoteOf(toolCall({ phase: "verify", note: " 跑测试 ", next: "收尾" }));
  assert.deepEqual(parsed, { phase: "verify", note: "跑测试", next: "收尾" });
  assert.equal(chainNoteOf({ type: "tool/call", data: { name: "plan_node", arguments: "{}" } }), null);
  assert.equal(chainNoteOf({ type: "tool/call", data: { name: "chain_note", arguments: "{oops" } }), null);
  assert.equal(chainNoteOf({ type: "tool/call", data: { name: "chain_note", arguments: JSON.stringify({ phase: "hack", note: "x" }) } }), null);
  assert.equal(chainNoteOf({ type: "tool/call", data: { name: "chain_note", arguments: JSON.stringify({ phase: "act", note: "   " }) } }), null);
  assert.equal(chainNoteOf({ type: "tool/result", data: {} }), null);
  assert.equal(chainNoteOf(undefined), null);
});

test("foldChain: 官方 tool/call 重置步数、累加次数（主路径）", () => {
  let s = initialChainState();
  for (let i = 0; i < 4; i++) s = foldChain(s, { type: "step/start", data: {} });
  assert.equal(s.sinceNote, 4);
  s = foldChain(s, toolCall({ phase: "act", note: "改 index.js", next: "跑测试" }));
  assert.equal(s.phase, "act");
  assert.equal(s.note, "改 index.js");
  assert.equal(s.next, "跑测试");
  assert.equal(s.sinceNote, 0);
  assert.equal(s.notes, 1);
});

test("foldChain: 老日志的 chain/note / chain/nudge 仍兼容（不丢历史链路）", () => {
  let s = foldChain(initialChainState(), toolCall({ phase: "act", note: "新写法" }));
  s = foldChain(s, { type: "chain/note", data: { phase: "verify", note: "老写法", next: "" } });
  assert.equal(s.phase, "verify");
  assert.equal(s.note, "老写法");
  assert.equal(s.notes, 2);
});

test("foldChain: 过渡期双写去重（老插件下 tool/call + chain/note 是同一个记录）", () => {
  const args = { phase: "act", note: "改代码", next: "跑测试" };
  let s = foldChain(initialChainState(), toolCall(args));
  assert.equal(s.notes, 1);
  // 老插件在 execute 里紧接着补写同一条 chain/note → 不重复计数
  s = foldChain(s, { type: "chain/note", data: args });
  assert.equal(s.notes, 1);
  // 中间走过 step 后再来一条同内容的老事件 → 那是真记录，照常计数
  s = foldChain(s, { type: "step/start", data: {} });
  s = foldChain(s, { type: "chain/note", data: args });
  assert.equal(s.notes, 2);
  // 内容不同的老事件也照常计数
  s = foldChain(s, { type: "chain/note", data: { phase: "verify", note: "另一条", next: "" } });
  assert.equal(s.notes, 3);
});

test("nudgeDecision: 只有用过 chain_note 的会话才提醒，且步数限幅", () => {
  const base = { phase: "act", sinceNote: 4, notes: 2 };
  assert.ok(nudgeDecision(base, 3) !== null);
  assert.equal(nudgeDecision({ ...base, notes: 0 }, 3), null);      // 从未用过 → 不打扰（0.1.0 的 bug）
  assert.equal(nudgeDecision({ ...base, sinceNote: 2 }, 3), null);  // 未到阈值
  assert.equal(nudgeDecision({ ...base, phase: "done" }, 3), null); // 已收尾
  assert.equal(nudgeDecision(base, 0), null);                       // 关闭
  const long = nudgeDecision({ ...base, sinceNote: 250 }, 3);
  assert.match(long.text, /已连续 9\+ 步/);                          // 限幅：不再出现「250 步」
  assert.equal(long.sinceNote, 250);                                // 真实值仍保留给调用方
});

test("validateArgs: 缺参 / 多参 / 类型 / 枚举", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { phase: { type: "string", enum: PHASES }, note: { type: "string" } },
    required: ["phase", "note"],
  };
  assert.deepEqual(validateArgs(schema, { phase: "plan", note: "x" }), []);
  assert.deepEqual(validateArgs(schema, { phase: "plan" }), ['missing "note"']);
  assert.deepEqual(validateArgs(schema, { phase: "plan", note: "x", extra: 1 }), ['unknown argument "extra"']);
  assert.deepEqual(validateArgs(schema, { phase: "x", note: 1 }), ['"phase" must be one of plan|act|verify|done', '"note" must be a string']);
  assert.deepEqual(validateArgs(schema, null), ["arguments must be an object"]);
});
