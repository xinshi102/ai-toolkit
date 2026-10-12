import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEDUPE_MARKER,
  PRUNE_MARK,
  codePointLength,
  foldLever,
  hashText,
  initialLeverState,
  leverOpKind,
  planOperations,
  pruneBlocks,
  resolveConfig,
  resultBlocks,
  textOfBlocks,
} from "../lib/index.js";

function toolResultEvent(seq, text, callId = `call_${seq}`) {
  return {
    seq,
    type: "tool/result",
    data: {
      message: {
        role: "user",
        content: [{ type: "tool_result", callId, content: [{ type: "text", text }] }],
        source: { callId },
      },
    },
  };
}

test("textOfBlocks: 按码点计文本块，非文本块计 0", () => {
  assert.equal(textOfBlocks([{ type: "text", text: "abc" }, { type: "image", url: "x" }]), 3);
  assert.equal(textOfBlocks([]), 0);
  assert.equal(codePointLength("🚀🚀"), 2);
});

test("resultBlocks: 深入 tool_result 内容块", () => {
  const ev = toolResultEvent(1, "hello");
  assert.deepEqual(resultBlocks(ev), [{ type: "text", text: "hello" }]);
});

test("pruneBlocks: 未超有效阈值返回 null", () => {
  const blocks = [{ type: "text", text: "A".repeat(100) + "B".repeat(100) + "C".repeat(100) }];
  // 头 10 + 尾 10 + 32 = 52 < 300，应触发裁剪；这里验证小文本不触发
  assert.equal(pruneBlocks([{ type: "text", text: "a".repeat(40) }], 10, 10), null);
});

test("pruneBlocks: 300 字符、头 10 尾 10 → 触发裁剪", () => {
  const blocks = [{ type: "text", text: "A".repeat(100) + "B".repeat(100) + "C".repeat(100) }];
  const pruned = pruneBlocks(blocks, 10, 10);
  assert.ok(pruned !== null);
  const out = pruned[0].text;
  assert.ok(out.startsWith("A".repeat(10)));
  assert.ok(out.endsWith("C".repeat(10)));
  assert.ok(out.includes("token-lever: 中段已裁剪"));
  assert.ok(textOfBlocks(pruned) < 300);
});

test("pruneBlocks: 非文本块原样保留", () => {
  const blocks = [
    { type: "text", text: "x".repeat(200) },
    { type: "image", url: "data:..." },
    { type: "text", text: "y".repeat(200) },
  ];
  const pruned = pruneBlocks(blocks, 20, 20);
  assert.ok(pruned.some((b) => b.type === "image"));
});

test("hashText: 稳定且区分大小", () => {
  assert.equal(hashText("abc"), hashText("abc"));
  assert.notEqual(hashText("abc"), hashText("abd"));
});

test("resolveConfig: 默认值 / 非法值报错 / 头尾和阈值约束", () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.keepRecent, 4);
  assert.equal(cfg.thresholdChars, 4096);
  assert.equal(cfg.dedupe, true);
  assert.throws(() => resolveConfig({ keepRecent: -1 }), /keepRecent/);
  assert.throws(() => resolveConfig({ headChars: 4000, tailChars: 4000, thresholdChars: 4096 }), /thresholdChars/);
});

test("planOperations: 最近 keepRecent 条永不动", () => {
  const results = [1, 2, 3, 4, 5].map((s) => ({ seq: s, event: toolResultEvent(s, "x".repeat(9000)) }));
  const ops = planOperations(results, resolveConfig({ keepRecent: 2 }));
  assert.deepEqual(ops.map((o) => o.seq), [1, 2, 3]);
});

test("planOperations: 小于阈值不裁", () => {
  const results = [1, 2, 3, 4, 5].map((s) => ({ seq: s, event: toolResultEvent(s, "small") }));
  const ops = planOperations(results, resolveConfig({}));
  assert.deepEqual(ops, []);
});

test("planOperations: 相同内容折叠成一行标记，保留最新", () => {
  const dup = "z".repeat(5000);
  const results = [
    { seq: 1, event: toolResultEvent(1, dup) },
    { seq: 2, event: toolResultEvent(2, "other".repeat(100)) },
    { seq: 3, event: toolResultEvent(3, dup) },
    { seq: 4, event: toolResultEvent(4, dup) },
  ];
  const ops = planOperations(results, resolveConfig({ keepRecent: 1 }));
  const dedupes = ops.filter((o) => o.kind === "dedupe");
  assert.equal(dedupes.length, 2); // seq1、seq3 都是旧副本
  assert.ok(dedupes.some((o) => o.seq === 1));
  assert.ok(dedupes.some((o) => o.seq === 3));
  assert.ok(dedupes.every((o) => o.blocks[0].text.includes("第 4 步"))); // 都指向最新副本
  assert.ok(!ops.some((o) => o.seq === 2)); // other 内容太小，不裁
  assert.ok(!ops.some((o) => o.seq === 4)); // 最新 + keepRecent 保护
});

test("planOperations: 关闭 dedupe 时不折叠", () => {
  const dup = "z".repeat(5000);
  const results = [
    { seq: 1, event: toolResultEvent(1, dup) },
    { seq: 2, event: toolResultEvent(2, dup) },
    { seq: 3, event: toolResultEvent(3, dup) },
  ];
  const ops = planOperations(results, resolveConfig({ dedupe: false, keepRecent: 1 }));
  assert.ok(ops.every((o) => o.kind === "prune"));
});

test("planOperations: maxOpsPerStep 上限", () => {
  const results = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => ({ seq: s, event: toolResultEvent(s, "x".repeat(9000)) }));
  const ops = planOperations(results, resolveConfig({ keepRecent: 0, maxOpsPerStep: 3 }));
  assert.equal(ops.length, 3);
});

/* ── 统计投影的新折叠路径（官方 compaction/prune + 自己写的 replacement） ── */

function pruneEvent(seq, start, tokens, time = 100) {
  return {
    seq,
    time,
    type: "compaction/prune",
    data: { shadowedRange: { start, end: start }, shadowedSeqs: [start], shadowedTokenCount: tokens },
  };
}

function replacementEvent(seq, start, blocks, time = 110) {
  const callId = `c${start}`;
  return {
    seq,
    time,
    type: "tool/result",
    surfaceOp: { op: "replace", startSeq: start, endSeq: start },
    sourceEventSeqs: [start],
    data: {
      message: {
        role: "user",
        content: [{ type: "tool-result", toolCallId: callId, content: blocks }],
        source: { kind: "tool", callId },
      },
    },
  };
}

test("leverOpKind: 认自己的标记，不认官方 pruner 的标记", () => {
  assert.equal(leverOpKind([{ type: "text", text: `head${PRUNE_MARK}tail` }]), "prune");
  assert.equal(leverOpKind([{ type: "text", text: DEDUPE_MARKER.replace("{seq}", "7") }]), "dedupe");
  assert.equal(leverOpKind([{ type: "text", text: "\n\n[... tool result middle pruned ...]\n\n" }]), null);
  assert.equal(leverOpKind([{ type: "text", text: "普通结果" }]), null);
});

test("foldLever: 折叠自己的 compaction/prune + replacement，批次确认后才计入", () => {
  const estimate = () => 42;
  let s = foldLever(initialLeverState(), pruneEvent(1, 10, 3000), estimate);
  s = foldLever(s, replacementEvent(2, 10, [{ type: "text", text: `head${PRUNE_MARK}tail` }]), estimate);
  // 本批次增量先攒着：要么等下一条非本批次事件确认，要么被老的 token/lever 汇总顶掉
  assert.equal(s.spans, 0);
  assert.equal(s.pendingRun.spans, 1);
  s = foldLever(s, { seq: 3, time: 120, type: "step/start", data: {} }, estimate);
  assert.equal(s.spans, 1);
  assert.equal(s.pruned, 1);
  assert.equal(s.deduped, 0);
  assert.equal(s.runs, 1);
  assert.equal(s.tokensBefore, 3000);
  assert.equal(s.tokensAfter, 42);
  assert.equal(s.charsAfter, codePointLength(`head${PRUNE_MARK}tail`));
  assert.equal(s.charsBefore, 0); // 官方事件里没有被替换内容的字符数
  assert.equal(s.pendingPrune, null);
  assert.equal(s.pendingRun, null);
});

test("foldLever: 去重标记记进 deduped", () => {
  let s = foldLever(initialLeverState(), pruneEvent(1, 10, 100));
  s = foldLever(s, replacementEvent(2, 10, [{ type: "text", text: DEDUPE_MARKER.replace("{seq}", "4") }]), () => 7);
  s = foldLever(s, { seq: 3, type: "turn/end", data: {} });
  assert.equal(s.spans, 1);
  assert.equal(s.deduped, 1);
  assert.equal(s.pruned, 0);
  assert.equal(s.tokensAfter, 7);
});

test("foldLever: 官方 pruner 的 compaction/prune 不算在本插件头上", () => {
  const estimate = () => 1;
  let s = foldLever(initialLeverState(), pruneEvent(1, 5, 9999));
  s = foldLever(s, replacementEvent(2, 5, [{ type: "text", text: "\n\n[... tool result middle pruned ...]\n\n" }]), estimate);
  assert.equal(s.pendingPrune, null);
  s = foldLever(s, { seq: 3, type: "turn/end", data: {} }, estimate);
  assert.equal(s.spans, 0);
  assert.equal(s.runs, 0);
  assert.equal(s.tokensBefore, 0);
  assert.equal(s.tokensAfter, 0);
});

test("foldLever: 老日志的 token/lever 汇总保留，且不与同批次 compaction/prune 重复", () => {
  let s = initialLeverState();
  s = foldLever(s, pruneEvent(1, 10, 3000));
  s = foldLever(s, replacementEvent(2, 10, [{ type: "text", text: PRUNE_MARK }]), () => 111);
  s = foldLever(s, { seq: 3, type: "token/lever", data: { spans: 1, deduped: 0, pruned: 1, charsBefore: 9000, charsAfter: 1000, tokensBefore: 3000, tokensAfter: 350 } });
  assert.equal(s.spans, 1); // 不是 2
  assert.equal(s.pruned, 1);
  assert.equal(s.runs, 1);
  assert.equal(s.charsBefore, 9000);
  assert.equal(s.charsAfter, 1000);
  assert.equal(s.tokensBefore, 3000);
  assert.equal(s.tokensAfter, 350);
  assert.equal(s.pendingRun, null);
  // 汇总之后的新批次（新版本只写 compaction/prune）照常确认
  s = foldLever(s, pruneEvent(4, 11, 100));
  s = foldLever(s, replacementEvent(5, 11, [{ type: "text", text: PRUNE_MARK }]), () => 10);
  s = foldLever(s, { seq: 6, type: "step/start", data: {} });
  assert.equal(s.spans, 2);
  assert.equal(s.runs, 2);
  assert.equal(s.tokensBefore, 3100);
  assert.equal(s.tokensAfter, 360);
});

test("foldLever: 无关事件原样返回，缺 estimate 时 tokensAfter 记 0", () => {
  const s = initialLeverState();
  assert.equal(foldLever(s, { seq: 1, type: "turn/start", data: {} }), s);
  let next = foldLever(s, pruneEvent(1, 10, 500));
  next = foldLever(next, replacementEvent(2, 10, [{ type: "text", text: PRUNE_MARK }]));
  next = foldLever(next, { seq: 3, type: "turn/end", data: {} });
  assert.equal(next.spans, 1);
  assert.equal(next.tokensBefore, 500);
  assert.equal(next.tokensAfter, 0);
});
