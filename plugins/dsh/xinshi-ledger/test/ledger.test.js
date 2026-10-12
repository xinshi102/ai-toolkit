import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATEGORIES,
  THRESHOLDS,
  applyObservation,
  assertAppendOnly,
  formatEntry,
  ledgerStatus,
  needFor,
  parseIds,
  parseLedger,
  renderRow,
  upsertRow,
  verdictFor,
} from "../lib/ledger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = readFileSync(path.join(here, "fixtures", "observations.md"), "utf8");

const observation = {
  title: "台账靠手抄，漏字段没人拦",
  category: "执行效果不佳",
  problemClass: "规则观察写入无工具把关（靠手抄）",
  phenomenon: "写观察时漏了「涉及规则」与「证据」两栏。",
  evidence: "本工作区 plugins/xinshi-ledger 的第一次试写。",
  task: "DSH 生态建设 / xinshi-ledger",
  rules: "`observations.md` §条目格式",
  level: "L2",
};

test("parseLedger: 条目编号/标题、下一编号、频次索引行都读对", () => {
  const parsed = parseLedger(LEDGER);
  assert.deepEqual(parsed.entries.map((entry) => entry.id), ["O001", "O002", "O003", "O004", "O006"]);
  assert.equal(parsed.entries[0].title, "协议链路全量注入，单次新对话开销约 3 万 token");
  assert.equal(parsed.nextId, "O007", "编号连续递增，不复用（O005 缺失也不回填）");
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[0].ids, ["O001"]);
  assert.equal(parsed.rows[0].count, 1);
  assert.deepEqual(parsed.rows[1].ids, ["O002", "O004", "O006"], "加粗的编号也要认出来");
  assert.equal(parsed.rows[1].count, 3);
  assert.ok(parsed.rows[1].verdict.includes("已达 L0"));
  assert.equal(parsed.rows[1].problemClass, "立规后 L0~L2 改动绕过闭环", "索引第一列是「问题类别」，不是四问归类");
  assert.equal(parsed.table.start, parsed.table.header + 2);
});

test("parseLedger: 认错文件立刻拒绝，不乱写", () => {
  assert.throws(() => parseLedger("# 别的东西\n"), /不是规则观察台账/u);
  assert.throws(() => parseLedger("# 规则观察记录\n\n没有索引小节\n"), /缺少「## 频次索引」/u);
  assert.throws(() => parseLedger("# 规则观察记录\n\n## 频次索引\n\n（没有表）\n"), /找不到「\| 问题类别 \|」表头/u);
});

test("闸 0 门槛与判定文案：达标说「已达」，没达标说「还差几次」", () => {
  assert.deepEqual(THRESHOLDS, { L0: 3, L1: 3, L2: 2, L3: 1, L4: 1, L5: 1 });
  assert.equal(needFor("l2"), 2);
  assert.equal(needFor("L5"), 1);
  assert.equal(needFor("乱写"), 2, "认不出的层级按 L2 兜底");
  assert.equal(verdictFor(3, "L0"), "已达 L0 的 3 次门槛");
  assert.equal(verdictFor(1, "L2"), "L2 需 2 次（还差 1 次）");
  assert.equal(verdictFor(0, "L2"), "L2 需 2 次（还没有观察）");
});

test("parseIds: 支持中文顿号、逗号、加粗与空格混写", () => {
  assert.deepEqual(parseIds("O002、O004、**O006**"), ["O002", "O004", "O006"]);
  assert.deepEqual(parseIds("O001, O002"), ["O001", "O002"]);
  assert.deepEqual(parseIds("没编号"), []);
});

test("upsertRow / renderRow: 同类别累加，达标整行加粗（沿用台账已有写法）", () => {
  const parsed = parseLedger(LEDGER);
  const rows = upsertRow(parsed.rows, { problemClass: "立规后 L0~L2 改动绕过闭环", id: "O007", level: "L0" });
  const row = rows.find((item) => item.problemClass === "立规后 L0~L2 改动绕过闭环");
  assert.equal(row.count, 4);
  assert.equal(row.reached, true);
  assert.equal(row.verdict, "已达 L0 的 3 次门槛");
  assert.equal(renderRow(row), "| **立规后 L0~L2 改动绕过闭环** | O002、O004、O006、**O007** | **4** | **已达 L0 的 3 次门槛** |");

  const fresh = upsertRow(parsed.rows, { problemClass: "新问题类别", id: "O007", level: "L2" });
  const newRow = fresh.find((item) => item.problemClass === "新问题类别");
  assert.equal(newRow.count, 1);
  assert.equal(newRow.reached, false);
  assert.equal(renderRow(newRow), "| 新问题类别 | O007 | 1 | L2 需 2 次（还差 1 次） |");
  assert.equal(parsed.rows.length, 3, "原数组不能被就地改掉");
});

test("formatEntry: 字段顺序、全角空格、分析三问缺省值都符合台账格式", () => {
  const entry = formatEntry({ ...observation, id: "O007", date: "2026-09-24" });
  const lines = entry.split("\n");
  assert.equal(lines[0], "## O007　台账靠手抄，漏字段没人拦", "编号与标题之间是全角空格");
  assert.deepEqual(lines.slice(2, 7), [
    "- 日期：2026-09-24",
    "- 任务：DSH 生态建设 / xinshi-ledger",
    "- 涉及规则：`observations.md` §条目格式",
    "- 状态：待分析",
    "- 四问归类：执行效果不佳",
  ]);
  for (const heading of ["### 现象", "### 证据", "### 分析", "### 去向"]) assert.ok(entry.includes(heading), `缺少 ${heading}`);
  assert.ok(entry.includes("- A1 规则问题 还是 执行问题：待②环判断"));
  assert.ok(entry.endsWith("\n"));
});

test("applyObservation: 追加在末尾、编号递增、同步频次索引", () => {
  const result = applyObservation(LEDGER, { ...observation, date: "2026-09-24" });
  assert.equal(result.id, "O007");
  assert.equal(result.category, "执行效果不佳");
  assert.equal(result.count, 1);
  assert.equal(result.need, 2);
  assert.equal(result.reached, false);
  assert.equal(result.verdict, "L2 需 2 次（还差 1 次）");

  const lines = result.text.split("\n");
  const entryLine = lines.findIndex((line) => line.startsWith("## O007"));
  const lastOldEntry = lines.findIndex((line) => line.startsWith("## O006"));
  assert.ok(entryLine > lastOldEntry, "新条目必须在最后一条之后");
  assert.ok(result.text.startsWith(LEDGER.slice(0, LEDGER.indexOf("| 上下文加载无路由"))), "索引表之前的正文一字不动");
  assert.ok(result.text.includes("| 规则观察写入无工具把关（靠手抄） | O007 | 1 | L2 需 2 次（还差 1 次） |"));
  assert.ok(result.text.includes("- 四问归类：执行效果不佳"), "四问归类仍然写进条目");
  assert.ok(result.text.includes("- 日期：2026-09-24"));

  // 已有类别累加：不改旧条目、只动索引行（四问归类可以不同，问题类别要复用才会累计）
  const again = applyObservation(LEDGER, { ...observation, title: "第二次同类观察", category: "本该触发却未触发", problemClass: "立规后 L0~L2 改动绕过闭环", level: "L0", date: "2026-09-24" });
  assert.equal(again.count, 4, "该问题类别已有 3 条，再加一条是 4");
  assert.equal(again.reached, true);
  assert.equal(again.problemClass, "立规后 L0~L2 改动绕过闭环");
  assert.ok(again.text.includes("| **立规后 L0~L2 改动绕过闭环** | O002、O004、O006、**O007** | **4** | **已达 L0 的 3 次门槛** |"));
});

test("applyObservation: 四问归类 / 证据 / 标题 / 层级 不合格就拒绝", () => {
  const base = { ...observation, date: "2026-09-24" };
  assert.throws(() => applyObservation(LEDGER, { ...base, category: "我编的类别" }), /四问归类必须是/u);
  assert.throws(() => applyObservation(LEDGER, { ...base, evidence: "   " }), /缺少「证据」/u);
  assert.throws(() => applyObservation(LEDGER, { ...base, title: "" }), /缺少「一句话现象」/u);
  assert.throws(() => applyObservation(LEDGER, { ...base, phenomenon: "" }), /缺少「现象」/u);
  assert.throws(() => applyObservation(LEDGER, { ...base, level: "L9" }), /层级必须是/u);
  assert.throws(() => applyObservation(LEDGER, { ...base, problemClass: "   " }), /缺少「问题类别」/u);
  assert.throws(() => applyObservation(LEDGER, { ...base, problemClass: "带|竖线" }), /不能有竖线/u);
});

test("assertAppendOnly: 只追加通过；改动/删除旧条目或条目数不对都要拦下", () => {
  const good = applyObservation(LEDGER, { ...observation, date: "2026-09-24" });
  assert.equal(assertAppendOnly(LEDGER, good.text), true);

  const tampered = good.text.replace("## O001　协议链路全量注入，单次新对话开销约 3 万 token", "## O001　被我改过的标题");
  assert.throws(() => assertAppendOnly(LEDGER, tampered), /原条目 O001 被改动|不是「只追加」/u);

  const dropped = good.text.replace(/## O003　[\s\S]*?(?=## O004)/u, "");
  assert.throws(() => assertAppendOnly(LEDGER, dropped), /条目数应为 6|不是「只追加」/u);
});

test("ledgerStatus: 条目数、下一编号、达标类别都能一眼看出来", () => {
  const status = ledgerStatus(LEDGER);
  assert.equal(status.entries, 5);
  assert.equal(status.lastId, "O006");
  assert.equal(status.nextId, "O007");
  assert.deepEqual(status.reached, ["立规后 L0~L2 改动绕过闭环"]);
  const row = status.rows.find((item) => item.problemClass === "通用层混入项目专有名词");
  assert.equal(row.level, "L2");
  assert.equal(row.need, 2);
  assert.equal(row.reached, false, "1 次不够 L2 的 2 次门槛");
});

test("CATEGORIES: 四问归类就是这四个字面量（写错就没法统计）", () => {
  assert.deepEqual(CATEGORIES, ["未覆盖", "表述误解", "执行效果不佳", "本该触发却未触发"]);
});
