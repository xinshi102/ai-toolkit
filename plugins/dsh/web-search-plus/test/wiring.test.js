/**
 * 接线冒烟测试：mock ctx 驱动真实注册与执行路径
 * （web_read 注册 / 缓存命中 / 预算续读 / 错误分支 / 系统提示段）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MAX_TOKENS,
  READ_PARAMS,
  READ_TOOL_NAME,
  apply,
  formatReadOutput,
  humanAge,
  isHttpUrl,
  normalizePlainBody,
  readPage,
  resolveConfig,
  validateArgs,
} from "../lib/index.js";
import { cacheKey, emptyCache, normalizeCache } from "../lib/cache.js";
import { estimateTokens } from "../lib/budget.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const EN = readFileSync(path.join(here, "fixtures", "article-en.html"), "utf8");
const URL_EN = "https://notes.example.com/p/streaming-token-budgets";

function createMockCtx(services = {}) {
  const registered = { tools: [], sections: [], logs: [] };
  const store = { ...services };
  const ctx = {
    get: (name) => store[name],
    logger: {
      info: (...args) => registered.logs.push(["info", ...args]),
      warn: (...args) => registered.logs.push(["warn", ...args]),
    },
    // 与 cordis 语义一致：依赖没到齐就不调用回调（服务后到时才生效）
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
      getSectionOrder: (name) => (name === "TOOL_WEB_FETCH" ? 2100 : 1000),
    },
  };
  return { ctx, registered };
}

/** 假 web 服务：记录调用，按 URL 返回预置页面。 */
function createFakeWeb(pages = {}) {
  const calls = [];
  return {
    calls,
    async fetch(request, signal) {
      calls.push({ url: request.url, hasSignal: signal !== undefined });
      const page = pages[request.url];
      if (page === undefined) throw new Error(`no fake page for ${request.url}`);
      if (typeof page === "function") return page(request);
      return page;
    },
  };
}

function setup({ pages = {}, config = {}, withWeb = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "web-plus-"));
  const web = createFakeWeb(pages);
  const { ctx, registered } = createMockCtx(withWeb ? { web } : {});
  apply(ctx, { cacheFile: path.join(dir, "cache.json"), ...config });
  const tool = registered.tools.find((definition) => definition.name === READ_TOOL_NAME);
  return { dir, web, registered, tool, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const okPage = (content, url = URL_EN) => ({ url, statusCode: 200, body: { kind: "html", content }, truncated: false });
const readCache = (dir) => normalizeCache(JSON.parse(readFileSync(path.join(dir, "cache.json"), "utf8")));

/**
 * 复刻宿主 `snapshotJsonValue`（@deepseek-ai/dsh-util-values）的「无损 JSON」规则：
 * undefined / NaN / ±Infinity / -0 / 非纯对象 一律判非法——工具输出里漏一个 undefined，
 * 整条输出会被宿主作废（线上真踩过：缓存命中路径的 region 是 undefined）。
 */
function assertLosslessJson(value, label = "value", seen = new Set()) {
  if (value === null) return;
  if (typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), `${label} 是非法数字 ${value}`);
    assert.ok(!Object.is(value, -0), `${label} 是 -0（宿主判非法）`);
    return;
  }
  assert.notEqual(value, undefined, `${label} 是 undefined（宿主判非法）`);
  assert.equal(typeof value, "object", `${label} 类型不支持：${typeof value}`);
  assert.ok(!seen.has(value), `${label} 出现环`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assert.ok(Object.hasOwn(value, i), `${label}[${i}] 是空槽`);
      assertLosslessJson(value[i], `${label}[${i}]`, seen);
    }
  } else {
    assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} 不是纯对象`);
    for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

test("注册：有 web 服务时注册 web_read，并挂上 web-search-plus 提示段（order 2100+10）", () => {
  const { tool, registered, cleanup } = setup({ pages: { [URL_EN]: okPage(EN) } });
  try {
    assert.ok(tool !== undefined, "web_read 必须注册");
    assert.equal(tool.parameters, READ_PARAMS);
    assert.equal(typeof tool.execute, "function");
    assert.equal(typeof tool.output.render, "function");
    assert.equal(typeof tool.presentCall, "function");
    assert.equal(tool.timeoutMs, 30000);
    assert.equal(tool.isConcurrencySafe(), true);
    const section = registered.sections.find((item) => item.name === "web-search-plus:policy");
    assert.ok(section !== undefined);
    assert.equal(section.order, 2110, "紧跟内置 TOOL_WEB_FETCH(2100) 之后");
    assert.ok(section.text({ scope: undefined }).includes("web_read"));
  } finally {
    cleanup();
  }
});

test("注册：没有 web 服务时不注册工具、也不抛错（只留一条 warn）", () => {
  const { tool, registered, cleanup } = setup({ withWeb: false });
  try {
    assert.equal(tool, undefined);
    const section = registered.sections.find((item) => item.name === "web-search-plus:policy");
    assert.equal(section.text({ scope: undefined }), "", "没有工具时提示段必须是空的（不白花 token）");
    assert.ok(registered.logs.some(([level, message]) => level === "warn" && String(message).includes("没有可用的 web 服务")));
  } finally {
    cleanup();
  }
});

test("web_read: 抓取 → 抽正文 → 按预算交付，并把结果写进缓存", async () => {
  const { tool, web, dir, cleanup } = setup({ pages: { [URL_EN]: okPage(EN) } });
  try {
    const value = await tool.execute({ url: URL_EN }, { signal: undefined });
    assertLosslessJson(value, "read");
    assert.equal(value.ok, true);
    assert.equal(value.mode, "read");
    assert.equal(value.cached, false);
    assert.equal(value.statusCode, 200);
    assert.equal(value.title, "Streaming Token Budgets");
    assert.equal(value.truncated, false);
    assert.equal(web.calls.length, 1);
    assert.ok(web.calls[0].hasSignal === false, "没有取消信号时不该伪造一个");
    assert.ok(value.content.includes("Every tool call that returns a web page spends context."));
    assert.ok(!value.content.includes("We use cookies"));
    assert.equal(value.tokens, estimateTokens(value.content));
    assert.ok(value.tokens <= DEFAULT_MAX_TOKENS + 60, `默认预算下交付 ${value.tokens} token`);

    const cache = readCache(dir);
    const entry = cache.entries[cacheKey(URL_EN)];
    assert.ok(entry !== undefined, "抽取结果应当落盘");
    assert.equal(entry.statusCode, 200);
    assert.ok(entry.markdown.includes("Every tool call"));
    assert.equal(cache.stats.writes, 1);
  } finally {
    cleanup();
  }
});

test("web_read: 第二次读同一 URL 命中缓存（不再联网），统计数据可查", async () => {
  const { tool, web, cleanup } = setup({ pages: { [URL_EN]: okPage(EN) } });
  try {
    const first = await tool.execute({ url: URL_EN, maxTokens: 300 }, {});
    const second = await tool.execute({ url: `${URL_EN}?utm_source=twitter`, maxTokens: 300 }, {});
    // 命中缓存的那次也必须是无损 JSON——展示字段（正文区/最终地址）要跟着缓存回来
    assertLosslessJson(first, "first");
    assertLosslessJson(second, "second");
    assert.equal(second.region, first.region, "缓存命中要保留正文区标记");
    assert.equal(second.statusCode, first.statusCode);
    assert.equal(second.suspicious, false);
    assert.equal(web.calls.length, 1, "带 utm 的同一个 URL 不该再联网");
    assert.equal(second.cached, true);
    assert.ok(second.ageMs >= 0);
    assert.equal(second.content, first.content, "命中缓存后交付内容要一致");

    const stats = await tool.execute({ stats: true }, {});
    assertLosslessJson(stats, "stats");
    assert.equal(stats.mode, "stats");
    assert.equal(stats.cacheEntries, 1);
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.cacheWrites, 1);
    assert.ok(stats.cacheTokens > 0);
    assert.ok(formatReadOutput(stats).includes("本地缓存"));
  } finally {
    cleanup();
  }
});

test("web_read: fresh=true 绕过缓存；404 不入缓存（下次仍会重抓）", async () => {
  const notFound = { url: URL_EN, statusCode: 404, body: { kind: "html", content: "<html><body><h1>404</h1><p>Not found</p></body></html>" }, truncated: false };
  const { tool, web, dir, cleanup } = setup({ pages: { [URL_EN]: okPage(EN) } });
  try {
    await tool.execute({ url: URL_EN }, {});
    web.calls.length = 0;
    const fresh = await tool.execute({ url: URL_EN, fresh: true }, {});
    assert.equal(web.calls.length, 1, "fresh=true 必须重新联网");
    assert.equal(fresh.cached, false);
  } finally {
    cleanup();
  }

  const second = setup({ pages: { [URL_EN]: notFound } });
  try {
    const value = await second.tool.execute({ url: URL_EN }, {});
    assert.equal(value.statusCode, 404);
    assert.equal(readCache(second.dir).entries[cacheKey(URL_EN)], undefined, "错误页不入缓存");
    second.web.calls.length = 0;
    await second.tool.execute({ url: URL_EN }, {});
    assert.equal(second.web.calls.length, 1, "404 之后下一次仍要重新抓");
  } finally {
    second.cleanup();
  }
});

test("web_read: 非 HTML 响应（text/*）直接用原文，不做正文抽取", async () => {
  const { tool, cleanup } = setup({
    pages: { [URL_EN]: { url: URL_EN, statusCode: 200, body: { kind: "text", content: "# 标题\n\n正文\n\n\n\n\n结尾" }, truncated: false } },
  });
  try {
    const value = await tool.execute({ url: URL_EN }, {});
    assert.equal(value.region, "纯文本响应");
    assert.equal(value.content, "# 标题\n\n正文\n\n\n结尾");
    assert.equal(value.title, "");
  } finally {
    cleanup();
  }
});

test("web_read: 截断 → offset 续读能接上", async () => {
  const { tool, cleanup } = setup({ pages: { [URL_EN]: okPage(EN) } });
  try {
    const first = await tool.execute({ url: URL_EN, maxTokens: 120 }, {});
    assertLosslessJson(first, "truncated");
    assert.equal(first.truncated, true);
    assert.ok(first.nextOffset > 0);
    assert.ok(first.content.includes("offset="));
    const second = await tool.execute({ url: URL_EN, maxTokens: 120, offset: first.nextOffset }, {});
    assert.equal(second.truncated, true);
    assert.ok(second.nextOffset > first.nextOffset, "续读要往后走");
    assert.ok(!second.content.startsWith(first.content.slice(0, 40)), "续读不该从头再来");
  } finally {
    cleanup();
  }
});

test("web_read: 参数与失败路径都给得出人话（含 provider 错误码）", async () => {
  const { tool, cleanup } = setup({ pages: { [URL_EN]: okPage(EN) } });
  try {
    await assert.rejects(() => tool.execute({}, {}), /missing "url"/u);
    await assert.rejects(() => tool.execute({ url: "ftp://example.com/x" }, {}), /只支持 http\(s\) URL/u);
    await assert.rejects(() => tool.execute({ url: URL_EN, maxTokens: "很多" }, {}), /must be an integer/u);
    await assert.rejects(() => tool.execute({ url: URL_EN, maxTokens: 10 }, {}), /must be >= 100/u);
    await assert.rejects(() => tool.execute({ url: URL_EN, nope: 1 }, {}), /unknown argument "nope"/u);
    await assert.rejects(() => tool.execute("not an object", {}), /must be an object/u);
  } finally {
    cleanup();
  }

  const failing = setup({ pages: {} });
  try {
    await assert.rejects(() => failing.tool.execute({ url: URL_EN }, {}), /抓取失败/u);
  } finally {
    failing.cleanup();
  }

  const coded = setup({
    pages: {
      [URL_EN]: () => {
        const error = new Error("no provider available");
        error.code = "WEB_PROVIDER_UNAVAILABLE";
        throw error;
      },
    },
  });
  try {
    await assert.rejects(() => coded.tool.execute({ url: URL_EN }, {}), /\[WEB_PROVIDER_UNAVAILABLE\] no provider available/u);
  } finally {
    coded.cleanup();
  }
});

test("render / presentCall：模型看到的头部含来源、状态、缓存与截断信息", async () => {
  const { tool, cleanup } = setup({ pages: { [URL_EN]: okPage(EN) } });
  try {
    const value = await tool.execute({ url: URL_EN, maxTokens: 200 }, {});
    const text = tool.output.render({ url: URL_EN }, value)[0].text;
    assert.ok(text.startsWith(`来源: ${URL_EN}`));
    assert.ok(text.includes("HTTP 200"));
    assert.ok(text.includes("本次抓取"));
    assert.ok(text.includes("以下为外部网页内容"));
    assert.ok(text.includes("---"));
    const call = tool.presentCall({ url: URL_EN });
    assert.equal(call.card, "generic");
    assert.ok(call.title.includes("web_read"));
    assert.equal(tool.presentCall({ stats: true }).content[0].text, "缓存统计");
  } finally {
    cleanup();
  }
});

test("resolveConfig: 默认值、非法值回落、~ 展开与 DSH_HOME", () => {
  const defaults = resolveConfig({}, { DSH_HOME: "/tmp/dsh" });
  assert.equal(defaults.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(defaults.maxChars, 0);
  assert.equal(defaults.timeoutMs, 30000);
  assert.equal(defaults.cacheFile, "/tmp/dsh/storages/web-search-plus/cache.json");
  assert.ok(defaults.section.includes("web_read"));

  const custom = resolveConfig({ maxTokens: 400, maxChars: 900, ttlMs: 0, maxEntries: 5, cacheMaxChars: 5000, timeoutMs: 5000, cacheFile: "~/x/cache.json", section: " 自定义 " });
  assert.equal(custom.maxTokens, 400);
  assert.equal(custom.maxChars, 900);
  assert.equal(custom.ttlMs, 0);
  assert.equal(custom.maxEntries, 5);
  assert.equal(custom.timeoutMs, 5000);
  assert.ok(custom.cacheFile.endsWith("/x/cache.json") && !custom.cacheFile.startsWith("~"));
  assert.equal(custom.section, "自定义");

  const junk = resolveConfig({ maxTokens: -3, maxChars: 10, ttlMs: -1, maxEntries: 0, timeoutMs: "soon", maxInputChars: 0.5 });
  assert.equal(junk.maxTokens, DEFAULT_MAX_TOKENS);
  assert.equal(junk.maxChars, 0);
  assert.equal(junk.maxEntries, 200);
  assert.equal(junk.timeoutMs, 30000);
  assert.equal(junk.maxInputChars, 400000);
});

test("validateArgs / isHttpUrl / humanAge / normalizePlainBody 的边角", () => {
  assert.deepEqual(validateArgs({ url: URL_EN }), []);
  assert.deepEqual(validateArgs({ stats: true }), [], "stats 模式不需要 url");
  assert.ok(validateArgs({ url: "   " }).some((error) => error.includes("missing")));
  assert.ok(validateArgs({ url: URL_EN, fresh: "yes" }).some((error) => error.includes("must be a boolean")));
  assert.ok(validateArgs({ url: URL_EN, offset: -1 }).some((error) => error.includes(">= 0")));
  assert.equal(READ_PARAMS.properties.url.type, "string");

  assert.equal(isHttpUrl("https://a/b"), true);
  assert.equal(isHttpUrl("http://a"), true);
  assert.equal(isHttpUrl("file:///etc/passwd"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
  assert.equal(isHttpUrl("https://a b"), false);
  assert.equal(isHttpUrl(undefined), false);

  assert.equal(humanAge(500), "刚刚");
  assert.equal(humanAge(30_000), "30 秒");
  assert.equal(humanAge(5 * 60_000), "5 分钟");
  assert.equal(humanAge(3 * 3600_000), "3 小时");
  assert.equal(humanAge(2 * 86400_000), "2 天");
  assert.equal(humanAge(Number.NaN), "刚刚");

  assert.equal(normalizePlainBody("a\r\n\r\n\r\n\r\n\r\nb"), "a\n\n\nb");
  assert.equal(normalizePlainBody(undefined), "");
});

test("readPage: html 走抽取、text 走原文，并带上正文区标记", () => {
  const html = readPage({ url: URL_EN, statusCode: 200, body: { kind: "html", content: EN } }, URL_EN, {});
  assert.equal(html.statusCode, 200);
  assert.equal(html.title, "Streaming Token Budgets");
  assert.ok(html.region.includes("main"));
  assert.ok(!html.markdown.includes("We use cookies"));

  const plain = readPage({ url: URL_EN, statusCode: 200, body: { kind: "text", content: "hello" } }, URL_EN, {});
  assert.equal(plain.region, "纯文本响应");
  assert.equal(plain.markdown, "hello");

  const cut = readPage({ url: URL_EN, statusCode: 200, body: { kind: "html", content: EN }, truncated: true }, URL_EN, {});
  assert.ok(cut.markdown.includes("上游响应被提供方截断"));

  const empty = readPage({ url: URL_EN, statusCode: 204 }, URL_EN, {});
  assert.equal(empty.region, "空响应");
  assert.equal(empty.markdown, "");
  assert.equal(empty.statusCode, 204);
});

test("缓存文件是普通 JSON：能直接拿 stats 与条目做人工核对", async () => {
  const { tool, dir, cleanup } = setup({ pages: { [URL_EN]: okPage(EN) } });
  try {
    await tool.execute({ url: URL_EN, maxTokens: 200 }, {});
    const raw = JSON.parse(readFileSync(path.join(dir, "cache.json"), "utf8"));
    assert.equal(raw.version, 1);
    assert.equal(Object.keys(raw.entries).length, 1);
    const [entry] = Object.values(raw.entries);
    assert.equal(entry.url, URL_EN);
    assert.equal(entry.statusCode, 200);
    assert.ok(entry.fetchedAt > 0);
    assert.deepEqual(emptyCache().entries, {});
  } finally {
    cleanup();
  }
});

test("web_read: 重定向页面按「请求的 URL」缓存（第二次必须命中）", async () => {
  const requested = "https://nodejs.org/en/learn/getting-started/introduction-to-nodejs";
  const final = `${requested}/`;
  const { tool, web, cleanup } = setup({
    pages: { [requested]: { url: final, statusCode: 200, body: { kind: "html", content: EN }, truncated: false } },
  });
  try {
    const first = await tool.execute({ url: requested }, {});
    assert.equal(first.url, final, "展示与引用用最终地址");
    assert.equal(first.requestedUrl, requested, "缓存键用请求地址");
    const second = await tool.execute({ url: requested }, {});
    assert.equal(web.calls.length, 1, "重定向页第二次读也必须命中缓存");
    assert.equal(second.cached, true);
    assert.ok(tool.output.render({ url: requested }, first)[0].text.includes("重定向到这里"));
  } finally {
    cleanup();
  }
});

test("web_read: 正文缺失时明确告知模型（suspicious + ⚠ 行），不假装省了 100%", async () => {
  const shell = `<html><body><nav class="td-sidebar-nav">${Array.from({ length: 120 }, (_, i) => `<a href="/docs/p${i}">Kubernetes Documentation Section ${i} with a fairly long label</a>`).join("")}</nav><main><h1>Pods</h1><p>Loading…</p></main></body></html>`;
  const { tool, registered, cleanup } = setup({ pages: { [URL_EN]: okPage(shell) } });
  try {
    const value = await tool.execute({ url: URL_EN }, {});
    assertLosslessJson(value, "suspicious");
    assert.equal(value.suspicious, true);
    assert.ok(value.notice.includes("脚本渲染"));
    const text = tool.output.render({ url: URL_EN }, value)[0].text;
    assert.ok(text.startsWith("⚠ "), "可疑内容必须在模型看到的正文最前面提醒");
    assert.ok(text.includes("web_fetch 看原始响应"));
    assert.ok(registered.logs.some(([level, message]) => level === "warn" && String(message).includes("抽取结果可疑")));
  } finally {
    cleanup();
  }
});
