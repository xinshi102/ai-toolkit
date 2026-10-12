/**
 * @local/dsh-token-lever — 主机侧：省 token，不掉性能。
 *
 * 原理（与官方 compaction-tool-result-pruner 同一套 surface 机制）：
 * 每步请求前（agent/pre-step）扫描会话「请求面」里的 tool/result 节点：
 *   1. 去重：内容与更新的某条完全相同的旧结果 → 折叠成一行标记（保留 callId 等元数据）；
 *   2. 老化：最近 keepRecent 条之外、超过 thresholdChars 的结果 → 保头尾裁剪中段，
 *      标记说明原文仍在日志、可重跑工具恢复。
 * 全部重写都遵守 token-meter 的 shadow-price 契约：紧邻 replace 之前追加
 * compaction/prune 事件，用 tokenMeter.estimateMessage 给原消息定价——计数与
 * meter 同源，投影不漂移。
 *
 * 会话日志只写官方事件类型（宿主 dsh-session 的 KNOWN_SESSION_EVENT_TYPES）：
 * 重写照旧写 compaction/prune + surface replace 的 tool/result，但不再追加自定义
 * 的 token/lever 汇总（自定义类型会让宿主 dsh-session-persistence 的
 * validateStoredEvents 整份拒读，会话从此打不开）。统计投影改为折叠自己写的
 * compaction/prune 与紧随其后的那条 replacement，并继续折叠老日志里的 token/lever
 * 事件。官方 compaction-tool-result-pruner 写出的 compaction/prune 形状与本插件
 * 完全相同，所以归属靠「紧随的 replacement 内容里带本插件标记」判定。
 * 老日志每个批次既有一串 compaction/prune 又有一条 token/lever 汇总，为避免同一次
 * 重写被计两遍，投影把本批次的增量先攒在 pendingRun 里，直到看见下一条不属于本批次
 * 的事件才确认（见到 token/lever 汇总则整批丢弃）。
 *
 * 投影里不再可得的字段（view 形状不变，只降级取值）：
 *  - charsBefore：官方事件不记录被替换内容的字符数（shadow-price 只给 token 数），
 *    官方 token-meter 投影同样为了有界状态不保留逐节点价格，故恒为 0；
 *  - runs：老日志按 token/lever 事件计数，新日志按确认下来的重写批次计数。
 *
 * 为什么不掉性能：只动「陈旧/重复」的结果；模型正在用的最近 keepRecent 条不动；
 * 头尾保留（头通常是结构/结论，尾通常是错误与总结）；原文永久留在会话日志里。
 *
 * 零依赖；纯函数导出供测试。
 */

export const name = "@local/dsh-token-lever";
export const inject = ["sessionProjections"];

const MARK = "\n\n[... token-lever: 中段已裁剪，原文仍在会话日志，可重新执行该工具恢复 ...]\n\n";
const DEDUPE_MARK = "[token-lever] 与第 {seq} 步的工具结果内容完全相同，已折叠；完整内容见后文。";
/** 上面两个标记的前缀：投影靠它认领「这条 replacement 是本插件写的」。 */
const DEDUPE_PREFIX = DEDUPE_MARK.slice(0, DEDUPE_MARK.indexOf("{seq}"));

/* ── 事件常量：每个 type 都必须在宿主 KNOWN_SESSION_EVENT_TYPES 里 ──────── */

export const PRUNE_EVENT = "compaction/prune";
export const TOOL_RESULT_EVENT = "tool/result";
/** 本插件的重写标记文本（测试也拿它构造 replacement）。 */
export const PRUNE_MARK = MARK;
export const DEDUPE_MARKER = DEDUPE_MARK;
/**
 * 历史自定义类型：2.0.13 起不再写入（宿主不认识自定义类型，读回日志时会整份
 * 拒读），但投影必须继续折叠老日志里已有的这些事件。
 */
export const LEGACY_LEVER_EVENT = "token/lever";

/* ── 纯逻辑（测试 import） ─────────────────────────────────────────────── */

export function codePointLength(text) {
  return Array.from(text).length;
}

/** 文本块的总 Unicode 码点数；非文本块计 0。 */
export function textOfBlocks(blocks) {
  let chars = 0;
  for (const block of blocks ?? []) if (block?.type === "text") chars += codePointLength(block.text ?? "");
  return chars;
}

/** 从 tool/result 事件取出内容块数组。 */
export function resultBlocks(event) {
  return event?.data?.message?.content?.[0]?.content ?? [];
}

/** 稳定内容哈希（djb2，hex）。 */
export function hashText(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * 保头尾裁剪中段；未超阈值返回 null。保留块顺序与非文本块。
 */
export function pruneBlocks(blocks, headChars, tailChars) {
  const total = textOfBlocks(blocks);
  if (total <= headChars + tailChars + 32) return null;
  const removedStart = headChars;
  const removedEnd = total - tailChars;
  const pruned = [];
  let consumed = 0;
  let markerInserted = false;
  for (const block of blocks ?? []) {
    if (block?.type !== "text") { pruned.push(block); continue; }
    const points = Array.from(block.text ?? "");
    const blockStart = consumed;
    const blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? MARK : "";
    if (marker.length > 0) markerInserted = true;
    const text = points.slice(0, headEnd).join("") + marker + points.slice(tailStart).join("");
    if (text.length > 0) pruned.push({ ...block, text });
    consumed = blockEnd;
  }
  if (!markerInserted) return null;
  return pruned;
}

export function resolveConfig(config = {}) {
  const num = (key, fallback, min) => {
    const v = config[key];
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || v < min) throw new Error(`token-lever: config ${key} must be an integer >= ${min}`);
    return v;
  };
  const bool = (key, fallback) => (config[key] === undefined ? fallback : Boolean(config[key]));
  const resolved = {
    keepRecent: num("keepRecent", 4, 0),
    thresholdChars: num("thresholdChars", 4096, 1),
    headChars: num("headChars", 1536, 0),
    tailChars: num("tailChars", 512, 0),
    dedupe: bool("dedupe", true),
    maxOpsPerStep: num("maxOpsPerStep", 16, 1),
  };
  if (resolved.headChars + resolved.tailChars + 32 > resolved.thresholdChars) {
    throw new Error("token-lever: headChars + tailChars + 32 must be at most thresholdChars");
  }
  return resolved;
}

/**
 * 纯规划：给定面内 tool/result 事件序列（按序），决定要做的操作。
 * results: [{seq, event}]（已按面顺序）。返回 ops: [{seq, event, kind:"dedupe"|"prune", blocks}]。
 */
export function planOperations(results, cfg) {
  if (results.length === 0) return [];
  const recent = new Set(results.slice(Math.max(0, results.length - cfg.keepRecent)).map((r) => r.seq));
  const newestByHash = new Map();
  if (cfg.dedupe) {
    for (const r of results) {
      const h = hashText(textOfResult(r.event));
      if (h !== "0") newestByHash.set(h, r.seq);
    }
  }
  const markLen = codePointLength(DEDUPE_MARK.replace("{seq}", "000000"));
  const ops = [];
  for (const r of results) {
    if (ops.length >= cfg.maxOpsPerStep) break;
    if (recent.has(r.seq)) continue;
    const blocks = resultBlocks(r.event);
    const before = textOfBlocks(blocks);
    const h = hashText(textOfResult(r.event));
    if (cfg.dedupe && h !== "0" && newestByHash.get(h) !== r.seq && before > markLen + 32) {
      ops.push({ seq: r.seq, event: r.event, kind: "dedupe", blocks: [{ type: "text", text: DEDUPE_MARK.replace("{seq}", String(newestByHash.get(h))) }] });
      continue;
    }
    if (before <= cfg.thresholdChars) continue;
    const pruned = pruneBlocks(blocks, cfg.headChars, cfg.tailChars);
    if (pruned === null) continue;
    ops.push({ seq: r.seq, event: r.event, kind: "prune", blocks: pruned });
  }
  return ops;
}

function textOfResult(event) {
  const blocks = resultBlocks(event);
  let text = "";
  for (const b of blocks) if (b?.type === "text") text += b.text ?? "";
  return text;
}

/* ── 统计投影（折叠官方事件，兼容老的自定义事件） ─────────────────────── */

export function initialLeverState() {
  return {
    spans: 0,
    deduped: 0,
    pruned: 0,
    runs: 0,
    charsBefore: 0,
    charsAfter: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    /** 上一条 compaction/prune 的 shadow-price 认领：{start, end, tokens}。 */
    pendingPrune: null,
    /** 本批次（一次 runLever）尚未确认的增量：see file header。 */
    pendingRun: null,
  };
}

/**
 * 折叠一条会话事件。estimate 是 tokenMeter.estimateMessage（与写日志时同源），
 * 缺省时 tokensAfter 记 0；除它之外全是纯计算。
 */
export function foldLever(state, event, estimate) {
  const s = state ?? initialLeverState();
  if (event.type === LEGACY_LEVER_EVENT) return foldLegacyLever(s, event.data ?? {});
  if (event.type === PRUNE_EVENT) {
    const claim = pruneClaim(event.data);
    return claim === null ? s : { ...s, pendingPrune: claim };
  }
  if (event.type === TOOL_RESULT_EVENT) return foldReplacement(s, event, estimate);
  // 其它任何事件都说明本次 runLever 的追加已经结束：确认增量，并让 shadow-price 认领过期
  return s.pendingPrune === null ? flushRun(s) : flushRun({ ...s, pendingPrune: null });
}

/** 本插件自己写的 replacement：内容里有本插件标记，且配得上紧邻的 shadow-price 认领。 */
function foldReplacement(s, event, estimate) {
  const kind = leverOpKind(resultBlocks(event));
  const claim = s.pendingPrune;
  const start = replacementStart(event);
  if (kind === null || claim === null || (start !== null && start !== claim.start)) {
    return s.pendingPrune === null ? flushRun(s) : flushRun({ ...s, pendingPrune: null });
  }
  const run = s.pendingRun ?? emptyRun();
  const message = event.data?.message;
  return {
    ...s,
    pendingPrune: null,
    pendingRun: {
      spans: run.spans + 1,
      deduped: run.deduped + (kind === "dedupe" ? 1 : 0),
      pruned: run.pruned + (kind === "prune" ? 1 : 0),
      charsAfter: run.charsAfter + textOfBlocks(resultBlocks(event)),
      tokensBefore: run.tokensBefore + Math.max(0, Math.round(claim.tokens)),
      tokensAfter: run.tokensAfter + (typeof estimate === "function" && message !== undefined ? Math.max(0, Math.round(estimate(message))) : 0),
    },
  };
}

/**
 * 老日志的 token/lever 汇总：它覆盖的正是本批次那些 compaction/prune，所以连同
 * pendingRun 一起丢弃（否则同一次重写会被算两遍），汇总数自己算一次 run。
 */
function foldLegacyLever(s, d) {
  const base = { ...s, pendingPrune: null, pendingRun: null };
  return {
    ...base,
    spans: base.spans + int(d.spans),
    deduped: base.deduped + int(d.deduped),
    pruned: base.pruned + int(d.pruned),
    runs: base.runs + 1,
    charsBefore: base.charsBefore + int(d.charsBefore),
    charsAfter: base.charsAfter + int(d.charsAfter),
    tokensBefore: base.tokensBefore + int(d.tokensBefore),
    tokensAfter: base.tokensAfter + int(d.tokensAfter),
  };
}

function emptyRun() {
  return { spans: 0, deduped: 0, pruned: 0, charsAfter: 0, tokensBefore: 0, tokensAfter: 0 };
}

/** 把确认下来的本批次增量并进累计值。 */
function flushRun(s) {
  const run = s.pendingRun;
  if (run === null) return s;
  return {
    ...s,
    spans: s.spans + run.spans,
    deduped: s.deduped + run.deduped,
    pruned: s.pruned + run.pruned,
    runs: s.runs + 1,
    charsAfter: s.charsAfter + run.charsAfter,
    tokensBefore: s.tokensBefore + run.tokensBefore,
    tokensAfter: s.tokensAfter + run.tokensAfter,
    pendingRun: null,
  };
}

/** 从 replacement 的内容块认出本插件的标记（官方 pruner 的标记不含 "token-lever"）。 */
export function leverOpKind(blocks) {
  const text = joinText(blocks);
  if (text.includes(DEDUPE_PREFIX)) return "dedupe";
  if (text.includes(MARK)) return "prune";
  return null;
}

/** shadow-price：compaction/prune 给被替换区间定的 token 价。 */
function pruneClaim(data) {
  const range = data?.shadowedRange;
  if (range === null || typeof range !== "object" || !Number.isFinite(range.start)) return null;
  return { start: range.start, end: Number.isFinite(range.end) ? range.end : range.start, tokens: Number.isFinite(data.shadowedTokenCount) ? data.shadowedTokenCount : 0 };
}

/** surface replace 的目标 seq；不是 replace（或读不到）返回 null。 */
function replacementStart(event) {
  const op = event?.surfaceOp;
  if (op === null || typeof op !== "object" || Array.isArray(op)) return null;
  return Number.isFinite(op.startSeq) ? op.startSeq : null;
}

function joinText(blocks) {
  let text = "";
  for (const b of blocks ?? []) if (b?.type === "text") text += b.text ?? "";
  return text;
}

/* ── 插件体 ───────────────────────────────────────────────────────────── */

export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config);
  /**
   * **用到时再取** meter。曾经在 apply() 里取一次：那一刻 token-meter 行还没注册，
   * 于是插件永久自禁用（宿主日志里那条 "tokenMeter service unavailable" 就是它）。
   * 注册顺序不保证，所以每次用之前现取。
   */
  const meterOf = () => {
    const candidate = ctx.get("tokenMeter");
    return candidate !== undefined && typeof candidate.estimateMessage === "function" ? candidate : undefined;
  };
  /** 投影里的估算只用于展示：拿不到 meter 时用固定启发式（写路径仍然只认真 meter）。 */
  const estimateOf = (message) => {
    const meter = meterOf();
    return meter !== undefined ? meter.estimateMessage(message) : Math.ceil(JSON.stringify(message).length / 4);
  };

  const leverProjection = {
    key: "tokenLever",
    // 折叠口径从自定义事件换成官方事件（见文件头），旧 checkpoint 必须作废重算
    stateVersion: 2,
    stateSchema: { parse: (v) => normalizeLever(v) },
    init: () => initialLeverState(),
    apply: (state, event) => foldLever(state, event, estimateOf),
    wire: {
      viewSchema: { parse: (v) => v },
      view: (s) => ({ spans: s.spans, deduped: s.deduped, pruned: s.pruned, charsBefore: s.charsBefore, charsAfter: s.charsAfter, tokensBefore: s.tokensBefore, tokensAfter: s.tokensAfter }),
    },
  };
  ctx.sessionProjections.register(leverProjection);

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "lever",
      description: "token-lever 累计节省统计",
      handler: ({ agent }) => {
        const state = ctx.sessionProjections.stateOf(agent.session, "tokenLever");
        const s = state === undefined ? leverProjection.init() : state;
        const savedTokens = s.tokensBefore - s.tokensAfter;
        if (s.spans === 0) return { kind: "success", text: "token-lever：本会话还没有修剪记录。" };
        return {
          kind: "success",
          text: [
            `token-lever 累计：${s.spans} 处重写（去重 ${s.deduped} / 裁剪 ${s.pruned}）`,
            `字符 ${s.charsBefore} → ${s.charsAfter}`,
            `估算 token ${s.tokensBefore} → ${s.tokensAfter}（省 ~${savedTokens}）`,
          ].join("\n"),
        };
      },
    });
  });

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject" || signal.aborted || agent === undefined) return decision;
    try {
      const meter = meterOf();
      if (meter === undefined) return decision; // 契约要求真 meter：拿不到就不动请求面
      runLever(agent.session, cfg, meter);
    } catch (error) {
      ctx.logger?.warn?.("token-lever: surface pass failed: %o", error);
    }
    return decision;
  });
}

function runLever(session, cfg, meter) {
  const seqs = [...session.surface.nodes];
  const results = [];
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event?.type === "tool/result") results.push({ seq, event });
  }
  const ops = planOperations(results, cfg);
  if (ops.length === 0) return;
  for (const op of ops) {
    const event = op.event;
    const original = event.data.message;
    const message = { ...original, content: [{ ...original.content[0], content: op.blocks }] };
    session.append("compaction/prune", {
      shadowedRange: { start: op.seq, end: op.seq },
      shadowedSeqs: [op.seq],
      shadowedTokenCount: meter.estimateMessage(original),
    });
    session.append("tool/result", { ...event.data, message }, {
      surfaceOp: { op: "replace", startSeq: op.seq, endSeq: op.seq },
      sourceEventSeqs: [op.seq],
    });
  }
}

function int(v) {
  return Number.isFinite(v) ? Math.round(v) : 0;
}

const COUNTER_KEYS = ["spans", "deduped", "pruned", "runs", "charsBefore", "charsAfter", "tokensBefore", "tokensAfter"];

function normalizeLever(v) {
  const zero = initialLeverState();
  if (v === null || typeof v !== "object") return zero;
  const out = { ...zero };
  for (const k of COUNTER_KEYS) out[k] = Number.isFinite(v[k]) ? Math.round(v[k]) : 0;
  out.pendingPrune = normalizeClaim(v.pendingPrune);
  out.pendingRun = normalizeRun(v.pendingRun);
  return out;
}

/** checkpoint 里的 shadow-price 认领：形状不对就当没有。 */
function normalizeClaim(v) {
  if (v === null || typeof v !== "object" || !Number.isFinite(v.start)) return null;
  return { start: v.start, end: Number.isFinite(v.end) ? v.end : v.start, tokens: Number.isFinite(v.tokens) ? v.tokens : 0 };
}

/** checkpoint 里的批次增量：形状不对就当没有。 */
function normalizeRun(v) {
  if (v === null || typeof v !== "object") return null;
  const run = emptyRun();
  for (const k of Object.keys(run)) run[k] = Number.isFinite(v[k]) ? Math.max(0, Math.round(v[k])) : 0;
  return run;
}
