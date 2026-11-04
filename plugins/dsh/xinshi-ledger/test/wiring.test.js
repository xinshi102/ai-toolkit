/**
 * 接线冒烟测试：mock ctx 驱动真实注册与执行路径
 * （两个工具 / 系统提示段 / /ledger 命令 / 只追加守卫 / .bak 备份 / 无损 JSON）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OBSERVE_TOOL,
  STATUS_TOOL,
  apply,
  formatStatus,
  resolveConfig,
} from "../lib/index.js";
import { assertAppendOnly } from "../lib/ledger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = readFileSync(path.join(here, "fixtures", "observations.md"), "utf8");
const URL_LEDGER = path.join(here, "fixtures", "observations.md");

/** 复刻宿主 snapshotJsonValue 的无损 JSON 规则（undefined / NaN / -0 一律非法）。 */
function assertLosslessJson(value, label = "value", seen = new Set()) {
  if (value === null) return;
  if (typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${label} 是非法数字 ${value}`);
    assert.ok(!Object.is(value, -0), `${label} 是 -0`);
    return;
  }
  assert.notEqual(value, undefined, `${label} 是 undefined`);
  assert.equal(typeof value, "object", `${label} 类型不支持：${typeof value}`);
  assert.ok(!seen.has(value), `${label} 出现环`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertLosslessJson(value[i], `${label}[${i}]`, seen);
  } else {
    assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} 不是纯对象`);
    for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function createMockCtx({ withCommands = true } = {}) {
  const registered = { tools: [], sections: [], commands: [], logs: [] };
  // commands 要同时挂在 ctx 上和 ctx.get() 里：插件的 ctx.inject(["commands"]) 走的是后者，
  // 两处不是同一个对象时会出现「注入成功但 register 不是函数」这种假故障。
  const commands = { register: (definition) => registered.commands.push(definition) };
  const store = withCommands ? { commands } : {};
  const ctx = {
    get: (name) => store[name],
    logger: {
      info: (...args) => registered.logs.push(["info", ...args]),
      warn: (...args) => registered.logs.push(["warn", ...args]),
    },
    inject: (names, fn) => {
      if (names.some((name) => store[name] === undefined)) return;
      const child = { ...ctx };
      for (const name of names) child[name] = store[name];
      fn(child);
    },
    tools: {
      register: (definition) => registered.tools.push(definition),
      get: (name) => (registered.tools.some((tool) => tool.name === name) ? {} : undefined),
    },
    systemPrompt: {
      section: (section) => registered.sections.push(section),
      getSectionOrder: (name) => (name === "PLAN_POLICY" ? 500 : 1000),
    },
    commands,
  };
  return { ctx, registered };
}

function setup({ config = {}, withCommands = true, file = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "xinshi-ledger-"));
  const ledger = path.join(dir, "observations.md");
  if (file) copyFileSync(URL_LEDGER, ledger);
  const { ctx, registered } = createMockCtx({ withCommands });
  apply(ctx, { file: ledger, ...config });
  return {
    dir,
    ledger,
    registered,
    tool: (name) => registered.tools.find((item) => item.name === name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const draft = {
  title: "台账靠手抄，漏字段没人拦",
  category: "执行效果不佳",
  problemClass: "规则观察写入无工具把关（靠手抄）",
  phenomenon: "写观察时漏了「涉及规则」与「证据」。",
  evidence: "plugins/xinshi-ledger 第一次试写。",
  task: "DSH 生态建设 / xinshi-ledger",
  rules: "`observations.md` §条目格式",
  confirmed: true,
};

test("注册：两个工具 + 提示段（order 480）+ /ledger 命令", () => {
  const env = setup();
  try {
    const observe = env.tool(OBSERVE_TOOL);
    const status = env.tool(STATUS_TOOL);
    assert.ok(observe !== undefined && status !== undefined);
    assert.equal(typeof observe.execute, "function");
    assert.equal(typeof status.output.render, "function");
    const section = env.registered.sections.find((item) => item.name === "xinshi-ledger:policy");
    assert.equal(section.order, 480, "PLAN_POLICY(500) 之前 20");
    assert.ok(section.text({ scope: undefined }).includes("ledger_observe"));
    assert.equal(env.registered.commands.length, 1);
    assert.equal(env.registered.commands[0].name, "ledger");
  } finally {
    env.cleanup();
  }
});

test("ledger_observe: 追加一条 + 更新频次索引 + 留 .bak，且输出是无损 JSON", async () => {
  const env = setup();
  try {
    const before = readFileSync(env.ledger, "utf8");
    const value = await env.tool(OBSERVE_TOOL).execute({ ...draft }, {});
    assertLosslessJson(value, "observe");
    assert.equal(value.id, "O007");
    assert.equal(value.count, 1);
    assert.equal(value.need, 2);
    assert.equal(value.reached, false);
    assert.equal(value.verdict, "L2 需 2 次（还差 1 次）");
    assert.equal(value.file, env.ledger);

    const after = readFileSync(env.ledger, "utf8");
    // 台账正中间就是频次索引表，那几行本来就会被更新；真正的「只追加」不变式是：
    // 除索引表行以外原有内容一字不动 + 条目数 +1。
    assert.equal(assertAppendOnly(before, after), true);
    assert.equal(after.indexOf("## O007"), after.lastIndexOf("## O"), "新条目只能出现在文件末尾");
    assert.ok(after.includes("## O007　台账靠手抄，漏字段没人拦"));
    assert.ok(after.includes("- 四问归类：执行效果不佳"));
    assert.ok(after.includes("| 规则观察写入无工具把关（靠手抄） | O007 | 1 | L2 需 2 次（还差 1 次） |"));
    assert.ok(existsSync(`${env.ledger}.bak`), "覆盖前留一份备份");
    assert.equal(readFileSync(`${env.ledger}.bak`, "utf8"), before);
    assert.ok(env.registered.logs.some(([level, message, ...rest]) => level === "info" && String(message).includes("追加 id=") && rest[0] === "O007"));
  } finally {
    env.cleanup();
  }
});

test("ledger_observe: 没填 task / rules 时写「（未填）」「无对应规则」，不写 undefined", async () => {
  const env = setup();
  try {
    const { task, rules, ...withoutOptional } = draft;
    assert.equal(task !== undefined && rules !== undefined, true, "草稿里本来有这两项，这里只是不传");
    await env.tool(OBSERVE_TOOL).execute({ ...withoutOptional }, {});
    const ledger = readFileSync(env.ledger, "utf8");
    assert.ok(!ledger.includes("undefined"), "台账里不能出现 undefined");
    assert.ok(ledger.includes("- 任务：（未填）"));
    assert.ok(ledger.includes("- 涉及规则：无对应规则"));
  } finally {
    env.cleanup();
  }
});

test("ledger_observe: 第二次同类问题达到 L2 门槛，输出会提示可以提案", async () => {
  const env = setup();
  try {
    await env.tool(OBSERVE_TOOL).execute({ ...draft }, {});
    const second = await env.tool(OBSERVE_TOOL).execute({ ...draft, title: "第二次又漏了证据" }, {});
    assert.equal(second.id, "O008");
    assert.equal(second.count, 2);
    assert.equal(second.reached, true);
    assert.equal(second.verdict, "已达 L2 的 2 次门槛");
    const text = env.tool(OBSERVE_TOOL).output.render(draft, second)[0].text;
    assert.ok(text.includes("可以走 proposals.md 提案了"));
    const ledger = readFileSync(env.ledger, "utf8");
    assert.ok(ledger.includes("| **规则观察写入无工具把关（靠手抄）** | O007、**O008** | **2** | **已达 L2 的 2 次门槛** |"));
  } finally {
    env.cleanup();
  }
});

test("ledger_observe: 没带 confirmed 就拒绝（台账规则：先经人类确认）", async () => {
  const env = setup();
  try {
    await assert.rejects(() => env.tool(OBSERVE_TOOL).execute({ ...draft, confirmed: false }, {}), /经人类确认后才追加/u);
    await assert.rejects(() => env.tool(OBSERVE_TOOL).execute({ ...draft, confirmed: undefined }, {}), /must be a boolean|missing "confirmed"/u);
    assert.equal(readFileSync(env.ledger, "utf8"), LEDGER, "拒绝时一个字都不能动");
  } finally {
    env.cleanup();
  }
});

test("ledger_observe: 参数不合格与文件异常都给得出人话", async () => {
  const env = setup();
  try {
    const tool = env.tool(OBSERVE_TOOL);
    await assert.rejects(() => tool.execute({ ...draft, category: "我编的" }, {}), /must be one of|四问归类/u);
    await assert.rejects(() => tool.execute({ ...draft, problemClass: "" }, {}), /缺少「问题类别」/u);
    await assert.rejects(() => tool.execute({ ...draft, evidence: " " }, {}), /缺少「证据」/u);
    await assert.rejects(() => tool.execute({ ...draft, level: "L9" }, {}), /must be one of/u);
    await assert.rejects(() => tool.execute({ ...draft, nope: 1 }, {}), /unknown argument/u);
  } finally {
    env.cleanup();
  }

  const missing = setup({ file: false });
  try {
    await assert.rejects(() => missing.tool(OBSERVE_TOOL).execute({ ...draft }, {}), /找不到台账文件/u);
  } finally {
    missing.cleanup();
  }

  const wrong = setup({ file: false });
  try {
    writeFileSync(wrong.ledger, "# 我的笔记\n\n随便写点\n");
    await assert.rejects(() => wrong.tool(OBSERVE_TOOL).execute({ ...draft }, {}), /不是规则观察台账/u);
    await assert.rejects(() => wrong.tool(STATUS_TOOL).execute({}, {}), /不是规则观察台账/u);
  } finally {
    wrong.cleanup();
  }
});

test("ledger_status: 条目数 / 下一编号 / 闸 0 达标情况，渲染给人看", async () => {
  const env = setup();
  try {
    const value = await env.tool(STATUS_TOOL).execute({}, {});
    assertLosslessJson(value, "status");
    assert.equal(value.entries, 5);
    assert.equal(value.lastId, "O006");
    assert.equal(value.nextId, "O007");
    assert.equal(value.reachedCount, 1);
    const row = value.rows.find((item) => item.problemClass === "立规后 L0~L2 改动绕过闭环");
    assert.equal(row.count, 3);
    assert.equal(row.reached, true);
    const text = env.tool(STATUS_TOOL).output.render({}, value)[0].text;
    assert.ok(text.includes("5 条观察"));
    assert.ok(text.includes("★ 立规后 L0~L2 改动绕过闭环：3 次"));
    assert.ok(text.includes("闸 0：1 个类别已达标"));
  } finally {
    env.cleanup();
  }
});

test("/ledger 命令：人类视角一行式结论；文件坏了给人话而不是抛错", () => {
  const env = setup();
  try {
    const command = env.registered.commands[0];
    const result = command.handler({ agent: {}, rawInput: "" });
    assert.equal(result.kind, "success");
    assert.ok(result.text.includes("规则观察台账：5 条观察"));
    assert.ok(result.text.includes("下一编号 O007"));
  } finally {
    env.cleanup();
  }

  const broken = setup({ file: false });
  try {
    const result = broken.registered.commands[0].handler({ agent: {}, rawInput: "" });
    assert.equal(result.kind, "error");
    assert.ok(result.text.includes("找不到台账文件"));
  } finally {
    broken.cleanup();
  }
});

test("没有 commands 服务时照常加载（只是少一条命令）", () => {
  const env = setup({ withCommands: false });
  try {
    assert.ok(env.tool(OBSERVE_TOOL) !== undefined, "工具不依赖 commands");
    assert.equal(env.registered.commands.length, 0);
  } finally {
    env.cleanup();
  }
});

test("resolveConfig: 默认落在 skill 的 share 目录；可覆盖；非法层级回落 L2", () => {
  const defaults = resolveConfig({}, { DSH_HOME: "/tmp/dsh" });
  assert.equal(defaults.file, "/tmp/dsh/skills/xinshiimprove/share/observations.md");
  assert.equal(defaults.level, "L2");
  assert.equal(defaults.backup, true);

  const custom = resolveConfig({ dir: "/tmp/pack", file: "/tmp/other/obs.md", level: "l0", backup: false });
  assert.equal(custom.file, "/tmp/other/obs.md");
  assert.equal(custom.level, "L0");
  assert.equal(custom.backup, false);
  assert.equal(resolveConfig({ dir: "/tmp/pack" }).file, "/tmp/pack/observations.md");
  assert.equal(resolveConfig({ level: "L9" }).level, "L2");
  assert.ok(resolveConfig({ file: "~/x/obs.md" }).file.endsWith("/x/obs.md"));
});

test("formatStatus: 没有达标类别时也不含糊", () => {
  const text = formatStatus({ entries: 0, lastId: "", nextId: "O001", rows: [] }, "/tmp/observations.md");
  assert.ok(text.includes("频次索引为空"));
  const text2 = formatStatus({
    entries: 1,
    lastId: "O001",
    nextId: "O002",
    rows: [{ problemClass: "某类问题", ids: ["O001"], count: 1, level: "L2", need: 2, reached: false, verdict: "L2 需 2 次（还差 1 次）" }],
  }, "/tmp/observations.md");
  assert.ok(text2.includes("闸 0：暂无达标类别"));
  assert.ok(text2.includes("· 某类问题：1 次"));
});
