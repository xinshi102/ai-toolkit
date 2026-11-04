/**
 * @local/dsh-xinshi-ledger — 主机侧：把 xinshiimprove 的「规则观察」写进台账。
 *
 * 三件事：
 * 1. `ledger_observe`：按 `observations.md` §条目格式 **追加**一条观察，
 *    同步更新「频次索引」，并把闸 0 门槛（`governance.md`：L0/L1≥3、L2≥2、L3~L5≥1）算成
 *    「已达 / 还差几次」的明文。写回前有 `assertAppendOnly` 守卫：原条目被动过就整笔拒绝。
 * 2. `ledger_status`：条目数、下一编号、频次索引与闸 0 达标情况——改规则前统计频次用。
 * 3. `/ledger` 命令：给人看的一行式结论（不进模型上下文，不花 token）。
 *
 * 为什么强制 `confirmed: true`：台账 §写入规则 明确「AI 产出观察结论，**经人类确认后**才追加」。
 * 这条纪律没法在技术上验证，但可以让它在调用面显形——没带就是流程错，直接拒绝并说清规矩。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  CATEGORIES,
  LEDGER_TITLE,
  LEVELS,
  STATUSES,
  applyObservation,
  assertAppendOnly,
  ledgerStatus,
  needFor,
} from "./ledger.js";

export const name = "@local/dsh-xinshi-ledger";
export const inject = ["tools", "systemPrompt"];

export const OBSERVE_TOOL = "ledger_observe";
export const STATUS_TOOL = "ledger_status";

export const DEFAULT_SECTION = [
  "规则观察台账（xinshi-ledger）：",
  "- 任务结束**反问**四问（一句话，不逐条成文）；人类认下哪条，才把该条按台账格式写成草稿，确认后用 ledger_observe 追加（只追加，不改不删）。",
  "- 改规则前用 ledger_status 看频次：L0/L1 需 3 次、L2 需 2 次、L3~L5 需 1 次（闸 0）。",
].join("\n");

const OBSERVE_PARAMS = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "One-line phenomenon, the entry heading after the O-number." },
    category: { type: "string", enum: CATEGORIES, description: "四问归类（未覆盖 / 表述误解 / 执行效果不佳 / 本该触发却未触发）——写进条目正文。" },
    problemClass: { type: "string", description: "问题类别：频次索引的行键。同一类问题必须复用同一个类名才会累计次数（例如「立规后 L0~L2 改动绕过闭环」）。" },
    phenomenon: { type: "string", description: "现象：AI 实际做了什么、人类期望是什么。" },
    evidence: { type: "string", description: "证据：文件路径、报错原文、对话片段位置。没有证据的观察不入台账。" },
    task: { type: "string", description: "哪个项目、哪个任务。" },
    rules: { type: "string", description: "涉及规则：文件 + §章节；未覆盖的情况写「无对应规则」。" },
    level: { type: "string", enum: LEVELS, description: "预计改动层级（决定闸 0 门槛），默认 L2。" },
    status: { type: "string", enum: STATUSES, description: "状态，默认「待分析」。" },
    analysis: {
      type: "object",
      description: "②环分析三问（可留空，默认「待②环判断」）。",
      additionalProperties: false,
      properties: {
        a1: { type: "string", description: "A1 规则问题 还是 执行问题。" },
        a2: { type: "string", description: "A2 改哪一层。" },
        a3: { type: "string", description: "A3 怎么验证改完真的解决了。" },
      },
    },
    destination: { type: "string", description: "去向：已转提案 R<编号> / 执行问题继续观察 / 已关闭（附理由）。" },
    confirmed: { type: "boolean", description: "必须为 true——台账规则要求观察结论先经人类确认再追加。" },
  },
  required: ["title", "category", "problemClass", "phenomenon", "evidence", "confirmed"],
};

export const OBSERVE_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", const: true },
    id: { type: "string" },
    category: { type: "string" },
    problemClass: { type: "string" },
    level: { type: "string" },
    count: { type: "integer" },
    need: { type: "integer" },
    reached: { type: "boolean" },
    verdict: { type: "string" },
    entries: { type: "integer" },
    nextId: { type: "string" },
    file: { type: "string" },
  },
  required: ["ok", "id", "category", "count", "need", "reached", "verdict"],
};

export const STATUS_OUTPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { type: "boolean", const: true },
    file: { type: "string" },
    entries: { type: "integer" },
    lastId: { type: "string" },
    nextId: { type: "string" },
    reachedCount: { type: "integer" },
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          problemClass: { type: "string" },
          ids: { type: "array", items: { type: "string" } },
          count: { type: "integer" },
          level: { type: "string" },
          need: { type: "integer" },
          reached: { type: "boolean" },
          verdict: { type: "string" },
        },
        required: ["problemClass", "count", "reached", "verdict"],
      },
    },
  },
  required: ["ok", "entries", "nextId", "rows"],
};

/** 归一化部署配置；`file` 优先，其次 `dir` + 固定文件名。 */
export function resolveConfig(config = {}, env = process.env) {
  const home = typeof env?.DSH_HOME === "string" && env.DSH_HOME.trim() !== "" ? env.DSH_HOME : path.join(homedir(), ".dsh");
  const dir = typeof config.dir === "string" && config.dir.trim() !== "" ? config.dir.trim().replace(/^~(?=\/)/u, homedir()) : path.join(home, "skills", "xinshiimprove", "share");
  const file = typeof config.file === "string" && config.file.trim() !== "" ? config.file.trim().replace(/^~(?=\/)/u, homedir()) : path.join(dir, "observations.md");
  return {
    dir,
    file,
    level: LEVELS.includes(String(config.level ?? "").toUpperCase()) ? String(config.level).toUpperCase() : "L2",
    backup: config.backup !== false,
    section: typeof config.section === "string" && config.section.trim() !== "" ? config.section.trim() : DEFAULT_SECTION,
  };
}

function validateObserve(args) {
  const errs = [];
  if (args === null || typeof args !== "object" || Array.isArray(args)) return ["arguments must be an object"];
  const props = OBSERVE_PARAMS.properties;
  for (const key of Object.keys(args)) if (!Object.hasOwn(props, key)) errs.push(`unknown argument "${key}"`);
  for (const key of OBSERVE_PARAMS.required) if (!Object.hasOwn(args, key)) errs.push(`missing "${key}"`);
  for (const [key, spec] of Object.entries(props)) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (spec.type === "string") {
      if (typeof value !== "string") errs.push(`"${key}" must be a string`);
      else if (spec.enum !== undefined && !spec.enum.includes(value)) errs.push(`"${key}" must be one of ${spec.enum.join("|")}`);
    } else if (spec.type === "boolean" && typeof value !== "boolean") errs.push(`"${key}" must be a boolean`);
    else if (spec.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) errs.push(`"${key}" must be an object`);
  }
  return errs;
}

/** 人看的 `/ledger` 输出。 */
export function formatStatus(status, file) {
  const head = `规则观察台账：${status.entries} 条观察 ｜ 下一编号 ${status.nextId}${status.lastId === "" ? "" : ` ｜ 最新 ${status.lastId}`} ｜ ${file}`;
  if (status.rows.length === 0) return `${head}\n频次索引为空。`;
  const lines = status.rows.map((row) => `- ${row.reached ? "★" : "·"} ${row.problemClass}：${row.count} 次（${row.verdict}）`);
  const reached = status.rows.filter((row) => row.reached);
  return [
    head,
    ...lines,
    reached.length === 0 ? "闸 0：暂无达标类别。" : `闸 0：${reached.length} 个类别已达标，可以提案：${reached.map((row) => row.problemClass).join("、")}`,
  ].join("\n");
}

export function apply(ctx, config = {}) {
  const options = resolveConfig(config);

  const read = () => {
    if (!existsSync(options.file)) throw new Error(`找不到台账文件：${options.file}（用 config.file / config.dir 指到 observations.md）`);
    const text = readFileSync(options.file, "utf8");
    if (!text.includes(LEDGER_TITLE)) throw new Error(`${options.file} 不是规则观察台账（缺少「${LEDGER_TITLE}」）`);
    return text;
  };

  /** 原子写 + 覆盖前留一份 .bak：台账是证据，写坏一次就全丢了。 */
  const write = (text) => {
    try {
      mkdirSync(path.dirname(options.file), { recursive: true });
      if (options.backup) copyFileSync(options.file, `${options.file}.bak`);
      const temp = `${options.file}.${process.pid}.tmp`;
      writeFileSync(temp, text, "utf8");
      renameSync(temp, options.file);
      return true;
    } catch (error) {
      ctx.logger?.warn?.("xinshi-ledger: 写入失败 file=%s error=%s", options.file, error.message);
      return false;
    }
  };

  ctx.tools.register({
    name: OBSERVE_TOOL,
    description:
      "Append one rule observation to the xinshiimprove ledger (observations.md), updating its frequency index and the gate-0 verdict (L0/L1 need 3 same-kind observations, L2 needs 2, L3+ needs 1). The ledger is append-only: existing entries are never modified, and the call is refused if they would be. Requires confirmed=true — the ledger's own rule is that observations are appended only after the human confirms them. Show the human the draft first, then call this.",
    parameters: OBSERVE_PARAMS,
    output: {
      schema: OBSERVE_OUTPUT,
      render: (_args, value) => [{
        type: "text",
        text: `已追加 ${value.id}（四问归类：${value.category}）到台账，问题类别「${value.problemClass}」：同类 ${value.count} 次，${value.verdict}${value.reached ? " → 可以走 proposals.md 提案了" : ""}。文件：${value.file}`,
      }],
    },
    execute: async (args) => {
      const bad = validateObserve(args);
      if (bad.length > 0) throw new Error(`${OBSERVE_TOOL}: invalid arguments: ${bad.join("; ")}`);
      if (args.confirmed !== true) {
        throw new Error(`${OBSERVE_TOOL}: 台账规则要求「观察结论经人类确认后才追加」——先把草稿给人类看，确认后带 confirmed: true 再调用`);
      }
      const before = read();
      const result = applyObservation(before, { ...args, level: args.level ?? options.level });
      assertAppendOnly(before, result.text);
      if (write(result.text) !== true) throw new Error(`${OBSERVE_TOOL}: 写入台账失败（${options.file}）`);
      const after = ledgerStatus(result.text);
      ctx.logger?.info?.("xinshi-ledger: 追加 id=%s category=%s class=%s count=%d reached=%s", result.id, result.category, result.problemClass, result.count, String(result.reached));
      return {
        ok: true,
        id: result.id,
        category: result.category,
        problemClass: result.problemClass,
        level: result.level,
        count: result.count,
        need: result.need,
        reached: result.reached === true,
        verdict: result.verdict,
        entries: after.entries,
        nextId: after.nextId,
        file: options.file,
      };
    },
    presentCall: (args) => ({
      card: "generic",
      title: `${OBSERVE_TOOL} · ${String(args?.category ?? "")}`,
      kind: "other",
      content: [{ type: "text", text: [args?.problemClass, args?.title].filter(Boolean).join(" · ") }],
    }),
  });

  ctx.tools.register({
    name: STATUS_TOOL,
    description:
      "Show the xinshiimprove rule-observation ledger status: entry count, next O-number, the frequency index, and which categories already reached the gate-0 threshold (the precondition for touching the rules). Read-only.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    output: {
      schema: STATUS_OUTPUT,
      render: (_args, value) => [{ type: "text", text: formatStatus(value, value.file) }],
    },
    execute: async () => {
      const status = ledgerStatus(read());
      const rows = status.rows.map((row) => ({
        problemClass: row.problemClass,
        ids: row.ids,
        count: row.count,
        level: row.level ?? "",
        need: row.need ?? 0,
        reached: row.reached === true,
        verdict: row.verdict ?? "",
      }));
      return {
        ok: true,
        file: options.file,
        entries: status.entries,
        lastId: status.lastId,
        nextId: status.nextId,
        reachedCount: rows.filter((row) => row.reached).length,
        rows,
      };
    },
    presentCall: () => ({
      card: "generic",
      title: `${STATUS_TOOL} · 台账`,
      kind: "other",
      content: [{ type: "text", text: options.file }],
    }),
  });

  ctx.inject(["commands"], (commandCtx) => {
    commandCtx.commands.register({
      name: "ledger",
      description: "规则观察台账：状态 / 下一编号 / 闸 0 达标情况（xinshiimprove 第①环）",
      input: { hint: "[status]", attachments: false },
      handler: () => {
        try {
          const status = ledgerStatus(read());
          return { kind: "success", text: formatStatus(status, options.file) };
        } catch (error) {
          return { kind: "error", text: error.message };
        }
      },
    });
  });

  const order = typeof ctx.systemPrompt.getSectionOrder === "function"
    ? ctx.systemPrompt.getSectionOrder("PLAN_POLICY") - 20
    : 480;
  ctx.systemPrompt.section({
    name: "xinshi-ledger:policy",
    order,
    text: ({ scope }) => (ctx.tools.get(STATUS_TOOL, scope) === undefined ? "" : options.section),
  });

  if (!existsSync(options.file)) {
    ctx.logger?.warn?.("xinshi-ledger: 台账文件不存在 %s（工具会在调用时报错，不会瞎建）", options.file);
  }
}

export { CATEGORIES, LEVELS, STATUSES, needFor };
