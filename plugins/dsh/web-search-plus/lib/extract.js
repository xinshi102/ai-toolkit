/**
 * @local/dsh-web-search-plus — 正文抽取（Readability 精神的最小实现）。
 *
 * 与内置 `web_fetch` 的分工：内置工具用 turndown 把整页 HTML 转成 markdown，
 * 导航/侧栏/推荐位/评论区/页脚全都在，一次读下来很贵；这里多做两件事：
 *
 * 1. **选正文区**：先认 `<article>/<main>`，否则按「文本量 − 链接量 + 命名启发」
 *    给容器打分并向上传播（Readability 的经典做法），只渲染胜出的那块。
 * 2. **清模板噪音**：渲染时跳过广告/评论/相关阅读/侧栏/分页等容器，
 *    再按行丢掉纯导航行与常见样板句（Cookie、订阅、返回顶部…）。
 *
 * 保住的东西：标题、首段、`<pre>` 代码块（原样、带语言）、列表结构、
 * 表格网格、引用、粗体/斜体/行内代码、正文里的链接（绝对化后保留，可追溯来源）。
 */

import { attrOf, collapseSpaces, findAll, identityOf, isHidden, parseHtml, textOf, walk } from "./html.js";

/** 这些标签永远不渲染（无正文价值，或者内容已由别的分支处理）。 */
export const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object",
  "embed", "form", "button", "select", "option", "input", "textarea", "video",
  "audio", "map", "area", "dialog", "link", "meta", "base", "col", "colgroup",
  "source", "track", "param", "img", "picture",
]);

/** 命名命中这些词的容器直接丢（按 `-`/`_`/空格分词，避免 `content` 误伤）。
 *  故意**不**列 byline / author / meta：作者与日期常常是「为什么要抓这一页」的答案，
 *  它们只有一行，留着比丢掉划算。 */
export const NEGATIVE_PATTERN = /(^|[-_ ])(ad|ads|advert|advertisement|sponsor|sponsored|promo|banner|cookie|consent|gdpr|newsletter|subscribe|signup|share|sharing|social|disqus|comment|comments|related|recommend|recommended|recirc|morefrom|breadcrumb|pagination|pager|nav|navbar|menu|sidebar|toolbar|skip-link|widget|tags?)([-_ ]|$)/iu;

/** 命名命中这些词的容器加权（正文一般住在这些名字里）。 */
export const POSITIVE_PATTERN = /(^|[-_ ])(article|post|entry|content|main|body|story|text|markdown|prose|document|doc|wiki|paper)([-_ ]|$)/iu;

/** 候选区最少要有这么多字符，否则不参与打分（免得选中一个标题 div）。 */
export const MIN_CANDIDATE_CHARS = 120;

/** `<article>/<main>` 至少这么大才直接采信，否则仍走打分。 */
export const MIN_CONTAINER_CHARS = 400;

/** 行级样板（Cookie 提示、订阅、返回顶部、版权…）。只丢短行，长行不动。 */
const BOILERPLATE_LINE = [
  /^(cookies?|we use cookies|this (site|website) uses cookies|accept all( cookies)?|accept cookies|reject all|manage (preferences|cookies)|by (clicking|continuing)[, ])/iu,
  /^(subscribe|sign ?up|sign ?in|log ?in|join (now|free)|get the newsletter|newsletter)/iu,
  /^(share (this|on|via)|follow us|advertisement|sponsored( content)?|promoted|read more|learn more|see more|view all|back to top|skip to (main )?content)/iu,
  /^(all rights reserved|copyright|©|terms of (service|use)|privacy policy|cookie policy)/iu,
  /^(订阅|关注我们|扫码|扫一扫|点击(这里|查看|阅读)|返回顶部|上一篇|下一页|下一页|相关(阅读|文章|推荐)|热门(推荐|文章)|更多(精彩|内容)|阅读全文|分享到|广告|赞助|版权|免责声明|转载|微信)/u,
  // 门户/财经站的固定尾巴：整段都是模板，留着一句都不值钱
  /^(加载中|海量资讯|精准解读|VIP ?课程推荐|APP ?专享直播|热门推荐|新浪财经公众号|关注公众号|下载客户端|责任编辑|免责声明|本文来源|来源：|扫码下载)/u,
];

/**
 * 「参考资料」类小节的标题：这类小节在百科/文档页里几乎全是链接列表，
 * 对模型没有增量信息，却常常占掉整页一半 token。命中后丢到「同级或更高级标题」为止。
 */
export const SUPPRESS_SECTION = /^(references?|external links?|see also|further reading|bibliograph(y|ies)|sources?|citations?|footnotes?|notes and references|related (articles?|posts?|reading)|more (reading|information)|参考文献|参考资料|外部链接|参见|延伸阅读|注释|引用|相关条目|相关阅读|相关文章|更多阅读)/iu;

const BLOCK_LINE = /^(#{1,6} |[-*] |\d+\. |> |```|---$|\|)/u;

function nodeText(node) {
  return collapseSpaces(textOf(node));
}

function nodeTextLen(node) {
  return nodeText(node).length;
}

/** 链接文字量：判定「这块是不是导航」的主要依据。 */
function linkTextLen(node) {
  let total = 0;
  walk(node, (current) => {
    if (current.type !== "element") return true;
    if (current !== node && SKIP_TAGS.has(current.name)) return false;
    if (current.name === "a") {
      total += nodeTextLen(current);
      return false;
    }
    return true;
  });
  return total;
}

function linkDensity(node) {
  return linkTextLen(node) / Math.max(1, nodeTextLen(node));
}

function matchCount(value, pattern) {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return [...String(value).matchAll(global)].length;
}

/** 文档标题：`og:title` → `<title>` → 第一个 `<h1>`。 */
export function titleOf(root) {
  const meta = findAll(root, (node) => node.name === "meta");
  for (const tag of meta) {
    const property = (attrOf(tag, "property") ?? attrOf(tag, "name") ?? "").toLowerCase();
    if (property === "og:title" || property === "twitter:title") {
      const content = collapseSpaces(attrOf(tag, "content") ?? "");
      if (content !== "") return content;
    }
  }
  const title = findAll(root, (node) => node.name === "title")[0];
  if (title !== undefined) {
    const text = nodeText(title);
    if (text !== "") return text;
  }
  const heading = findAll(root, (node) => node.name === "h1")[0];
  return heading === undefined ? "" : nodeText(heading);
}

/**
 * 选正文区。返回 `{ node, reason, score }`。
 * 显式容器（`<article>/<main>`）优先；否则打分 + 向上传播。
 */
export function selectRegion(root) {
  const containers = findAll(root, (node) => node.name === "article" || node.name === "main")
    .filter((node) => !SKIP_TAGS.has(node.name) && nodeTextLen(node) >= MIN_CONTAINER_CHARS);
  if (containers.length > 0) {
    const best = containers.reduce((a, b) => (nodeTextLen(a) >= nodeTextLen(b) ? a : b));
    return { node: best, reason: best.name, score: nodeTextLen(best) };
  }

  const parents = new Map();
  const elements = [];
  walk(root, (node) => {
    if (node.type !== "element") return true;
    for (const child of node.children ?? []) if (child.type === "element") parents.set(child, node);
    if (!SKIP_TAGS.has(node.name) && !isHidden(node)) elements.push(node);
    return true;
  });

  const scores = new Map();
  for (const node of elements) {
    if (node.name === "body" || node.name === "html" || node.name === "#root") continue;
    // 正文不可能住在导航/侧栏/页脚里，也不可能是一堆链接：这些先出局，
    // 免得「整页只有侧边导航」的 JS 壳页面把导航当正文交出去（曾经把 kubernetes.io 判成 100% 省 token）。
    if (node.name === "nav" || node.name === "aside" || node.name === "footer" || node.name === "header") continue;
    if (NEGATIVE_PATTERN.test(identityOf(node))) continue;
    const textLen = nodeTextLen(node);
    if (textLen < MIN_CANDIDATE_CHARS) continue;
    if (linkDensity(node) >= 0.5) continue;
    const identity = identityOf(node);
    const paragraphs = findAll(node, (child) => child.name === "p" && nodeTextLen(child) >= 40).length;
    const score = textLen - linkTextLen(node) * 1.5 + matchCount(identity, POSITIVE_PATTERN) * 25
      - matchCount(identity, NEGATIVE_PATTERN) * 60 + paragraphs * 8;
    scores.set(node, score);
  }
  // 向上传播：父 1/2、祖父 1/3。传播绝不进 body/html/#root，否则整页总分最高。
  for (const [node, score] of [...scores]) {
    let current = parents.get(node);
    let share = score;
    for (let level = 0; level < 2 && current !== undefined; level += 1) {
      share = level === 0 ? score / 2 : score / 3;
      if (current.name === "body" || current.name === "html" || current.name === "#root") break;
      if (scores.has(current) || nodeTextLen(current) >= MIN_CANDIDATE_CHARS) {
        scores.set(current, (scores.get(current) ?? 0) + share);
      }
      current = parents.get(current);
    }
  }

  let best;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [node, score] of scores) {
    if (score > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  if (best === undefined) {
    const body = findAll(root, (node) => node.name === "body")[0] ?? root;
    // 整页本来就没多少字：直接用 body（短文页不该被判成"没有正文"）。
    // 整页很长却挑不出正文 → 交给 extract() 走「摘要 + 明确告知」的分支。
    if (nodeTextLen(body) < MIN_DOCUMENT_CHARS) return { node: body, reason: "fallback", score: nodeTextLen(body) };
    return { node: body, reason: "none", score: 0 };
  }
  // 正文常常是「标题 + 段落」同级放在一个容器里：胜出者太小、父容器又不导航时，取父容器。
  const parent = parents.get(best);
  if (parent !== undefined && parent.name !== "body" && parent.name !== "html") {
    const bestLen = nodeTextLen(best);
    const parentLen = nodeTextLen(parent);
    if (parentLen <= bestLen * 1.6 && linkDensity(parent) < 0.35) {
      return { node: parent, reason: "scored-parent", score: bestScore };
    }
  }
  return { node: best, reason: "scored", score: bestScore };
}

function resolveHref(href, baseUrl) {
  const raw = collapseSpaces(href ?? "");
  if (raw === "" || raw.startsWith("#")) return "";
  if (/^(javascript|data|vbscript):/iu.test(raw)) return "";
  if (/^https?:\/\//iu.test(raw)) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  if (typeof baseUrl === "string" && /^https?:\/\//iu.test(baseUrl)) {
    try {
      return new URL(raw, baseUrl).toString();
    } catch {
      return "";
    }
  }
  return "";
}

function shouldSkip(node, options) {
  if (SKIP_TAGS.has(node.name)) return true;
  if (isHidden(node)) return true;
  if (node.name === "nav" || node.name === "aside" || node.name === "header" || node.name === "footer") {
    // 文章自己的 header/footer 里可能有标题、作者、时间：文本够多且不是链接堆时才留。
    return linkDensity(node) > 0.5 || nodeTextLen(node) < 40;
  }
  if (NEGATIVE_PATTERN.test(identityOf(node))) return true;
  // 链接堆成的表格（信息框、导航表）：文本基本都在链接里，留着只是替站点付导航钱。
  if (node.name === "table" && linkDensity(node) > 0.5 && nodeTextLen(node) < 5000) return true;
  return false;
}

/** 整块都是「短链接条目」的列表（≥6 条且每条就是一个链接）：参考资料/目录/标签云。 */
function isLinkList(node) {
  if (node.name !== "ul" && node.name !== "ol") return false;
  const items = (node.children ?? []).filter((child) => child.type === "element" && child.name === "li");
  if (items.length < 6) return false;
  return items.every((item) => {
    const text = nodeTextLen(item);
    if (text === 0 || text > 80) return false;
    const links = findAll(item, (child) => child.name === "a");
    return links.length === 1 && Math.abs(nodeTextLen(links[0]) - text) <= 2;
  });
}

function isBlockTag(name) {
  return /^(address|article|aside|blockquote|dd|details|div|dl|dt|fieldset|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)$/u.test(name);
}

function textOfIncludingHidden(node) {
  let out = "";
  walk(node, (current) => {
    if (current.type === "text") {
      out += current.text;
      return true;
    }
    return current.type === "element";
  });
  return out;
}

function fenceFor(code) {
  return code.includes("```") ? "````" : "```";
}

function codeBlock(node) {
  const raw = textOfIncludingHidden(node).replace(/\r\n?/gu, "\n").replace(/^\n+/u, "").replace(/\s+$/u, "");
  // 语言类名通常挂在内层 <code class="language-json">，也可能挂在 <pre> 上，两边都看
  const inner = findAll(node, (child) => child.name === "code")[0];
  const identity = [attrOf(node, "class"), inner === undefined ? "" : attrOf(inner, "class")]
    .filter((value) => typeof value === "string" && value !== "").join(" ").toLowerCase();
  const language = /(?:language|lang|brush|highlight)[-:]([a-z0-9+#]+)/u.exec(identity)?.[1] ?? "";
  const fence = fenceFor(raw);
  return `${fence}${language}\n${raw}\n${fence}`;
}

function inlineOf(node, options, state = { skipNestedLists: false }) {
  if (node.type === "text") return collapseSpaces(node.text);
  if (node.type !== "element") return "";
  if (shouldSkip(node, options) && node.name !== "code") return "";
  switch (node.name) {
    case "br":
      return "\n";
    case "code": {
      const raw = textOfIncludingHidden(node).replace(/\s+/gu, " ").trim();
      if (raw === "") return "";
      const fence = raw.includes("`") ? "``" : "`";
      return `${fence}${raw}${fence}`;
    }
    case "strong":
    case "b": {
      const inner = inlineChildren(node, options, state).trim();
      return inner === "" ? "" : `**${inner}**`;
    }
    case "em":
    case "i": {
      const inner = inlineChildren(node, options, state).trim();
      return inner === "" ? "" : `*${inner}*`;
    }
    case "del":
    case "s":
    case "strike": {
      const inner = inlineChildren(node, options, state).trim();
      return inner === "" ? "" : `~~${inner}~~`;
    }
    case "a": {
      const inner = inlineChildren(node, options, state).trim();
      const href = resolveHref(attrOf(node, "href"), options.baseUrl);
      if (inner === "") return "";
      // 页内锚点的脚注标记（`[1]` → `#cite_note-1`）：对模型没有信息量，纯噪音
      if (href === "" && /^\[\d{1,3}\]$/u.test(inner)) return "";
      if (href === "" || href === inner) return inner;
      return `[${inner}](${href})`;
    }
    case "ul":
    case "ol":
      return state.skipNestedLists ? "" : inlineChildren(node, options, state);
    default:
      return inlineChildren(node, options, state);
  }
}

function inlineChildren(node, options, state) {
  let out = "";
  for (const child of node.children ?? []) out += inlineOf(child, options, state);
  return normalizeInline(out);
}

/** 行内归一化：折叠空白，但保留显式换行与中标点之间的空隙。 */
export function normalizeInline(text) {
  return String(text ?? "")
    .replace(/[ \t\f\v\u00a0]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function renderTable(node, options, lines) {
  const rows = [];
  for (const row of findAll(node, (child) => child.name === "tr")) {
    const cells = (row.children ?? []).filter((child) => child.type === "element" && (child.name === "td" || child.name === "th"));
    if (cells.length === 0) continue;
    rows.push({
      header: cells.some((cell) => cell.name === "th"),
      cells: cells.map((cell) => normalizeInline(inlineChildren(cell, options, { skipNestedLists: true })).replace(/\|/gu, "\\|").replace(/\n+/gu, " ")),
    });
  }
  if (rows.length === 0) return;
  const width = Math.max(...rows.map((row) => row.cells.length));
  const pad = (row) => {
    const cells = [...row.cells];
    while (cells.length < width) cells.push("");
    return `| ${cells.join(" | ")} |`;
  };
  lines.push(pad(rows[0]));
  lines.push(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  for (const row of rows.slice(1)) lines.push(pad(row));
}

function renderList(node, options, lines, depth, ordered) {
  let index = 1;
  for (const item of (node.children ?? []).filter((child) => child.type === "element" && child.name === "li")) {
    if (shouldSkip(item, options)) continue;
    const marker = ordered ? `${index}. ` : "- ";
    const head = normalizeInline(inlineChildren(item, options, { skipNestedLists: true }));
    if (head !== "") lines.push(`${"  ".repeat(depth)}${marker}${head}`);
    for (const nested of (item.children ?? []).filter((child) => child.type === "element" && (child.name === "ul" || child.name === "ol"))) {
      if (shouldSkip(nested, options)) continue;
      renderList(nested, options, lines, depth + 1, nested.name === "ol");
    }
    index += 1;
  }
}

function renderBlock(node, options, lines, depth, state) {
  const name = node.name;
  if (/^h[1-6]$/u.test(name)) {
    const level = Number(name.slice(1));
    const text = normalizeInline(inlineChildren(node, options, { skipNestedLists: true }));
    if (text !== "") lines.push(`${"#".repeat(level)} ${text}`);
    return;
  }
  if (name === "pre") {
    lines.push(codeBlock(node));
    return;
  }
  if (name === "hr") {
    lines.push("---");
    return;
  }
  if (name === "blockquote") {
    const inner = [];
    renderChildren(node, options, inner, depth, state);
    const quoted = inner.join("\n\n").split("\n").map((line) => (line === "" ? ">" : `> ${line}`));
    if (quoted.length > 0) lines.push(quoted.join("\n"));
    return;
  }
  if (name === "ul" || name === "ol") {
    renderList(node, options, lines, depth, name === "ol");
    return;
  }
  if (name === "table") {
    renderTable(node, options, lines);
    return;
  }
  if (name === "dl") {
    for (const child of node.children ?? []) {
      if (child.type !== "element" || shouldSkip(child, options)) continue;
      const text = normalizeInline(inlineChildren(child, options, { skipNestedLists: true }));
      if (text === "") continue;
      lines.push(child.name === "dt" ? `**${text}**` : text);
    }
    return;
  }
  // p / div / section / figure / details … 一律当容器处理：子块照渲染，散落文本成段。
  renderChildren(node, options, lines, depth, state);
}

function renderChildren(node, options, lines, depth, state) {
  let buffer = "";
  let lastWasLink = false;
  const flush = () => {
    const text = normalizeInline(buffer);
    if (text !== "") lines.push(text);
    buffer = "";
  };
  for (const child of node.children ?? []) {
    if (child.type === "text") {
      if (state.suppressed === 0) {
        buffer += child.text;
        if (/\S/u.test(child.text)) lastWasLink = false;
      }
      continue;
    }
    if (child.type !== "element") continue;
    if (shouldSkip(child, options)) continue;
    const heading = /^h([1-6])$/u.exec(child.name);
    if (heading !== null) {
      // 抑制状态挂在共享 state 上：维基百科把标题包在 <div class="mw-heading"> 里，
      // 若状态只属于当前这一层 children 循环，「References」后面那一大串引用根本丢不掉。
      const level = Number(heading[1]);
      const text = normalizeInline(inlineChildren(child, options, { skipNestedLists: true }));
      if (SUPPRESS_SECTION.test(text)) {
        flush();
        state.suppressed = level;
        continue;
      }
      if (state.suppressed > 0 && level <= state.suppressed) state.suppressed = 0;
      if (state.suppressed > 0) continue;
    } else if (state.suppressed > 0) {
      continue;
    }
    if (isLinkList(child)) continue;
    if (isBlockTag(child.name)) {
      flush();
      renderBlock(child, options, lines, depth, state);
      lastWasLink = false;
    } else {
      // 紧挨着的两个 <a>（中间没有任何文字）是「链接堆」：逐个断行，
      // 后面的 cleanLines 会把这种「一行一个短链接」当导航丢掉。
      if (child.name === "a" && lastWasLink) flush();
      buffer += inlineOf(child, options);
      lastWasLink = child.name === "a";
    }
  }
  flush();
}

/**
 * 行级清理：折空白、丢样板行与纯导航行、去相邻重复、压空行。
 * 代码块内（围栏之间）不做任何清理——那里一个空格都不能动。
 */
export function cleanLines(lines) {
  const out = [];
  let inFence = false;
  let dropped = 0;
  for (const raw of lines) {
    if (raw === "") continue;
    const text = String(raw).replace(/\r/gu, "");
    if (/^\s*(```|````|~~~)/u.test(text)) {
      inFence = !inFence;
      out.push(text);
      continue;
    }
    if (inFence) {
      out.push(text);
      continue;
    }
    const line = text.replace(/[ \t\u00a0]+/gu, " ").trimEnd();
    if (line.trim() === "") continue;
    const visible = line.trim();
    if (visible.length <= 1 && !BLOCK_LINE.test(visible)) {
      dropped += 1;
      continue;
    }
    const short = visible.length <= 160;
    if (short && BOILERPLATE_LINE.some((pattern) => pattern.test(visible))) {
      dropped += 1;
      continue;
    }
    // 纯导航行：整行只有一个短链接（`- [首页](https://…)` 这类）
    if (short && /^([-*>]\s*)?\[\s*[^\]]{1,60}\s*\]\(\s*https?:\/\/[^)]+\)\s*$/u.test(visible)) {
      dropped += 1;
      continue;
    }
    if (out.length > 0 && out[out.length - 1] === line && !BLOCK_LINE.test(line)) {
      dropped += 1;
      continue;
    }
    out.push(line);
  }
  // 压空行：最多一个连续空行（渲染层用 "\n" 拼行，这里保持行数组语义）
  return { lines: out, dropped };
}

/** 抽取结果相对整页小到什么程度就值得怀疑（正文可能由脚本渲染）。 */
export const SUSPICIOUS_COVERAGE = 0.1;
/** 整页可见文本超过这么多字符，抽取覆盖率却低得离谱，就说明正文不在静态 HTML 里。 */
export const SUSPICIOUS_DOCUMENT_CHARS = 600;
/** 整页可见文本少于这么多字符时，不再纠结选正文（短文页直接用 body）。 */
export const MIN_DOCUMENT_CHARS = 1200;

/**
 * 挑不出正文时的最小交代：`<h1>` 与 `meta[name=description|og:description]`。
 * 对 JS 渲染的文档站，这两样是静态 HTML 里唯一还值得给模型的东西。
 */
export function fallbackSummary(root) {
  const lines = [];
  const heading = findAll(root, (node) => node.name === "h1")[0];
  if (heading !== undefined) {
    const text = normalizeInline(textOf(heading));
    if (text !== "") lines.push(`# ${text}`);
  }
  for (const tag of findAll(root, (node) => node.name === "meta")) {
    const name = (attrOf(tag, "name") ?? attrOf(tag, "property") ?? "").toLowerCase();
    if (name !== "description" && name !== "og:description") continue;
    const content = collapseSpaces(attrOf(tag, "content") ?? "");
    if (content !== "") {
      lines.push(content);
      break;
    }
  }
  return lines.join("\n\n");
}

/**
 * 抽取正文。
 *
 * @param html - 页面 HTML。
 * @param options - `{ url, maxInputChars }`。
 * @returns `{ title, markdown, region, suspicious, notice, stats }`。
 *   `suspicious` 表示「抽出来的东西小得可疑」——典型是正文由 JS 渲染、
 *   静态 HTML 里只剩导航（比如 kubernetes.io 的文档页）。这时必须明确告诉模型，
 *   不能假装拿到了正文、更不能把它算成一次干净的省 token 胜利。
 */
export function extract(html, options = {}) {
  const source = String(html ?? "");
  const root = parseHtml(source, { maxChars: options.maxInputChars });
  const parsedChars = Math.min(source.length, Number.isInteger(options.maxInputChars) && options.maxInputChars > 0 ? options.maxInputChars : source.length);
  const region = selectRegion(root);
  const renderOptions = { baseUrl: options.url };
  const rawLines = [];
  if (region.reason !== "none") renderChildren(region.node, renderOptions, rawLines, 0, { suppressed: 0 });
  const cleaned = cleanLines(rawLines);
  const rendered = cleaned.lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  const noContent = region.reason === "none";
  const markdown = noContent ? fallbackSummary(root) : rendered;
  const documentChars = nodeTextLen(root);
  const coverage = documentChars === 0 ? 1 : markdown.length / documentChars;
  // 只按覆盖率判：短新闻页（整页也就几百字符、正文 380）是**正常**的，
  // 用绝对长度当判据会把它冤枉成「脚本渲染」（新浪那条中美对话就被误判过）。
  const suspicious = noContent || (documentChars >= SUSPICIOUS_DOCUMENT_CHARS && coverage < SUSPICIOUS_COVERAGE);
  const notice = noContent
    ? `这一页没找到正文区（整页可见文本 ${documentChars} 字符，几乎全是导航/模板）：正文很可能由脚本渲染，静态 HTML 里没有。下面只有标题与摘要；需要原文请用 web_fetch 看原始响应。`
    : (suspicious
      ? `抽取到的正文只有 ${markdown.length} 字符（整页可见文本 ${documentChars} 字符）——这一页的正文可能由脚本渲染，静态 HTML 里没有；需要原文请用 web_fetch 看原始响应。`
      : "");
  return {
    title: titleOf(root),
    markdown,
    region: { tag: region.node.name, reason: region.reason, score: Math.round(region.score) || 0 },
    suspicious,
    notice,
    stats: {
      sourceChars: parsedChars,
      documentChars,
      contentChars: markdown.length,
      coverage: Math.round(coverage * 1000) / 1000,
      headings: findAll(region.node, (node) => /^h[1-6]$/u.test(node.name)).length,
      paragraphs: findAll(region.node, (node) => node.name === "p").length,
      listItems: findAll(region.node, (node) => node.name === "li").length,
      codeBlocks: findAll(region.node, (node) => node.name === "pre").length,
      tables: findAll(region.node, (node) => node.name === "table").length,
      droppedLines: cleaned.dropped,
      noContent,
    },
  };
}
