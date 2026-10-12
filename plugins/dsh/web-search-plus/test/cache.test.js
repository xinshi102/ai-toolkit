import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CACHE_VERSION,
  cacheGet,
  cacheKey,
  cacheMiss,
  cachePut,
  cacheStats,
  cacheTouch,
  createStore,
  defaultCacheFile,
  emptyCache,
  evict,
  normalizeCache,
  normalizeUrl,
  pruneCache,
} from "../lib/cache.js";

const entryOf = (url, markdown, extra = {}) => ({ url, markdown, title: "t", statusCode: 200, ...extra });

test("normalizeUrl: 去 fragment / 追踪参数 / 默认端口，host 小写", () => {
  assert.equal(normalizeUrl("https://Example.COM:443/a/b?x=1#frag"), "https://example.com/a/b?x=1");
  assert.equal(normalizeUrl("http://example.com:80/a"), "http://example.com/a");
  assert.equal(normalizeUrl("https://example.com/a?utm_source=x&utm_medium=y&id=7"), "https://example.com/a?id=7");
  assert.equal(normalizeUrl("https://example.com/a?fbclid=abc&spm=1.2&ref=home"), "https://example.com/a");
  assert.equal(normalizeUrl("  https://example.com/a  "), "https://example.com/a");
  assert.equal(normalizeUrl("not a url"), "not a url", "解析不了就原样返回，不抛错");
  assert.equal(normalizeUrl(""), "");
});

test("cacheKey: 同一篇文章的不同追踪参数命中同一个键", () => {
  const a = cacheKey("https://example.com/post?utm_source=twitter");
  const b = cacheKey("https://example.com/post?utm_source=weibo");
  const c = cacheKey("https://example.com/other");
  assert.equal(a, b, "utm 变体必须同键，否则白花钱重抓");
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{32}$/u);
});

test("cacheGet/cachePut/cacheTouch: 命中、过期、未命中三条路径", () => {
  let cache = emptyCache();
  const lookupMiss = cacheGet(cache, "https://example.com/a", { now: 1000, ttlMs: 100 });
  assert.equal(lookupMiss.hit, false);
  assert.equal(lookupMiss.reason, "miss");

  cache = cachePut(cache, entryOf("https://example.com/a", "正文"), { now: 1000 });
  const hit = cacheGet(cache, "https://example.com/a", { now: 1050, ttlMs: 100 });
  assert.equal(hit.hit, true);
  assert.equal(hit.entry.markdown, "正文");
  assert.equal(hit.ageMs, 50);

  const expired = cacheGet(cache, "https://example.com/a", { now: 1200, ttlMs: 100 });
  assert.equal(expired.hit, false);
  assert.equal(expired.reason, "expired");
  assert.equal(expired.entry.markdown, "正文", "过期条目仍在缓存里，只是不命中");

  cache = cacheTouch(cache, cacheKey("https://example.com/a"), { now: 1200 });
  assert.equal(cache.stats.hits, 1);
  assert.equal(cache.entries[cacheKey("https://example.com/a")].hits, 1);
  assert.equal(cache.entries[cacheKey("https://example.com/a")].lastUsedAt, 1200);

  cache = cacheMiss(cache);
  assert.equal(cache.stats.misses, 1);
  assert.equal(cache.stats.writes, 1);
});

test("evict: 条目数超限按 LRU 淘汰；总字符超限也淘汰；刚用过的留下", () => {
  let cache = emptyCache();
  cache = cachePut(cache, entryOf("https://example.com/1", "a".repeat(100)), { now: 10 });
  cache = cachePut(cache, entryOf("https://example.com/2", "b".repeat(100)), { now: 20 });
  cache = cachePut(cache, entryOf("https://example.com/3", "c".repeat(100)), { now: 30 });
  const kept = evict(cache, { maxEntries: 2, maxChars: 1e9 });
  assert.deepEqual(Object.values(kept.entries).map((e) => e.url).sort(), ["https://example.com/2", "https://example.com/3"]);
  assert.equal(kept.stats.evictions, 1);

  // 把最老的 2 号重新用一次 → 现在该淘汰 3 号之前没人用的那个
  const touched = cacheTouch(kept, cacheKey("https://example.com/2"), { now: 40 });
  const kept2 = evict(touched, { maxEntries: 2, maxChars: 1e9 });
  assert.deepEqual(Object.values(kept2.entries).map((e) => e.url).sort(), ["https://example.com/2", "https://example.com/3"]);

  const byChars = evict(cache, { maxEntries: 99, maxChars: 150 });
  assert.equal(Object.keys(byChars.entries).length, 1, "总字符超限时也要淘汰");
  assert.ok(byChars.stats.evictions >= 2);
});

test("evict: 永远至少留一条（不能把缓存清空成永不复用）", () => {
  let cache = emptyCache();
  cache = cachePut(cache, entryOf("https://example.com/big", "x".repeat(10000)), { now: 1 });
  const kept = evict(cache, { maxEntries: 1, maxChars: 10 });
  assert.equal(Object.keys(kept.entries).length, 1);
});

test("pruneCache: 按 TTL 清掉过期条目", () => {
  let cache = emptyCache();
  cache = cachePut(cache, entryOf("https://example.com/old", "old"), { now: 1000 });
  cache = cachePut(cache, entryOf("https://example.com/new", "new"), { now: 9000 });
  const pruned = pruneCache(cache, { now: 10000, ttlMs: 5000 });
  assert.deepEqual(Object.values(pruned.entries).map((e) => e.url), ["https://example.com/new"]);
  assert.equal(pruned.stats.evictions, 1);
  assert.equal(pruneCache(pruned, { now: 10000, ttlMs: 5000 }), pruned, "没有可清的就原样返回（不制造新对象）");
});

test("normalizeCache: 坏文件 / 旧版本一律降级成空缓存，不崩", () => {
  assert.equal(normalizeCache(null).entries && Object.keys(normalizeCache(null).entries).length, 0);
  assert.equal(normalizeCache({ version: 999, entries: { a: { url: "x", markdown: "y" } } }).entries.a, undefined, "版本不符要整份作废");
  const messy = normalizeCache({ version: CACHE_VERSION, entries: { a: { url: "https://e/1", markdown: "m" }, b: { nope: true }, c: { url: 1, markdown: 2 } }, stats: { hits: "x" } });
  assert.deepEqual(Object.keys(messy.entries), ["a"], "结构不对的条目直接丢");
  assert.equal(messy.stats.hits, 0, "脏统计归零");
  assert.equal(messy.entries.a.fetchedAt, 0);
});

test("cacheStats: 条目/字符/token/命中数汇总", () => {
  let cache = emptyCache();
  cache = cachePut(cache, entryOf("https://example.com/a", "a".repeat(400)), { now: 100 });
  cache = cachePut(cache, entryOf("https://example.com/b", "b".repeat(400)), { now: 200 });
  cache = cacheTouch(cache, cacheKey("https://example.com/a"), { now: 300 });
  cache = cacheTouch(cache, cacheKey("https://example.com/a"), { now: 400 });
  const stats = cacheStats(cache, { now: 500 });
  assert.equal(stats.entries, 2);
  assert.equal(stats.chars, 800);
  assert.equal(stats.tokens, 200);
  assert.equal(stats.hits, 2);
  assert.equal(stats.writes, 2);
  assert.equal(stats.ageMs, 300, "最近一次写入是 now - 200");
});

test("createStore: 原子落盘 + 重新读回；坏文件当作空缓存", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "web-plus-cache-"));
  try {
    const file = path.join(dir, "nested", "cache.json");
    const store = createStore({ file });
    assert.deepEqual(store.read(), emptyCache(), "文件不存在时是空缓存");
    const cache = cachePut(emptyCache(), entryOf("https://example.com/a", "正文"), { now: 5 });
    assert.equal(store.write(cache), true);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).entries[cacheKey("https://example.com/a")].markdown, "正文");
    const reloaded = createStore({ file }).read();
    assert.equal(reloaded.entries[cacheKey("https://example.com/a")].markdown, "正文");

    // 半截 JSON（模拟断电/写坏）：读回时降级，不抛
    writeFileSync(file, "{\"version\":1,\"entries\":{\"a\":");
    assert.deepEqual(createStore({ file }).read().entries, {});

    // 目录都建不出来时 write 返回 false，不抛
    const blocked = createStore({ file: "/dev/null/nope/cache.json" });
    assert.equal(blocked.write(cache), false);
    assert.equal(createStore({ file: "" }).write(cache), false, "没有文件路径时只在内存里");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultCacheFile: 跟随 $DSH_HOME，否则落到 ~/.dsh", () => {
  assert.equal(defaultCacheFile({ DSH_HOME: "/tmp/dsh-home" }, "/home/x"), "/tmp/dsh-home/storages/web-search-plus/cache.json");
  assert.equal(defaultCacheFile({}, "/home/x"), "/home/x/.dsh/storages/web-search-plus/cache.json");
  assert.equal(defaultCacheFile({ DSH_HOME: "  " }, "/home/x"), "/home/x/.dsh/storages/web-search-plus/cache.json");
});

test("缓存往返：展示元数据（最终地址 / 正文区 / 可疑 / 告警）必须跟着回来", () => {
  const entry = {
    url: "https://example.com/post",
    finalUrl: "https://example.com/post/",
    title: "标题",
    markdown: "正文",
    statusCode: 200,
    region: "main（main）",
    suspicious: false,
    notice: "",
  };
  const cache = cachePut(emptyCache(), entry, { now: 1000 });
  const round = normalizeCache(JSON.parse(JSON.stringify(cache)));
  const stored = round.entries[cacheKey(entry.url)];
  assert.equal(stored.finalUrl, "https://example.com/post/");
  assert.equal(stored.region, "main（main）");
  assert.equal(stored.suspicious, false);
  assert.equal(stored.notice, "");

  // 带告警的条目也要能存回来
  const flagged = normalizeCache(JSON.parse(JSON.stringify(cachePut(emptyCache(), { ...entry, url: "https://example.com/shell", suspicious: true, notice: "正文可能由脚本渲染" }, { now: 1000 }))));
  const shellEntry = flagged.entries[cacheKey("https://example.com/shell")];
  assert.equal(shellEntry.suspicious, true);
  assert.equal(shellEntry.notice, "正文可能由脚本渲染");
});

test("缓存往返：老条目缺展示字段时给默认值（不能变成 undefined 漏给模型）", () => {
  // 0.1.0 老版本写下的条目形状：没有 finalUrl / region / suspicious / notice
  const legacy = {
    version: CACHE_VERSION,
    entries: {
      abc: { key: "abc", url: "https://example.com/old", title: "t", markdown: "m", statusCode: 200, fetchedAt: 5, lastUsedAt: 5, hits: 1 },
    },
    stats: {},
  };
  const normalized = normalizeCache(JSON.parse(JSON.stringify(legacy)));
  const stored = normalized.entries.abc;
  assert.equal(stored.finalUrl, "https://example.com/old", "最终地址回落成 URL 本身");
  assert.equal(stored.region, "");
  assert.equal(stored.suspicious, false);
  assert.equal(stored.notice, "");
  for (const value of Object.values(stored)) assert.notEqual(value, undefined, "任何字段都不能是 undefined");
});
