import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cardToNodes,
  isTaskCard,
  mapCardStatus,
  parseImport,
  parseTable,
  parseTaskCard,
  rollupStatus,
  splitSections,
} from "../lib/card.js";
import { parseOutline } from "../lib/index.js";

/** 一份填好的任务卡（形状取自 xinshiimprove 的 task_card_template.md）。 */
const CARD = `# 任务：给计划树加任务卡导入

## 档位（必填）
M（中等）

## 目标（必填）
让 plan_import 直接吃 xinshiimprove 的任务卡，子任务表变节点、验收方式当阶段门。

## 边界（必填）
只动 plan-map；不改任务卡模板本身。

## 预算（必填）
0.5 天 / 无新增依赖

## 涉及文件（必填）
plugins/plan-map/lib/card.js、lib/index.js

## 不可逆操作清单（必填）
无

## 子任务拆分（L / XL 必填，M 可选）
| # | 子任务 | 产出 | 验收方式 | 状态 |
|---|--------|------|----------|------|
| 1 | 写任务卡解析器 | lib/card.js | 单测覆盖表头/状态映射 | 已验收 |
| 2 | 接进 plan_import | 统一导入入口 | execute 与投影回放同树 | 进行中 |
| 3 | 补文档 | README 一节 | 人能照着写卡 | 待开始 |

## 验收方式（必填）
node --test 全绿 + verify 13 段全绿 + 手工贴一张真卡看树。

## 备注
无
`;

test("isTaskCard: 认卡、不误判大纲", () => {
  assert.equal(isTaskCard(CARD), true);
  assert.equal(isTaskCard("做游戏\n  策划案\n  写代码"), false);
  assert.equal(isTaskCard("# 任务：只有标题没有子任务表\n\n## 目标\n随便写点"), false, "没有子任务表就不算卡");
});

test("splitSections: 按二级标题切，前导部分单独一节", () => {
  const sections = splitSections(CARD);
  assert.deepEqual(sections.slice(1).map((section) => section.title), [
    "档位（必填）", "目标（必填）", "边界（必填）", "预算（必填）", "涉及文件（必填）",
    "不可逆操作清单（必填）", "子任务拆分（L / XL 必填，M 可选）", "验收方式（必填）", "备注",
  ]);
});

test("mapCardStatus: 中英文/加粗/标点都能认，认不出的回落 pending 并标记", () => {
  assert.deepEqual(mapCardStatus("已验收"), { status: "done", known: true });
  assert.deepEqual(mapCardStatus("**进行中**"), { status: "active", known: true });
  assert.deepEqual(mapCardStatus("待开始"), { status: "pending", known: true });
  assert.deepEqual(mapCardStatus("阻塞"), { status: "blocked", known: true });
  assert.deepEqual(mapCardStatus("in progress"), { status: "active", known: true });
  assert.deepEqual(mapCardStatus("Done"), { status: "done", known: true });
  assert.deepEqual(mapCardStatus(""), { status: "pending", known: true });
  assert.deepEqual(mapCardStatus("看情况"), { status: "pending", known: false });
});

test("parseTable: 跳过对齐行、丢空行、按表头找列（列顺序可换）", () => {
  const table = parseTable([
    "| 子任务 | 状态 | 产出 |",
    "|---|---|---|",
    "| 甲 | 已验收 | a.js |",
    "| 乙 | 进行中 | b.js |",
    "|  |  |  |",
  ]);
  assert.deepEqual(table.header, ["子任务", "状态", "产出"]);
  assert.equal(table.rows.length, 2, "分隔行与空行不算数据行");
  const card = parseTaskCard(`# 任务：换列序\n\n## 子任务拆分\n\n${["| 子任务 | 状态 | 产出 | 验收方式 |", "|---|---|---|---|", "| 甲 | 已验收 | a.js | 单测 |"].join("\n")}\n`);
  assert.deepEqual(card.subtasks.map((item) => [item.title, item.status, item.output, item.acceptance]), [["甲", "done", "a.js", "单测"]]);
});

test("parseTaskCard: 任务名/档位/目标/子任务/验收方式都读对", () => {
  const card = parseTaskCard(CARD);
  assert.equal(card.task, "给计划树加任务卡导入");
  assert.equal(card.tier, "M");
  assert.match(card.goal, /让 plan_import 直接吃/);
  assert.match(card.budget, /0\.5 天/);
  assert.equal(card.subtasks.length, 3);
  assert.deepEqual(card.subtasks.map((item) => item.title), ["写任务卡解析器", "接进 plan_import", "补文档"]);
  assert.deepEqual(card.subtasks.map((item) => item.status), ["done", "active", "pending"]);
  assert.equal(card.subtasks[0].output, "lib/card.js");
  assert.equal(card.subtasks[1].acceptance, "execute 与投影回放同树");
  assert.match(card.acceptance, /node --test 全绿/);
});

test("rollupStatus: 根节点状态由子任务汇总", () => {
  assert.equal(rollupStatus([]), "pending");
  assert.equal(rollupStatus([{ status: "pending" }, { status: "pending" }]), "pending");
  assert.equal(rollupStatus([{ status: "done" }, { status: "pending" }]), "active");
  assert.equal(rollupStatus([{ status: "active" }, { status: "pending" }]), "active");
  assert.equal(rollupStatus([{ status: "blocked" }, { status: "pending" }]), "active");
  assert.equal(rollupStatus([{ status: "done" }, { status: "done" }]), "done");
});

test("cardToNodes: 根 + 子节点、备注带产出/验收、状态按卡片映射、根状态汇总", () => {
  const nodes = cardToNodes(parseTaskCard(CARD));
  assert.equal(nodes.length, 4);
  assert.deepEqual(nodes[0].id, "p1");
  assert.equal(nodes[0].parent, "");
  assert.equal(nodes[0].title, "给计划树加任务卡导入");
  assert.equal(nodes[0].status, "active", "有进行中 → 根节点 active");
  assert.match(nodes[0].note, /档位：M/);
  assert.match(nodes[0].note, /验收方式（阶段门）/);
  assert.deepEqual(nodes.slice(1).map((node) => node.parent), ["p1", "p1", "p1"]);
  assert.deepEqual(nodes.slice(1).map((node) => [node.id, node.status]), [["p2", "done"], ["p3", "active"], ["p4", "pending"]]);
  assert.match(nodes[1].note, /产出：lib\/card\.js/);
  assert.match(nodes[1].note, /验收：单测覆盖表头\/状态映射/);
});

test("cardToNodes: 状态认不出时在备注里说清楚，而不是默默当 pending", () => {
  const card = parseTaskCard(`# 任务：X\n\n## 子任务拆分\n\n| # | 子任务 | 产出 | 验收方式 | 状态 |\n|---|---|---|---|---|\n| 1 | 甲 | a | b | 看情况 |\n`);
  const nodes = cardToNodes(card);
  assert.equal(nodes[1].status, "pending");
  assert.match(nodes[1].note, /认不出/);
});

test("cardToNodes: 标题/备注截断与节点数上限都生效", () => {
  const long = parseTaskCard(`# 任务：${"任".repeat(200)}\n\n## 子任务拆分\n\n| # | 子任务 | 产出 | 验收方式 | 状态 |\n|---|---|---|---|---|\n${Array.from({ length: 30 }, (_, i) => `| ${i + 1} | 子任务${i} | 产出 | 验收 | 待开始 |`).join("\n")}\n`);
  const nodes = cardToNodes(long, { maxNodes: 6, maxTitle: 20, maxNote: 30 });
  assert.equal(nodes.length, 6, "1 根 + 5 个子任务");
  assert.ok(nodes[0].title.length <= 21);
  assert.ok(nodes[1].note.length <= 31);
});

test("parseImport: 卡走卡、大纲走大纲（两条路都不误伤）", () => {
  const fromCard = parseImport(CARD, {}, parseOutline);
  assert.equal(fromCard.length, 4);
  assert.equal(fromCard[0].title, "给计划树加任务卡导入");
  const fromOutline = parseImport("做游戏\n  策划案\n  写代码", {}, parseOutline);
  assert.deepEqual(fromOutline.map((node) => node.title), ["做游戏", "策划案", "写代码"]);
  assert.deepEqual(fromOutline.map((node) => node.parent), ["", "p1", "p1"]);
});
