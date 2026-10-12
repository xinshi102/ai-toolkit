import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "../lib/budget.js";
import { SUPPRESS_SECTION, cleanLines, extract, normalizeInline, selectRegion, titleOf } from "../lib/extract.js";
import { parseHtml, textOf } from "../lib/html.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, "fixtures", name), "utf8");
const EN = fixture("article-en.html");
const ZH = fixture("article-zh.html");
const WIKI = fixture("wiki-shaped.html");
const SHELL = fixture("js-shell.html");
const URL_EN = "https://notes.example.com/p/streaming-token-budgets";

/** 整页可见文本的 token 数：抽取的对照基线（真实基线由 verify §12 用 turndown 复刻）。 */
function visibleTokens(html) {
  return estimateTokens(textOf(parseHtml(html)));
}

test("extract: 英文文章页——正文/代码/列表/表格/引用都在，模板噪音全不在", () => {
  const result = extract(EN, { url: URL_EN });
  assert.equal(result.title, "Streaming Token Budgets", "og:title 优先于 <title>");
  assert.equal(result.region.tag, "main");
  const md = result.markdown;

  // 保住的正文
  assert.ok(md.includes("# Streaming Token Budgets"));
  assert.ok(md.includes("Every tool call that returns a web page spends context."), "首段不能丢");
  assert.ok(md.includes("```json"), "代码块要带语言围栏");
  assert.ok(md.includes('"nextOffset": 4820'), "代码块内容原样");
  assert.ok(md.includes("- Cut on a paragraph boundary when one is available"), "列表项要保留");
  assert.ok(md.includes("| Policy | Tokens per read | Notes |"), "表格要渲染成 GFM 表");
  assert.ok(md.includes("| Extracted + budget | 1,350 | This note |"));
  assert.ok(md.includes("> A budget without a continuation marker is a lie with good manners."), "引用要保留");
  assert.ok(md.includes("## Why extraction beats truncation"));
  assert.ok(md.includes("By Dana Whitfield"), "文章自己的 header（作者行）要留");

  // 丢掉的模板噪音
  for (const noise of ["We use cookies", "Accept all", "Buy the ultimate observability suite", "Popular posts",
    "Related reading", "24 comments", "Great write-up", "All rights reserved", "Terms of service", "Sign up"]) {
    assert.ok(!md.includes(noise), `模板噪音「${noise}」没有清掉`);
  }
  assert.ok(result.stats.codeBlocks >= 1 && result.stats.tables >= 1 && result.stats.listItems >= 3);
});

test("extract: 中文页（没有 article/main，走打分路径）——正文保住、广告与相关阅读丢掉", () => {
  const result = extract(ZH, { url: "https://blog.example.cn/a/layout" });
  assert.ok(result.title.startsWith("计划树插件是怎么排版的"), `title=${result.title}`);
  assert.equal(result.region.tag, "div");
  assert.equal(result.region.reason, "scored", "没有语义容器时必须靠打分选出来");
  const md = result.markdown;
  assert.ok(md.includes("计划树最难的不是画节点"));
  assert.ok(md.includes("```js"));
  assert.ok(md.includes("- 节点高 34px"));
  assert.ok(md.includes("## 连线为什么用折线"));
  for (const noise of ["热门文章", "关注公众号", "限时优惠", "相关阅读", "版权所有", "RSS 订阅"]) {
    assert.ok(!md.includes(noise), `中文模板噪音「${noise}」没有清掉`);
  }
});

test("extract: 链接绝对化到页面 URL；页内脚注标记不发 URL", () => {
  const md = extract(WIKI, { url: "https://en.wikipedia.org/wiki/Layout_engine" }).markdown;
  assert.ok(md.includes("[web browser](https://en.wikipedia.org/wiki/Web_browser)"), "相对链接要补成绝对 URL");
  assert.ok(!/\[\d+\]/u.test(md), "`[1]` 这类脚注锚点应当直接丢掉");
  assert.ok(!md.includes("cite_note"), "页内锚点不该变成 URL");
});

test("extract: 参考资料 / 参见 / 外部链接 小节被抑制——且抑制跨 <div class=\"mw-heading\"> 生效", () => {
  const md = extract(WIKI, { url: "https://en.wikipedia.org/wiki/Layout_engine" }).markdown;
  for (const noise of ["See also", "References", "External links", "Cormen", "BookSources", "Privacy policy", "Disclaimers"]) {
    assert.ok(!md.includes(noise), `「${noise}」应当被抑制`);
  }
  assert.ok(md.includes("## History"), "抑制只针对参考资料类小节，正文标题要留");
  assert.ok(md.includes("### Incremental layout"), "同级之后的小节也要留");
  assert.ok(SUPPRESS_SECTION.test("参考文献") && SUPPRESS_SECTION.test("External links"));
  assert.ok(!SUPPRESS_SECTION.test("History"), "正常标题不能被误判");
});

test("extract: 抽取后的 token 明显小于整页可见文本", () => {
  const en = extract(EN, { url: URL_EN }).markdown;
  const zh = extract(ZH, { url: "https://blog.example.cn/a/layout" }).markdown;
  const wiki = extract(WIKI, { url: "https://en.wikipedia.org/wiki/Layout_engine" }).markdown;
  const ratio = (out, html) => estimateTokens(out) / visibleTokens(html);
  assert.ok(ratio(en, EN) <= 0.7, `英文文章页比例 ${ratio(en, EN).toFixed(2)} 应 <= 0.70`);
  assert.ok(ratio(zh, ZH) <= 0.7, `中文页比例 ${ratio(zh, ZH).toFixed(2)} 应 <= 0.70`);
  assert.ok(ratio(wiki, WIKI) <= 0.5, `模板很重的页面比例 ${ratio(wiki, WIKI).toFixed(2)} 应 <= 0.50`);
});

test("extract: titleOf 三级回退（og:title → title → h1）", () => {
  assert.equal(titleOf(parseHtml(`<head><meta property="og:title" content="A"><title>B</title></head><body><h1>C</h1></body>`)), "A");
  assert.equal(titleOf(parseHtml(`<head><title>B</title></head><body><h1>C</h1></body>`)), "B");
  assert.equal(titleOf(parseHtml(`<body><h1>C</h1></body>`)), "C");
  assert.equal(titleOf(parseHtml(`<body><p>no title</p></body>`)), "");
});

test("selectRegion: <article>/<main> 太小就不采信，仍走打分", () => {
  const html = `<body><main><p>短</p></main><div class="post-content">${"<p>正文段落，足够长，可以用来打分。</p>".repeat(40)}</div></body>`;
  const region = selectRegion(parseHtml(html));
  assert.equal(region.reason, "scored", "main 只有两个字符，不该被直接采信");
  assert.ok(region.node.name === "div");
});

test("extract: maxInputChars 截断输入也不抛错", () => {
  const result = extract(EN, { url: URL_EN, maxInputChars: 300 });
  assert.equal(typeof result.markdown, "string");
  assert.ok(result.markdown.length <= 300);
  assert.ok(result.stats.sourceChars <= 300);
});

test("cleanLines: 丢样板行与纯导航行，代码围栏内一个字都不动", () => {
  const raw = [
    "正文第一行",
    "Accept all cookies",
    "- [Home](https://example.com/home)",
    "正文第一行",
    "```js",
    "  const a = 1;   // 这里的空格与缩进必须原样",
    "  Accept all cookies",
    "```",
    "返回顶部",
    "正文第二行",
  ];
  const cleaned = cleanLines(raw);
  assert.deepEqual(cleaned.lines, [
    "正文第一行",
    "```js",
    "  const a = 1;   // 这里的空格与缩进必须原样",
    "  Accept all cookies",
    "```",
    "正文第二行",
  ]);
  assert.equal(cleaned.dropped, 4, "样板行 2 条 + 导航行 1 条 + 相邻重复 1 条");
});

test("normalizeInline: 折空白但保留显式换行", () => {
  assert.equal(normalizeInline("a   b\n\n\nc"), "a b\n\nc");
  assert.equal(normalizeInline("  中\u00a0文  "), "中 文");
});

test("extract: 正文由脚本渲染的页面要报「可疑」并只给标题+摘要（不假装省了 100%）", () => {
  // 形状取自 kubernetes.io 文档页：静态 HTML 里只有巨大的侧边导航，正文靠 JS 注入
  const result = extract(SHELL, { url: "https://kubernetes.io/docs/concepts/workloads/pods/" });
  assert.equal(result.suspicious, true, "正文不在静态 HTML 里时必须报可疑");
  assert.ok(result.notice.includes("脚本渲染"));
  assert.ok(result.stats.documentChars >= 600);
  assert.ok(result.stats.coverage < 0.1);
  assert.ok(result.markdown.startsWith("# Pods"), "至少要给出 h1");
  for (const noise of ["Concepts", "CronJobs", "Case Studies", "All rights reserved"]) {
    assert.ok(!result.markdown.includes(noise), `导航/页脚不该出现在结果里（${noise}）`);
  }
  assert.ok(result.markdown.length < 400, `壳页面结果必须很短，实际 ${result.markdown.length}`);

  // 更极端的壳页面（整页可见文本上万、全是导航）：连正文区都选不出来，
  // 这时给 h1 + meta description 摘要，并明确说「没找到正文区」。
  const huge = `<html><head><meta name="description" content="Pods are the smallest deployable units of computing that you can create and manage in Kubernetes."></head><body><nav class="td-sidebar-nav">${Array.from({ length: 120 }, (_, i) => `<a href="/docs/p${i}">Kubernetes Documentation Section ${i} with a fairly long label</a>`).join("")}</nav><main class="td-content"><h1>Pods</h1><p>Loading…</p></main></body></html>`;
  const hugeResult = extract(huge, { url: "https://kubernetes.io/docs/concepts/workloads/pods/" });
  assert.equal(hugeResult.region.reason, "none");
  assert.equal(hugeResult.suspicious, true);
  assert.ok(hugeResult.notice.includes("没找到正文区"));
  assert.ok(hugeResult.markdown.startsWith("# Pods"));
  assert.ok(hugeResult.markdown.includes("smallest deployable units"), "有 meta description 就给摘要");
  assert.ok(hugeResult.markdown.length < 400, `壳页面不该吐出上万字符的导航，实际 ${hugeResult.markdown.length}`);

  // 正常的文章页不能被误判
  assert.equal(extract(EN, { url: URL_EN }).suspicious, false);
  assert.equal(extract(ZH, { url: "https://blog.example.cn/a" }).suspicious, false);
  assert.equal(extract(WIKI, { url: "https://en.wikipedia.org/wiki/Layout_engine" }).suspicious, false);

  // 短页面（本来就没多少字）不算可疑：没有 1500 字符的文档量就不下判断
  const tiny = extract("<html><body><p>hello</p></body></html>", { url: "https://x/" });
  assert.equal(tiny.suspicious, false);

  // 天生就短的新闻页也不能被冤枉：整页 800 字符、正文 380 字符是**完整**的一条快讯
  const brief = `<html><body><div class="article">${"<p>一条完整的短新闻正文，只有一段话，但这就是全文。</p>".repeat(4)}</div><div class="hot">热门推荐 扫码关注 加载中 海量资讯 精准解读</div></body></html>`;
  const briefResult = extract(brief, { url: "https://finance.example.com/a" });
  assert.equal(briefResult.suspicious, false, "短快讯不该被判成脚本渲染");
  assert.ok(briefResult.markdown.includes("一条完整的短新闻正文"));
  assert.ok(!briefResult.markdown.includes("热门推荐") && !briefResult.markdown.includes("加载中"), "门户尾巴要清掉");
});

test("extract: 选中 nav/aside/footer 当正文也算可疑（这几乎一定是选错了）", () => {
  const body = Array.from({ length: 60 }, (_, i) => `<p>这是一段足够长的正文段落，用来把文档撑到阈值以上。第 ${i} 段。</p>`).join("");
  const html = `<html><body><div class="wrapper">${body}</div><aside><p>只有一行侧栏文字</p></aside></body></html>`;
  const result = extract(html, { url: "https://x/" });
  assert.equal(result.suspicious, false, "正文在 div 里时应当正常抽出来");
  const navOnly = `<html><body><nav>${Array.from({ length: 80 }, (_, i) => `<a href="/x${i}">导航项 ${i}，标题写得很长很长很长很长</a>`).join("")}</nav></body></html>`;
  const navResult = extract(navOnly, { url: "https://x/" });
  assert.equal(navResult.suspicious, true);
});
