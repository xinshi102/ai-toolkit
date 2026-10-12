import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listSnippets,
  parseStore,
  removeSnippet,
  resolveRoot,
  serializeStore,
  upsertSnippet,
} from "../lib/index.js";

test("parseStore: 空/损坏/旧格式/脏数据", () => {
  assert.deepEqual(parseStore(""), { version: 1, snippets: {} });
  assert.deepEqual(parseStore("{oops"), { version: 1, snippets: {} });
  assert.deepEqual(parseStore(JSON.stringify({ snippets: { a: "正文" } })), { version: 1, snippets: { a: { body: "正文", updatedAt: 0 } } });
  const dirty = parseStore(JSON.stringify({ snippets: { ok: { body: "b", updatedAt: 5 }, "bad name!": { body: "x" }, nope: 42 } }));
  assert.deepEqual(Object.keys(dirty.snippets), ["ok"]);
  assert.equal(dirty.snippets.ok.updatedAt, 5);
});

test("serializeStore: 名称排序、内容稳定", () => {
  const store = { version: 1, snippets: { b: { body: "B", updatedAt: 2 }, a: { body: "A", updatedAt: 1 } } };
  const text = serializeStore(store);
  assert.ok(text.indexOf('"a"') < text.indexOf('"b"'));
  assert.deepEqual(parseStore(text), store);
});

test("upsertSnippet: 名称校验 / 空正文 / 上限 / 更新不占额度", () => {
  const limits = { maxSnippets: 2, maxBodyChars: 10 };
  let store = { version: 1, snippets: {} };
  store = upsertSnippet(store, "a", "12345678901", limits).store; // 截断到 10
  assert.equal(store.snippets.a.body, "1234567890");
  store = upsertSnippet(store, "b", "x", limits).store;
  assert.equal(upsertSnippet(store, "c", "y", limits).ok, false); // 上限
  const again = upsertSnippet(store, "a", "z", limits); // 更新老名字不占额度
  assert.equal(again.ok, true);
  assert.equal(upsertSnippet(store, "bad name", "x", limits).ok, false);
  assert.equal(upsertSnippet(store, "a", "   ", limits).ok, false);
});

test("removeSnippet: 不存在报错", () => {
  const store = { version: 1, snippets: { a: { body: "A", updatedAt: 0 } } };
  assert.equal(removeSnippet(store, "zz").ok, false);
  assert.ok(!Object.hasOwn(removeSnippet(store, "a").store.snippets, "a"));
});

test("listSnippets: 按名排序", () => {
  const store = { version: 1, snippets: { b: { body: "B", updatedAt: 0 }, a: { body: "A", updatedAt: 0 } } };
  assert.deepEqual(listSnippets(store).map((s) => s.name), ["a", "b"]);
});

test("resolveRoot: ~ 展开与绝对路径直通", () => {
  assert.equal(resolveRoot({ root: "~/.dsh/snippets" }), `${process.env.HOME}/.dsh/snippets`);
  assert.equal(resolveRoot({}), `${process.env.HOME}/.dsh/snippets`);
  assert.equal(resolveRoot({ root: "/abs/path" }), "/abs/path");
});

test("存储往返：写文件再读回", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "snippets-"));
  const storePath = path.join(dir, "snippets.json");
  const store = upsertSnippet({ version: 1, snippets: {} }, "demo", "你好，世界").store;
  await writeFile(storePath, serializeStore(store), "utf8");
  const back = parseStore(await readFile(storePath, "utf8"));
  assert.equal(back.snippets.demo.body, "你好，世界");
});
