/**
 * 接线冒烟测试：mock ctx 驱动 prompt-snippets——命令族全流程（保存/列表/插入/删除），
 * 用真实临时目录验证 JSON 存储往返。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { apply } from "../lib/index.js";

function createSession() {
  const events = [];
  return {
    events,
    eventAt: (seq) => events.find((e) => e.seq === seq),
    append(type, data) {
      const seq = events.length + 1;
      events.push({ type, data, seq });
      return { seq };
    },
  };
}

function createMockCtx(services = {}) {
  const registered = { tools: [], projections: [], commands: [], hooks: new Map(), logs: [] };
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
    on: () => {},
    tools: { register: (def) => registered.tools.push(def) },
    systemPrompt: { section: () => {}, getSectionOrder: () => 500 },
    sessionProjections: { register: () => {}, stateOf: () => undefined },
    commands: { register: (def) => registered.commands.push(def) },
  };
  return { ctx, registered };
}

async function setup(config = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "snippets-wiring-"));
  const { ctx, registered } = createMockCtx();
  apply(ctx, { root, ...config });
  const command = registered.commands.find((c) => c.name === "snippet");
  const injected = [];
  const agent = { session: createSession(), inject: (m) => injected.push(m), steer: (m) => injected.push(m) };
  return { root, command, agent, injected };
}

test("命令族：save → list → --json → insert → rm → 空库提示", async () => {
  const { root, command, agent, injected } = await setup();

  const empty = await command.handler({ agent, rawInput: "" });
  assert.match(empty.text, /snippet 库为空/);

  const saved = await command.handler({ agent, rawInput: "save review 请审查这段代码的边界情况" });
  assert.equal(saved.kind, "success");
  assert.match(saved.text, /已保存 snippet「review」/);

  const listed = await command.handler({ agent, rawInput: "" });
  assert.match(listed.text, /review/);

  const json = await command.handler({ agent, rawInput: "--json" });
  const parsed = JSON.parse(json.text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, "review");
  assert.equal(parsed[0].body, "请审查这段代码的边界情况");

  const inserted = await command.handler({ agent, rawInput: "review" });
  assert.equal(inserted.kind, "success");
  assert.equal(injected.length, 1);
  assert.equal(injected[0].content[0].text, "请审查这段代码的边界情况");
  assert.equal(injected[0].source.kind, "user");

  const removed = await command.handler({ agent, rawInput: "rm review" });
  assert.equal(removed.kind, "success");
  const after = await command.handler({ agent, rawInput: "" });
  assert.match(after.text, /snippet 库为空/);

  // 真的落盘了
  const text = await readFile(path.join(root, "snippets.json"), "utf8");
  assert.deepEqual(JSON.parse(text).snippets, {});
});

test("命令族：错误路径", async () => {
  const { command, agent } = await setup({ maxBodyChars: 5 });
  assert.equal((await command.handler({ agent, rawInput: "save" })).kind, "error");
  assert.equal((await command.handler({ agent, rawInput: "save ok" })).kind, "error");
  assert.equal((await command.handler({ agent, rawInput: "save bad!name body" })).kind, "error");
  assert.equal((await command.handler({ agent, rawInput: "rm nothing" })).kind, "error");
  assert.equal((await command.handler({ agent, rawInput: "nothing" })).kind, "error");
  // 正文按 maxBodyChars 截断
  await command.handler({ agent, rawInput: "save tiny 1234567890" });
  const json = JSON.parse((await command.handler({ agent, rawInput: "--json" })).text);
  assert.equal(json[0].body, "12345");
});

test("maxSnippets 上限", async () => {
  const { command, agent } = await setup({ maxSnippets: 1 });
  assert.equal((await command.handler({ agent, rawInput: "save a 1" })).kind, "success");
  assert.equal((await command.handler({ agent, rawInput: "save b 2" })).kind, "error");
});
